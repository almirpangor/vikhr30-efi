/*
 * Host simulator for the Vikhr-30 ECU firmware (v0.8 unmodified and v0.9).
 *
 * The firmware translation unit is compiled for the host with clang's
 *   -fsanitize-coverage=trace-pc-guard,trace-loads,trace-stores
 * so every memory load/store of the firmware calls one of the hooks at the
 * bottom of this file BEFORE the access happens.  Each hook
 *   1. finishes the previous register write (side effects),
 *   2. advances virtual time by SIM_COST_NS (default 100 ns per access),
 *   3. lets the peripheral models catch up (TIM2 16-bit counter with compare
 *      and update flags, SysTick, USART shift registers at the programmed
 *      baud rate, ADC, Flash, IWDG, crank wheel 36-1 -> EXTI5),
 *   4. delivers pending interrupts by calling the firmware's handlers,
 *      honouring PRIMASK and the NVIC priorities the firmware programmed.
 * So interrupts can preempt the main loop (and each other) between any two
 * memory accesses, and busy-wait loops on hardware flags take real time.
 *
 * This file is NOT instrumented.
 */
#define _GNU_SOURCE
#include <math.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

#include "stm32f103xb_min.h"
#include "sim.h"

/* ------------------------------------------------------------------ registers */
AFIO_TypeDef sim_AFIO;
EXTI_TypeDef sim_EXTI;
GPIO_TypeDef sim_GPIOA, sim_GPIOB, sim_GPIOC;
ADC_TypeDef sim_ADC1;
USART_TypeDef sim_USART1, sim_USART2;
TIM_TypeDef sim_TIM2;
IWDG_TypeDef sim_IWDG;
RCC_TypeDef sim_RCC;
FLASH_TypeDef sim_FLASH;
volatile uint32_t sim_SYST_CSR, sim_SYST_RVR, sim_SYST_CVR;
volatile uint32_t sim_NVIC_ISER0, sim_NVIC_ISER1, sim_NVIC_ICER0, sim_NVIC_ICER1;
volatile uint8_t sim_NVIC_IPR[64];
volatile uint8_t sim_SCB_SHPR[12];
volatile uint32_t sim_primask;

#define FLASH_PAGE_ADDR 0x08007C00UL
#define FLASH_MAP_ADDR  0x08007000UL
#define MS 1000000ULL
#define US 1000ULL

/* ------------------------------------------------------------------ globals */
static uint64_t now_ns;
static uint64_t cost_ns = 100;
static uint64_t end_ns = 1000 * MS;
static jmp_buf end_jmp;
static int sim_busy = 1;
static const FwView *fw;
static int is_new_fw;

static void die(const char *msg) { fprintf(stderr, "SIM ERROR: %s\n", msg); exit(3); }

/* ------------------------------------------------------------------ scenario events */
typedef struct { uint64_t t; void (*fn)(long); long arg; } SimEvent;
static SimEvent ev_list[4096];
static int ev_count, ev_next;
static void sim_at(uint64_t t, void (*fn)(long), long arg) {
  if (ev_count >= 4096) die("too many events");
  int i = ev_count++;
  while (i > 0 && ev_list[i - 1].t > t) { ev_list[i] = ev_list[i - 1]; --i; }
  ev_list[i].t = t; ev_list[i].fn = fn; ev_list[i].arg = arg;
}

/* ------------------------------------------------------------------ clocks */
static double core_hz(void) {
  uint32_t cfgr = sim_RCC.CFGR;
  if (((cfgr >> 2) & 3U) == 2U) return 4e6 * (((cfgr >> 18) & 15U) + 2U);
  return 8e6;
}
static double apb1_hz(void) {
  uint32_t ppre = (sim_RCC.CFGR >> 8) & 7U;
  return core_hz() / (ppre < 4 ? 1 : (2 << (ppre - 4)));
}

/* ------------------------------------------------------------------ GPIO */
static uint32_t odr_a, odr_b, odr_c;
static uint32_t in_a, in_b = (1U << 12) | (1U << 13), in_c = 1U << 13;
#define OUT_MASK_A 0x0100U
#define OUT_MASK_B 0x8FC3U
static uint32_t prev_b, prev_a;
static void on_output_b(int pin, int level);
static uint64_t iac_phase_changes, pump_rise_ns, heater_high_ns, heater_last_ns;
static double pump_last_ms;
static int heater_level;

static void outputs_changed(void) {
  uint32_t b = odr_b & OUT_MASK_B, changed = b ^ prev_b;
  prev_b = b;
  if (changed) {
    for (int pin = 0; pin < 16; ++pin) if (changed & (1U << pin)) on_output_b(pin, (b >> pin) & 1);
  }
  prev_a = odr_a & OUT_MASK_A;
}

/* ------------------------------------------------------------------ TIM2 */
static struct { int running; uint64_t next, tick; uint32_t cnt, sr; uint64_t total; } tim;
static uint64_t tim_overflows;
/* 0xFFFF = real STM32F103.  SIM_TIM32=1 selects an imaginary 32-bit TIM2: a
   control experiment showing which v0.8 failures come from the counter width. */
static uint32_t tim_mask = 0xFFFFU;

/* ------------------------------------------------------------------ SysTick */
static struct { int running, pend; uint64_t next, period; } st;

/* ------------------------------------------------------------------ EXTI */
static uint32_t exti_pr;

/* ------------------------------------------------------------------ NVIC */
static uint32_t nvic_en[2];
static int cur_prio = 256;
static uint64_t irq_count[5];

/* ------------------------------------------------------------------ USART */
#define PC_BYTE_NS 86806ULL /* 10 bits at exactly 115200 baud */
typedef struct {
  USART_TypeDef *hw; int index;
  uint32_t sr; uint8_t rdr, tdr, shift_byte; int tdr_full, shifting; uint64_t shift_done;
  char *rxq; size_t rx_len, rx_pos, rx_cap; uint64_t rx_next;
  char *out; size_t out_len, out_cap;
  uint64_t rx_overrun, tx_lost, rx_dropped_disabled;
} Uart;
static Uart uart[2];

static uint64_t uart_byte_ns(Uart *u) {
  double pclk = u->index == 0 ? core_hz() : apb1_hz();
  uint32_t brr = u->hw->BRR;
  if (!brr) die("USART BRR is zero");
  return (uint64_t)(10.0 * 1e9 * brr / pclk + 0.5);
}
static void uart_emit(Uart *u, uint8_t b) {
  if (u->out_len + 1 >= u->out_cap) { u->out_cap = u->out_cap ? u->out_cap * 2 : 65536; u->out = realloc(u->out, u->out_cap); }
  u->out[u->out_len++] = (char)b; u->out[u->out_len] = 0;
}
static void uart_start_shift(Uart *u, uint64_t t0) {
  u->shift_byte = u->tdr; u->tdr_full = 0; u->sr |= USART_SR_TXE;
  u->shifting = 1; u->shift_done = t0 + uart_byte_ns(u);
}
static void uart_write_dr(Uart *u, uint8_t value) {
  if (!(u->hw->CR1 & USART_CR1_UE) || !(u->hw->CR1 & USART_CR1_TE)) return;
  if (!(u->sr & USART_SR_TXE)) { u->tx_lost++; return; }
  u->tdr = value; u->tdr_full = 1; u->sr &= ~USART_SR_TXE;
  if (!u->shifting) uart_start_shift(u, now_ns);
}
static void uart_progress(Uart *u) {
  while (u->shifting && now_ns >= u->shift_done) {
    uart_emit(u, u->shift_byte); u->shifting = 0;
    if (u->tdr_full) uart_start_shift(u, u->shift_done);
  }
  while (u->rx_pos < u->rx_len && now_ns >= u->rx_next) {
    uint8_t b = (uint8_t)u->rxq[u->rx_pos++];
    u->rx_next += PC_BYTE_NS;
    if (!(u->hw->CR1 & USART_CR1_UE) || !(u->hw->CR1 & USART_CR1_RE)) { u->rx_dropped_disabled++; continue; }
    if (u->sr & USART_SR_RXNE) { u->sr |= USART_SR_ORE; u->rx_overrun++; }
    else { u->rdr = b; u->sr |= USART_SR_RXNE; }
  }
}
/* The "PC" sends a string, bytes back to back at 115200 baud. */
static void pc_send(int port, const char *text) {
  Uart *u = &uart[port]; size_t n = strlen(text);
  if (u->rx_len + n + 1 > u->rx_cap) { u->rx_cap = (u->rx_len + n + 1) * 2; u->rxq = realloc(u->rxq, u->rx_cap); }
  if (u->rx_pos == u->rx_len) u->rx_next = now_ns + PC_BYTE_NS;
  memcpy(u->rxq + u->rx_len, text, n); u->rx_len += n;
}

/* ------------------------------------------------------------------ ADC */
static struct { int busy; uint64_t done; uint32_t sr; } adc;
static uint16_t adc_val[16] = { [0] = 1500, [1] = 2050, [4] = 1383, [5] = 2052, [6] = 3004, [7] = 558 };

/* ------------------------------------------------------------------ Flash */
static struct { int locked, key_step; uint32_t sr; uint64_t busy_until; uint16_t old; uint64_t words, illegal, erases; } fl = { 1, 0, 0, 0, 0, 0, 0, 0 };

/* ------------------------------------------------------------------ IWDG */
static struct { int started, unlocked, sr_pending; uint64_t sr_done, last_feed, max_gap, feeds, resets; uint32_t pr, rlr; int never_synced; } wd = { .rlr = 0xFFF };

/* ------------------------------------------------------------------ crank wheel */
typedef struct { uint64_t t; double rpm; } RpmPoint;
static RpmPoint rpm_pts[32]; static int rpm_npts;
static double theta;      /* crank angle, degrees, cumulative */
static long tooth_k = 7;  /* next tooth; edge when theta >= tooth_k * 10; k % 36 == 35 is the missing tooth */
static long drop_teeth[16]; static int n_drop;
static uint64_t teeth_sent;
/* Check of the firmware's tooth time stamp against the true timer value. */
static struct { int pending; uint64_t truth; uint32_t before; long checked, bad; double max_lag; } ts;
static uint64_t jitter_state;

static double rpm_at(uint64_t t) {
  if (!rpm_npts || t < rpm_pts[0].t) return 0;
  for (int i = rpm_npts - 1; i >= 0; --i) if (t >= rpm_pts[i].t) {
    if (i == rpm_npts - 1 || rpm_pts[i + 1].t == rpm_pts[i].t) return rpm_pts[i].rpm;
    double f = (double)(t - rpm_pts[i].t) / (double)(rpm_pts[i + 1].t - rpm_pts[i].t);
    return rpm_pts[i].rpm + f * (rpm_pts[i + 1].rpm - rpm_pts[i].rpm);
  }
  return 0;
}
static void rpm_point(uint64_t t, double rpm) { rpm_pts[rpm_npts].t = t; rpm_pts[rpm_npts++].rpm = rpm; }

/* ------------------------------------------------------------------ measurements */
typedef struct {
  uint64_t from, to;
  long sparks, missed_sparks, extra_sparks, bad_angle_sparks;
  double max_angle_err, sum_angle_err, max_dwell_err;
  long injections, missed_inj; double max_inj_err;
  long unsynced_teeth, teeth; double max_rpm_err;
} Window;
static Window win[2]; static int n_win;

static const double TDC[2] = { 170.0, 350.0 };
static struct { int on; uint64_t t_on; double max_on_us; long count; int sparks_since_tdc; long next_tdc_n; int snap_adv, snap_dwell; int dwell_cmd; } coil[2];
static struct { int on; uint64_t t_on; double max_on_us; long count; int rises_since_ref; int expect, snap_fuel; double last_us; } inj;
static struct { uint64_t t; uint64_t detect; long output_after; int active; } stop;
static long ref_teeth_seen;
static double test_pulse_us[3]; /* last pulse width PB0, PB1, PB10 */

static int in_window(const Window *w) { return now_ns >= w->from && now_ns < w->to; }

static void on_output_b(int pin, int level) {
  if (pin == 0 || pin == 1) {
    int c = pin;
    if (level) { coil[c].on = 1; coil[c].t_on = now_ns; coil[c].dwell_cmd = coil[c].snap_dwell; }
    else if (coil[c].on) {
      double dwell = (now_ns - coil[c].t_on) / 1000.0;
      coil[c].on = 0; coil[c].count++; coil[c].sparks_since_tdc++;
      test_pulse_us[c] = dwell;
      if (dwell > coil[c].max_on_us) coil[c].max_on_us = dwell;
      double adv = fmod(TDC[c] - fmod(theta, 360.0) + 720.0, 360.0);
      if (adv > 180.0) adv -= 360.0;
      double err = adv - coil[c].snap_adv / 10.0;
      double derr = fabs(dwell - coil[c].dwell_cmd);
      for (int i = 0; i < n_win; ++i) if (in_window(&win[i])) {
        win[i].sparks++; win[i].sum_angle_err += err;
        if (fabs(err) > win[i].max_angle_err) win[i].max_angle_err = fabs(err);
        if (fabs(err) > 2.0) win[i].bad_angle_sparks++;
        if (derr > win[i].max_dwell_err) win[i].max_dwell_err = derr;
      }
    }
    if (level && stop.detect) stop.output_after++;
  } else if (pin == 10) {
    if (level) { inj.on = 1; inj.t_on = now_ns; inj.rises_since_ref++; inj.expect = inj.snap_fuel; if (stop.detect) stop.output_after++; }
    else if (inj.on) {
      double us = (now_ns - inj.t_on) / 1000.0;
      inj.on = 0; inj.count++; inj.last_us = us; test_pulse_us[2] = us;
      if (us > inj.max_on_us) inj.max_on_us = us;
      for (int i = 0; i < n_win; ++i) if (in_window(&win[i])) {
        win[i].injections++;
        if (fabs(us - inj.expect) > win[i].max_inj_err) win[i].max_inj_err = fabs(us - inj.expect);
      }
    }
  } else if (pin == 11) {
    if (level) pump_rise_ns = now_ns; else pump_last_ms = (now_ns - pump_rise_ns) / 1e6;
  } else if (pin == 15) {
    if (heater_level) heater_high_ns += now_ns - heater_last_ns;
    heater_level = level; heater_last_ns = now_ns;
  } else if (pin >= 6 && pin <= 9) iac_phase_changes++;
}

static void exti_edge(void) {
  if (!(sim_EXTI.RTSR & (1U << 5))) return;
  exti_pr |= 1U << 5;
  ts.pending = 1; ts.truth = tim.total; ts.before = *fw->last_crank_edge_us;
}

static void tooth_edge(long k) {
  int idx = (int)(k % 36);
  teeth_sent++;
  for (int i = 0; i < n_win; ++i) if (in_window(&win[i])) {
    win[i].teeth++;
    if (!*fw->crank_synced) win[i].unsynced_teeth++;
    double err = fabs((double)*fw->engine_rpm - rpm_at(now_ns));
    if (err > win[i].max_rpm_err) win[i].max_rpm_err = err;
  }
  if (idx == 0 || idx == 18) {
    int c = idx == 0 ? 0 : 1;
    /* what the firmware is about to use for this cylinder */
    coil[c].snap_adv = *fw->prepared_advance_tenths;
    coil[c].snap_dwell = *fw->prepared_dwell_us;
    if (ref_teeth_seen++ > 0 && inj.rises_since_ref == 0)
      for (int i = 0; i < n_win; ++i) if (in_window(&win[i])) win[i].missed_inj++;
    inj.rises_since_ref = 0;
    inj.snap_fuel = *fw->prepared_fuel_us;
  }
  exti_edge();
}

static void crank_progress(uint64_t dt) {
  double rpm = rpm_at(now_ns);
  if (rpm <= 0) return;
  theta += rpm * 6e-9 * (double)dt;
  while (theta >= tooth_k * 10.0) {
    long k = tooth_k++;
    int dropped = (k % 36) == 35;
    for (int i = 0; i < n_drop; ++i) if (drop_teeth[i] == k) dropped = 1;
    if (!dropped) tooth_edge(k);
  }
  for (int c = 0; c < 2; ++c) {
    double tdc = TDC[c] + 360.0 * coil[c].next_tdc_n;
    if (theta >= tdc) {
      coil[c].next_tdc_n++;
      for (int i = 0; i < n_win; ++i) if (in_window(&win[i])) {
        if (coil[c].sparks_since_tdc == 0) win[i].missed_sparks++;
        else if (coil[c].sparks_since_tdc > 1) win[i].extra_sparks += coil[c].sparks_since_tdc - 1;
      }
      coil[c].sparks_since_tdc = 0;
    }
  }
}

/* ------------------------------------------------------------------ time */
static void sync_regs(void) {
  sim_TIM2.CNT = tim.cnt; sim_TIM2.SR = tim.sr;
  sim_EXTI.PR = exti_pr;
  sim_USART1.SR = uart[0].sr; sim_USART2.SR = uart[1].sr;
  sim_GPIOA.ODR = odr_a; sim_GPIOB.ODR = odr_b; sim_GPIOC.ODR = odr_c;
  sim_GPIOA.IDR = (odr_a & OUT_MASK_A) | (in_a & ~OUT_MASK_A);
  sim_GPIOB.IDR = (odr_b & OUT_MASK_B) | (in_b & ~OUT_MASK_B);
  sim_GPIOC.IDR = in_c;
  sim_ADC1.SR = adc.sr;
  sim_FLASH.SR = fl.sr | (now_ns < fl.busy_until ? FLASH_SR_BSY : 0);
  sim_IWDG.SR = wd.sr_pending ? 3U : 0U;
}

static void advance(uint64_t dt) {
  now_ns += dt;
  while (tim.running && tim.next <= now_ns) {
    tim.next += tim.tick; tim.total++;
    if (tim.cnt >= (sim_TIM2.ARR & tim_mask)) { tim.cnt = 0; tim.sr |= TIM_SR_UIF; tim_overflows++; }
    else tim.cnt++;
    if (tim.cnt == (sim_TIM2.CCR1 & tim_mask)) tim.sr |= TIM_SR_CC1IF;
  }
  while (st.running && st.next <= now_ns) { st.next += st.period; if (sim_SYST_CSR & 2U) st.pend = 1; }
  crank_progress(dt);
  uart_progress(&uart[0]); uart_progress(&uart[1]);
  if (adc.busy && now_ns >= adc.done) { adc.busy = 0; adc.sr |= 2U; sim_ADC1.DR = adc_val[sim_ADC1.SQR3 & 15U]; }
  if (wd.started) {
    if (wd.sr_pending && now_ns >= wd.sr_done) wd.sr_pending = 0;
    uint64_t timeout = (uint64_t)(wd.rlr + 1U) * (4ULL << wd.pr) * 25000ULL; /* LSI 40 kHz */
    if (now_ns - wd.last_feed > timeout) { wd.resets++; wd.last_feed = now_ns; }
  }
  if (inj.on && (now_ns - inj.t_on) / 1000.0 > inj.max_on_us) inj.max_on_us = (now_ns - inj.t_on) / 1000.0;
  for (int c = 0; c < 2; ++c)
    if (coil[c].on && (now_ns - coil[c].t_on) / 1000.0 > coil[c].max_on_us) coil[c].max_on_us = (now_ns - coil[c].t_on) / 1000.0;
  if (stop.active && !stop.detect && now_ns >= stop.t && *fw->engine_rpm == 0 && *fw->crank_synced == 0) {
    stop.detect = now_ns;
    if (coil[0].on || coil[1].on || inj.on) stop.output_after += 100;
  }
  while (ev_next < ev_count && ev_list[ev_next].t <= now_ns) { SimEvent *e = &ev_list[ev_next++]; e->fn(e->arg); }
  if (now_ns >= end_ns) longjmp(end_jmp, 1);
}

/* ------------------------------------------------------------------ register write side effects */
static struct { void *addr; int kind; } pend; /* kind 1: store, 2: USART DR was read */

#define IS(reg) (a == (void *)&(reg))
static void flush_store(void) {
  void *a = pend.addr; int kind = pend.kind;
  if (!kind) return;
  pend.kind = 0;
  if (kind == 2) { Uart *u = (Uart *)a; u->sr &= ~(USART_SR_RXNE | USART_SR_ORE); return; }

  if (IS(sim_GPIOA.BSRR)) { uint32_t v = sim_GPIOA.BSRR; odr_a = (odr_a & ~(v >> 16)) | (v & 0xFFFFU); sim_GPIOA.BSRR = 0; outputs_changed(); }
  else if (IS(sim_GPIOB.BSRR)) { uint32_t v = sim_GPIOB.BSRR; odr_b = (odr_b & ~(v >> 16)) | (v & 0xFFFFU); sim_GPIOB.BSRR = 0; outputs_changed(); }
  else if (IS(sim_GPIOC.BSRR)) { uint32_t v = sim_GPIOC.BSRR; odr_c = (odr_c & ~(v >> 16)) | (v & 0xFFFFU); sim_GPIOC.BSRR = 0; }
  else if (IS(sim_GPIOA.ODR)) { odr_a = sim_GPIOA.ODR & 0xFFFFU; outputs_changed(); }
  else if (IS(sim_GPIOB.ODR)) { odr_b = sim_GPIOB.ODR & 0xFFFFU; outputs_changed(); }
  else if (IS(sim_GPIOC.ODR)) { odr_c = sim_GPIOC.ODR & 0xFFFFU; }
  else if (IS(sim_TIM2.SR)) { tim.sr &= sim_TIM2.SR; } /* rc_w0 */
  else if (IS(sim_TIM2.CCR1)) { sim_TIM2.CCR1 &= tim_mask; } /* TIM2 is 16-bit on the F103 */
  else if (IS(sim_TIM2.ARR)) { sim_TIM2.ARR &= tim_mask; }
  else if (IS(sim_TIM2.PSC)) { sim_TIM2.PSC &= 0xFFFFU; }
  else if (IS(sim_TIM2.EGR)) { if (sim_TIM2.EGR & 1U) { tim.cnt = 0; tim.sr |= TIM_SR_UIF; } sim_TIM2.EGR = 0; }
  else if (IS(sim_TIM2.CR1)) {
    if ((sim_TIM2.CR1 & 1U) && !tim.running) {
      double tick = (sim_TIM2.PSC + 1U) * 1e9 / core_hz();
      tim.running = 1; tim.tick = (uint64_t)(tick + 0.5); tim.next = now_ns + tim.tick;
      if (tim.tick != 1000) die("TIM2 tick is not 1 us");
    }
  }
  else if (IS(sim_EXTI.PR)) { exti_pr &= ~sim_EXTI.PR; }
  else if (IS(sim_USART1.DR)) { uart_write_dr(&uart[0], (uint8_t)sim_USART1.DR); }
  else if (IS(sim_USART2.DR)) { uart_write_dr(&uart[1], (uint8_t)sim_USART2.DR); }
  else if (IS(sim_ADC1.CR2)) {
    uint32_t v = sim_ADC1.CR2;
    if (v & (1U << 22)) { adc.busy = 1; adc.done = now_ns + 7900; }
    sim_ADC1.CR2 = v & ~((1U << 22) | (1U << 3) | (1U << 2));
  }
  else if (IS(sim_ADC1.SR)) { adc.sr &= sim_ADC1.SR; }
  else if (IS(sim_RCC.CR)) {
    uint32_t v = sim_RCC.CR & ~((1U << 1) | (1U << 25));
    if (v & 1U) v |= 1U << 1;
    if (v & (1U << 24)) v |= 1U << 25;
    sim_RCC.CR = v;
  }
  else if (IS(sim_RCC.CFGR)) {
    uint32_t v = sim_RCC.CFGR & ~0xCU, sw = v & 3U;
    if (sw == 2U && (sim_RCC.CR & (1U << 25))) v |= 2U << 2;
    sim_RCC.CFGR = v;
  }
  else if (IS(sim_SYST_CSR)) {
    if ((sim_SYST_CSR & 1U) && !st.running) {
      st.running = 1; st.period = (uint64_t)((sim_SYST_RVR + 1U) * 1e9 / core_hz() + 0.5); st.next = now_ns + st.period;
    }
  }
  else if (IS(sim_NVIC_ISER0)) { nvic_en[0] |= sim_NVIC_ISER0; }
  else if (IS(sim_NVIC_ISER1)) { nvic_en[1] |= sim_NVIC_ISER1; }
  else if (IS(sim_FLASH.KEYR)) {
    uint32_t v = sim_FLASH.KEYR;
    if (fl.key_step == 0 && v == 0x45670123UL) fl.key_step = 1;
    else if (fl.key_step == 1 && v == 0xCDEF89ABUL) { fl.key_step = 0; fl.locked = 0; }
    else fl.key_step = 0;
    sim_FLASH.CR = (sim_FLASH.CR & ~FLASH_CR_LOCK) | (fl.locked ? FLASH_CR_LOCK : 0);
  }
  else if (IS(sim_FLASH.SR)) { fl.sr &= ~(sim_FLASH.SR & (FLASH_SR_EOP | FLASH_SR_PGERR | FLASH_SR_WRPRTERR)); }
  else if (IS(sim_FLASH.CR)) {
    uint32_t v = sim_FLASH.CR;
    if (v & FLASH_CR_LOCK) fl.locked = 1;
    if ((v & FLASH_CR_STRT) && (v & FLASH_CR_PER) && !fl.locked) {
      uint32_t page = sim_FLASH.AR & ~0x3FFUL;
      if (page != FLASH_PAGE_ADDR) die("erase of a page other than the calibration page");
      memset((void *)(uintptr_t)page, 0xFF, 1024);
      fl.busy_until = now_ns + 30 * MS; fl.erases++; /* tERASE is 20..40 ms */
    }
    sim_FLASH.CR = (v & ~(FLASH_CR_STRT | FLASH_CR_LOCK)) | (fl.locked ? FLASH_CR_LOCK : 0);
  }
  else if ((uintptr_t)a >= FLASH_PAGE_ADDR && (uintptr_t)a < FLASH_PAGE_ADDR + 1024) {
    volatile uint16_t *p = (volatile uint16_t *)a; uint16_t v = *p;
    if (fl.locked || !(sim_FLASH.CR & FLASH_CR_PG)) { *p = fl.old; fl.illegal++; }
    else if (fl.old != 0xFFFFU && v != 0) { *p = fl.old; fl.sr |= FLASH_SR_PGERR; }
    else { fl.busy_until = now_ns + 50 * US; fl.words++; }
  }
  else if (IS(sim_IWDG.KR)) {
    uint32_t v = sim_IWDG.KR & 0xFFFFU;
    if (v == 0xCCCCU) {
      if (!wd.started) { wd.started = 1; wd.last_feed = now_ns; if (wd.sr_pending) wd.sr_done = now_ns + 250 * US; }
    } else if (v == 0x5555U) wd.unlocked = 1;
    else if (v == 0xAAAAU) {
      if (wd.started) { uint64_t gap = now_ns - wd.last_feed; if (gap > wd.max_gap) wd.max_gap = gap; wd.last_feed = now_ns; wd.feeds++; }
    }
  }
  else if (IS(sim_IWDG.PR) || IS(sim_IWDG.RLR)) {
    if (wd.unlocked) {
      wd.pr = sim_IWDG.PR & 7U; if (wd.pr > 6) wd.pr = 6;
      wd.rlr = sim_IWDG.RLR & 0xFFFU;
      /* The new value reaches the watchdog domain only while the LSI runs
         (model assumption taken from RM0008; not checked on hardware). */
      wd.sr_pending = 1;
      if (wd.started) wd.sr_done = now_ns + 250 * US; else { wd.sr_done = UINT64_MAX; wd.never_synced = 1; }
    }
  }
}

/* ------------------------------------------------------------------ interrupt delivery */
static int irq_on(int n) { return (nvic_en[n >> 5] >> (n & 31)) & 1U; }

static void dispatch(void) {
  for (;;) {
    if (sim_primask) return;
    int best = -1, best_prio = cur_prio, p;
    if (st.pend && (p = sim_SCB_SHPR[11] >> 4) < best_prio) { best = 0; best_prio = p; }
    if ((exti_pr & sim_EXTI.IMR & 0x3E0U) && irq_on(23) && (p = sim_NVIC_IPR[23] >> 4) < best_prio) { best = 1; best_prio = p; }
    if ((tim.sr & sim_TIM2.DIER & 0x5FU) && irq_on(28) && (p = sim_NVIC_IPR[28] >> 4) < best_prio) { best = 2; best_prio = p; }
    for (int i = 0; i < 2; ++i) {
      Uart *u = &uart[i]; uint32_t cr1 = u->hw->CR1;
      int want = ((u->sr & (USART_SR_RXNE | USART_SR_ORE)) && (cr1 & USART_CR1_RXNEIE)) ||
                 ((u->sr & USART_SR_TXE) && (cr1 & USART_CR1_TXEIE));
      if (want && irq_on(37 + i) && (p = sim_NVIC_IPR[37 + i] >> 4) < best_prio) { best = 3 + i; best_prio = p; }
    }
    if (best < 0) return;
    int saved = cur_prio;
    cur_prio = best_prio;
    irq_count[best]++;
    if (best == 0) st.pend = 0;
    advance(190); sync_regs(); /* 12 cycles exception entry at 64 MHz */
    switch (best) {
      case 0: SysTick_Handler(); break;
      case 1:
        EXTI9_5_IRQHandler();
        if (ts.pending) {
          uint32_t stamp = *fw->last_crank_edge_us;
          ts.pending = 0;
          if (stamp != ts.before) { /* the firmware accepted this edge and stored its time */
            int32_t lag = (int32_t)(stamp - (uint32_t)ts.truth);
            ts.checked++;
            if (lag < 0 || lag > 60) ts.bad++; else if (lag > ts.max_lag) ts.max_lag = lag;
          }
        }
        break;
      case 2: TIM2_IRQHandler(); break;
      case 3: USART1_IRQHandler(); break;
      default: USART2_IRQHandler(); break;
    }
    flush_store();
    advance(190); sync_regs();
    cur_prio = saved;
  }
}

/* ------------------------------------------------------------------ hooks */
static inline void hook(void *addr, int is_store) {
  if (sim_busy) return;
  flush_store();
  if (jitter_state) { /* SIM_JITTER: access cost varies 0.5x..1.5x, pseudo-random */
    jitter_state = jitter_state * 6364136223846793005ULL + 1442695040888963407ULL;
    advance(cost_ns / 2 + (jitter_state >> 33) % (cost_ns + 1));
  } else advance(cost_ns);
  sync_regs();
  dispatch();
  if (is_store) {
    pend.addr = addr; pend.kind = 1;
    if ((uintptr_t)addr >= FLASH_PAGE_ADDR && (uintptr_t)addr < FLASH_PAGE_ADDR + 1024) fl.old = *(volatile uint16_t *)addr;
  } else {
    for (int i = 0; i < 2; ++i) if (addr == (void *)&uart[i].hw->DR) { uart[i].hw->DR = uart[i].rdr; pend.addr = &uart[i]; pend.kind = 2; }
  }
}
void __sanitizer_cov_load1(void *a) { hook(a, 0); }
void __sanitizer_cov_load2(void *a) { hook(a, 0); }
void __sanitizer_cov_load4(void *a) { hook(a, 0); }
void __sanitizer_cov_load8(void *a) { hook(a, 0); }
void __sanitizer_cov_load16(void *a) { hook(a, 0); }
void __sanitizer_cov_store1(void *a) { hook(a, 1); }
void __sanitizer_cov_store2(void *a) { hook(a, 1); }
void __sanitizer_cov_store4(void *a) { hook(a, 1); }
void __sanitizer_cov_store8(void *a) { hook(a, 1); }
void __sanitizer_cov_store16(void *a) { hook(a, 1); }
void __sanitizer_cov_trace_pc_guard(uint32_t *g) { (void)g; }
void __sanitizer_cov_trace_pc_guard_init(uint32_t *a, uint32_t *b) { (void)a; (void)b; }

/* ================================================================== scenarios */
static void act_send0(long p) { pc_send(0, (const char *)p); }
static void act_send1(long p) { pc_send(1, (const char *)p); }
static void act_service(long on) { if (on) in_b &= ~(1U << 13); else in_b |= 1U << 13; }
static void act_kill(long on) { if (on) in_b &= ~(1U << 12); else in_b |= 1U << 12; }
static void act_extra_edge(long unused) { (void)unused; exti_edge(); }
/* wrapedge: one crank edge per TIM2 wrap, placed from -3 us to +3 us around the wrap */
static long wrap_edges;
static void act_wrap_edge(long unused) {
  (void)unused; exti_edge();
  if (tim.running) {
    uint64_t wrap = tim.next + (uint64_t)((sim_TIM2.ARR & tim_mask) - tim.cnt) * tim.tick;
    if (wrap < now_ns + 10 * MS) wrap += 65536ULL * tim.tick;
    long off = -3000 + 25 * (wrap_edges++ % 241);
    sim_at(wrap + off, act_wrap_edge, 0);
  }
}
static struct { uint64_t t; double us[3]; long iac; double pump_ms, heater_ms; } marks[16];
static int n_marks;
static void act_mark(long unused) { (void)unused; marks[n_marks].t = now_ns; memcpy(marks[n_marks].us, test_pulse_us, sizeof(test_pulse_us)); marks[n_marks].iac = (long)iac_phase_changes;
  marks[n_marks].pump_ms = pump_last_ms; marks[n_marks].heater_ms = heater_high_ns / 1e6; n_marks++; }

static char burst_text[16384];
static uint16_t burst_fuel[9][13]; static int16_t burst_ign[9][13];

static uint16_t crc16(const uint8_t *d, uint32_t n) {
  uint16_t crc = 0xFFFF;
  while (n--) { crc ^= (uint16_t)(*d++) << 8; for (int i = 0; i < 8; ++i) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1); }
  return crc;
}

static long count_lines(const char *text, const char *exact) {
  long n = 0; size_t len = strlen(exact); const char *p = text;
  while (p && *p) {
    const char *e = strstr(p, "\r\n"); size_t l = e ? (size_t)(e - p) : strlen(p);
    if (l == len && !memcmp(p, exact, len)) n++;
    p = e ? e + 2 : NULL;
  }
  return n;
}

static void window(uint64_t from, uint64_t to) { win[n_win].from = from; win[n_win].to = to; n_win++; }

static void print_window(const char *tag, const Window *w) {
  printf("%s_sparks=%ld\n%s_missed_sparks=%ld\n%s_extra_sparks=%ld\n%s_bad_angle_sparks=%ld\n", tag, w->sparks, tag, w->missed_sparks, tag, w->extra_sparks, tag, w->bad_angle_sparks);
  printf("%s_max_angle_err_deg=%.3f\n%s_mean_angle_err_deg=%.3f\n%s_max_dwell_err_us=%.2f\n", tag, w->max_angle_err, tag, w->sparks ? w->sum_angle_err / w->sparks : 0.0, tag, w->max_dwell_err);
  printf("%s_injections=%ld\n%s_missed_inj=%ld\n%s_max_inj_err_us=%.2f\n", tag, w->injections, tag, w->missed_inj, tag, w->max_inj_err);
  printf("%s_teeth=%ld\n%s_unsynced_teeth=%ld\n%s_max_rpm_err=%.1f\n", tag, w->teeth, tag, w->unsynced_teeth, tag, w->max_rpm_err);
}

static const char *RAISE_LIMIT = "SET PARAM rev_limit_soft 8400\nSET PARAM rev_limit_hard 9000\n";

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: sim <scenario> [args]\n"); return 2; }
  const char *sc = argv[1];
  double a1 = argc > 2 ? atof(argv[2]) : 0, a2 = argc > 3 ? atof(argv[3]) : 0, a3 = argc > 4 ? atof(argv[4]) : 0;
  if (getenv("SIM_JITTER")) jitter_state = strtoull(getenv("SIM_JITTER"), NULL, 10) * 2 + 1;
  if (getenv("SIM_TIM32")) tim_mask = 0xFFFFFFFFU;
  if (getenv("SIM_COST_NS")) cost_ns = strtoull(getenv("SIM_COST_NS"), NULL, 10);

  void *m = mmap((void *)FLASH_MAP_ADDR, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
  if (m != (void *)FLASH_MAP_ADDR) die("cannot map the calibration page");
  memset(m, 0xFF, 4096);
  if (getenv("SIM_FLASH_IN")) {
    FILE *f = fopen(getenv("SIM_FLASH_IN"), "rb");
    if (!f || fread((void *)FLASH_PAGE_ADDR, 1, 1024, f) != 1024) die("cannot read SIM_FLASH_IN");
    fclose(f);
  }

  fw = fw_view();
  is_new_fw = strncmp(fw->version, "0.8", 3) != 0;
  uart[0].hw = &sim_USART1; uart[0].index = 0; uart[0].sr = 0xC0;
  uart[1].hw = &sim_USART2; uart[1].index = 1; uart[1].sr = 0xC0;
  sim_RCC.CR = 0x83; sim_FLASH.CR = FLASH_CR_LOCK;
  sync_regs();

  int engine = 0, comm_port = 0;
  uint64_t T0 = 100 * MS; /* engine start */

  if (!strcmp(sc, "const")) {            /* const <rpm> */
    engine = 1;
    sim_at(5 * MS, act_service, 1); sim_at(20 * MS, act_send0, (long)RAISE_LIMIT);
    rpm_point(T0, a1);
    uint64_t settle = (uint64_t)(4.0 * 60e9 / a1); if (settle < 500 * MS) settle = 500 * MS;
    window(T0 + settle, T0 + settle + 3200 * MS);
    end_ns = T0 + settle + 3200 * MS;
  } else if (!strcmp(sc, "ramp")) {      /* ramp <rpm0> <rpm1> <ramp_ms> */
    engine = 1;
    sim_at(5 * MS, act_service, 1); sim_at(20 * MS, act_send0, (long)RAISE_LIMIT);
    uint64_t settle = (uint64_t)(4.0 * 60e9 / a1); if (settle < 500 * MS) settle = 500 * MS;
    uint64_t t1 = T0 + settle + 700 * MS, t2 = t1 + (uint64_t)(a3 * MS);
    rpm_point(T0, a1); rpm_point(t1, a1); rpm_point(t2, a2);
    end_ns = t2 + 1800 * MS;
    window(T0 + settle, end_ns);         /* whole run */
    window(t2 + 300 * MS, end_ns);       /* steady part after the ramp */
  } else if (!strcmp(sc, "stop")) {      /* stop <rpm> <offset_us>: the crank signal vanishes */
    engine = 1;
    sim_at(5 * MS, act_service, 1); sim_at(20 * MS, act_send0, (long)RAISE_LIMIT);
    uint64_t settle = (uint64_t)(4.0 * 60e9 / a1); if (settle < 500 * MS) settle = 500 * MS;
    uint64_t ts = T0 + settle + 300 * MS + (uint64_t)(a2 * US);
    rpm_point(T0, a1); rpm_point(ts, a1); rpm_point(ts, 0);
    stop.active = 1; stop.t = ts;
    window(T0 + settle, ts);
    end_ns = ts + 1300 * MS;
  } else if (!strcmp(sc, "syncloss")) {  /* syncloss <rpm>: missing and extra tooth pulses */
    engine = 1;
    sim_at(5 * MS, act_service, 1); sim_at(20 * MS, act_send0, (long)RAISE_LIMIT);
    rpm_point(T0, a1);
    double rev_ns = 60e9 / a1;
    long k0 = 36 * 12;
    drop_teeth[n_drop++] = k0 + 7; drop_teeth[n_drop++] = k0 + 36 * 6 + 20;
    drop_teeth[n_drop++] = k0 + 36 * 12 + 14; drop_teeth[n_drop++] = k0 + 36 * 12 + 15; drop_teeth[n_drop++] = k0 + 36 * 12 + 16;
    drop_teeth[n_drop++] = k0 + 36 * 18 + 1; drop_teeth[n_drop++] = k0 + 36 * 24 + 33;
    for (int i = 0; i < 12; ++i) sim_at(T0 + (uint64_t)(rev_ns * (15.0 + 2.37 * i)), act_extra_edge, 0);
    window(T0 + (uint64_t)(rev_ns * 8), T0 + (uint64_t)(rev_ns * 50));
    end_ns = T0 + (uint64_t)(rev_ns * 50) + 100 * MS;
    if (end_ns < T0 + 3000 * MS) end_ns = T0 + 3000 * MS;
  } else if (!strcmp(sc, "restart")) {   /* 3000 rpm, signal vanishes, then cranking at 300 rpm */
    engine = 1;
    sim_at(5 * MS, act_service, 1); sim_at(20 * MS, act_send0, (long)RAISE_LIMIT);
    rpm_point(T0, 3000); rpm_point(1200 * MS, 3000); rpm_point(1200 * MS, 0);
    rpm_point(2200 * MS, 0); rpm_point(2200 * MS, 300);
    window(600 * MS, 1200 * MS); window(3200 * MS, 6200 * MS);
    end_ns = 6200 * MS;
  } else if (!strcmp(sc, "wrapedge")) {  /* crank edges exactly around the 16-bit counter wrap */
    sim_at(200 * MS, act_wrap_edge, 0);
    end_ns = 200 * MS + 500ULL * 65536 * US;
  } else if (!strcmp(sc, "noisestart")) { /* two noise edges 60 us apart just before cranking starts */
    engine = 1;
    sim_at(990 * MS, act_extra_edge, 0); sim_at(990 * MS + 60 * US, act_extra_edge, 0);
    rpm_point(1000 * MS, 300);
    window(2000 * MS, 5000 * MS);
    window(1000 * MS, 5000 * MS);
    end_ns = 5000 * MS;
  } else if (!strcmp(sc, "revlimit")) {  /* revlimit <rpm>: default limits 6800 / 7000 */
    engine = 1;
    rpm_point(T0, a1); window(T0 + 500 * MS, T0 + 2500 * MS); end_ns = T0 + 2500 * MS;
  } else if (!strcmp(sc, "kill")) {      /* kill switch closed while running at 3000 rpm */
    engine = 1;
    rpm_point(T0, 3000); window(600 * MS, 1500 * MS);
    sim_at(1500 * MS, act_kill, 1); sim_at(1500 * MS, act_mark, 0); sim_at(1520 * MS, act_mark, 0);
    window(1520 * MS, 2500 * MS); end_ns = 2500 * MS;
  } else if (!strcmp(sc, "burst")) {     /* burst <port>: 234 SET commands back to back, telemetry on */
    comm_port = (int)a1;
    char *p = burst_text;
    for (int r = 0; r < 9; ++r) for (int c = 0; c < 13; ++c) {
      burst_fuel[r][c] = (uint16_t)(1000 + r * 100 + c * 7);
      burst_ign[r][c] = (int16_t)((r * 13 + c * 3) % 301);
      p += sprintf(p, "SET FUEL %d %d %d\n", r, c, burst_fuel[r][c]);
    }
    for (int r = 0; r < 9; ++r) for (int c = 0; c < 13; ++c) p += sprintf(p, "SET IGN %d %d %d\n", r, c, burst_ign[r][c]);
    sim_at(5 * MS, act_service, 1);
    /* burst <port> 1: the burst follows a GET MAPS request without a pause */
    if (a2 > 0) sim_at(300 * MS, comm_port ? act_send1 : act_send0, (long)"GET MAPS\n");
    sim_at(300 * MS, comm_port ? act_send1 : act_send0, (long)burst_text);
    sim_at(1500 * MS, comm_port ? act_send1 : act_send0, (long)"GET CRC\n");
    end_ns = 2000 * MS;
  } else if (!strcmp(sc, "maps")) {      /* long replies while the engine runs and telemetry is on */
    engine = 1;
    rpm_point(T0, 3000); window(T0 + 500 * MS, 3000 * MS);
    sim_at(1000 * MS, act_send0, (long)"GET MAPS\nGET PARAMS\nGET MAPS\nGET MAPS\nGET PARAMS\nGET STATUS\nGET INFO\nPING\nGET MAPS\n");
    sim_at(1000 * MS, act_send1, (long)"GET MAPS\nGET PARAMS\nGET MAPS\n");
    end_ns = 3000 * MS;
  } else if (!strcmp(sc, "tests")) {     /* actuator tests and interlocks; telemetry off for a clean transcript */
    sim_at(50 * MS, act_send0, (long)"STREAM 0\n");
    sim_at(60 * MS, act_send1, (long)"STREAM 0\n");
    sim_at(2100 * MS, act_send0, (long)"PING\nTEST COIL1\nSET FUEL 0 0 1234\nSAVE\nDEFAULTS\nHOMEIAC\nSET PARAM dwell_us 2000\n");
    sim_at(2200 * MS, act_service, 1);
    sim_at(2300 * MS, act_send0, (long)"TEST INJECTOR\n");
    sim_at(2400 * MS, act_mark, 0);
    sim_at(2400 * MS, act_send0, (long)"TEST COIL1\n");
    sim_at(2500 * MS, act_mark, 0);
    sim_at(2500 * MS, act_send0, (long)"TEST COIL2\n");
    sim_at(2600 * MS, act_mark, 0);
    sim_at(2600 * MS, act_send0, (long)"TEST IAC_OPEN\n");
    sim_at(2900 * MS, act_mark, 0);
    sim_at(2900 * MS, act_send0, (long)"TEST IAC_CLOSE\n");
    sim_at(3200 * MS, act_mark, 0);
    sim_at(3200 * MS, act_send0, (long)"TEST PUMP\n");
    sim_at(5290 * MS, act_mark, 0);
    sim_at(5300 * MS, act_send0, (long)"TEST O2_HEATER\n");
    sim_at(5800 * MS, act_send0, (long)"TEST STOP\n");
    sim_at(5850 * MS, act_mark, 0);
    sim_at(5900 * MS, act_send0, (long)"TEST BOGUS\nTEST\nFOO\nSET FUEL 9 0 1000\nSET FUEL 0 0 1234\nSET IGN 8 12 155\nSET PARAM dwell_us 2000\nSET PARAM nope 1\nSET X\nGET X\nSTREAM 0\nCLEARFAULTS\n");
    /* a test pulse immediately followed by SAVE (Flash programming masks interrupts) */
    sim_at(6100 * MS, act_send0, (long)"TEST COIL1\nSAVE\n");
    sim_at(6400 * MS, act_mark, 0);
    sim_at(6400 * MS, act_send0, (long)"TEST INJECTOR\nSAVE\n");
    sim_at(6700 * MS, act_mark, 0);
    /* engine turning: everything must be locked */
    rpm_point(7000 * MS, 600);
    sim_at(7600 * MS, act_send0, (long)"TEST COIL1\nSET FUEL 0 0 2222\nSAVE\nTEST STOP\n");
    sim_at(7700 * MS, act_send1, (long)"PING\nTEST PUMP\n");
    end_ns = 8000 * MS;
  } else if (!strcmp(sc, "calsave")) {   /* change a few cells, SAVE, dump the Flash page */
    sim_at(5 * MS, act_service, 1);
    sim_at(200 * MS, act_send0, (long)"STREAM 0\nSET FUEL 3 4 4321\nSET IGN 8 12 277\nSET PARAM dwell_us 2222\nSET PARAM trigger_trim_tenths -37\nSET PARAM iac_direction -1\nSAVE\n");
    end_ns = 600 * MS;
  } else if (!strcmp(sc, "calload")) {   /* boot with a Flash page written by the other firmware */
    sim_at(200 * MS, act_send0, (long)"STREAM 0\nGET MAPS\nGET PARAMS\n");
    end_ns = 700 * MS;
  } else { fprintf(stderr, "unknown scenario %s\n", sc); return 2; }

  if (!setjmp(end_jmp)) { sim_busy = 0; fw_start(); }
  sim_busy = 1;

  /* ---------------------------------------------------------------- report */
  printf("scenario=%s\nfw=%s\ncost_ns=%llu\nsim_ms=%.1f\n", sc, fw->version, (unsigned long long)cost_ns, now_ns / 1e6);
  printf("tim2_bits=%d\n", tim_mask == 0xFFFFU ? 16 : 32);
  printf("tim2_overflows=%llu\n", (unsigned long long)tim_overflows);
  printf("main_loop_max_gap_ms=%.3f\nwdt_resets=%llu\nwdt_started=%d\nwdt_timeout_ms=%.0f\n", wd.max_gap / 1e6, (unsigned long long)wd.resets, wd.started,
         (wd.rlr + 1U) * (double)(4U << wd.pr) / 40.0);
  printf("irq_systick=%llu\nirq_exti=%llu\nirq_tim2=%llu\nirq_usart1=%llu\nirq_usart2=%llu\n", (unsigned long long)irq_count[0], (unsigned long long)irq_count[1],
         (unsigned long long)irq_count[2], (unsigned long long)irq_count[3], (unsigned long long)irq_count[4]);
  for (int i = 0; i < 2; ++i)
    printf("uart%d_rx_overrun=%llu\nuart%d_tx_lost=%llu\nuart%d_tx_bytes=%zu\n", i + 1, (unsigned long long)uart[i].rx_overrun, i + 1, (unsigned long long)uart[i].tx_lost, i + 1, uart[i].out_len);
  printf("fault_flags=%u\n", *fw->fault_flags);
  printf("ts_checked=%ld\nts_bad=%ld\nts_max_lag_us=%.0f\n", ts.checked, ts.bad, ts.max_lag);
  if (engine) {
    printf("teeth_sent=%llu\n", (unsigned long long)teeth_sent);
    printf("coil1_max_on_us=%.1f\ncoil2_max_on_us=%.1f\ninj_max_open_us=%.1f\n", coil[0].max_on_us, coil[1].max_on_us, inj.max_on_us);
    printf("coil1_on_at_end=%d\ncoil2_on_at_end=%d\ninj_on_at_end=%d\n", coil[0].on, coil[1].on, inj.on);
    printf("final_rpm=%u\nfinal_sync=%u\n", *fw->engine_rpm, *fw->crank_synced);
    for (int i = 0; i < n_win; ++i) { char tag[8]; sprintf(tag, "w%d", i); print_window(tag, &win[i]); }
  }
  if (stop.active) {
    printf("stop_detect_ms=%.2f\nstop_outputs_after=%ld\n", stop.detect ? (stop.detect - stop.t) / 1e6 : -1.0, stop.output_after);
  }
  if (!strcmp(sc, "burst")) {
    int applied = 0;
    for (int r = 0; r < 9; ++r) for (int c = 0; c < 13; ++c) {
      applied += fw->fuel[r * 13 + c] == burst_fuel[r][c];
      applied += fw->ign[r * 13 + c] == burst_ign[r][c];
    }
    const char *out = uart[comm_port].out ? uart[comm_port].out : "";
    printf("burst_cells_applied=%d\nburst_ok_replies=%ld\nburst_bytes=%zu\n", applied, count_lines(out, "OK"), strlen(burst_text));
    char expect[64];
    sprintf(expect, "CRC,%u,%u,%u", crc16((const uint8_t *)burst_fuel, sizeof(burst_fuel)), crc16((const uint8_t *)burst_ign, sizeof(burst_ign)),
            crc16(fw->params, fw->params_size));
    printf("burst_crc_expected=%s\nburst_crc_reply_ok=%ld\nparams_size=%u\n", expect, count_lines(out, expect), fw->params_size);
  }
  if (!strcmp(sc, "kill")) printf("kill_outputs_low_after_20ms=%d\n", !coil[0].on && !coil[1].on && !inj.on);
  for (int i = 0; i < n_marks; ++i)
    printf("mark%d=%.0f,%.1f,%.1f,%.1f,%ld,%.1f,%.1f\n", i, marks[i].t / 1e6, marks[i].us[0], marks[i].us[1], marks[i].us[2], marks[i].iac, marks[i].pump_ms, marks[i].heater_ms);
  printf("flash_erases=%llu\nflash_words=%llu\nflash_illegal=%llu\n", (unsigned long long)fl.erases, (unsigned long long)fl.words, (unsigned long long)fl.illegal);
  if (getenv("SIM_FLASH_OUT")) { FILE *f = fopen(getenv("SIM_FLASH_OUT"), "wb"); fwrite((void *)FLASH_PAGE_ADDR, 1, 1024, f); fclose(f); }
  if (getenv("SIM_DUMP")) {
    char name[512];
    for (int i = 0; i < 2; ++i) {
      snprintf(name, sizeof(name), "%s.uart%d.txt", getenv("SIM_DUMP"), i + 1);
      FILE *f = fopen(name, "wb"); if (uart[i].out) fwrite(uart[i].out, 1, uart[i].out_len, f); fclose(f);
    }
  }
  return 0;
}
