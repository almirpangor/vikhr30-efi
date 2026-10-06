/*
 * Vikhr-30 EFI ECU v0.8.0 BT/UART + diagnostics + actuator test
 * STM32F103C6T6A, bare metal register-level firmware.
 * No Arduino Core, HAL, RTOS, dynamic allocation, or C runtime dependency.
 *
 * Trigger: Hall 36-1, first rising edge after the gap = 170 deg BTDC cyl. 1.
 * Fuel: one Bosch 0 280 158 117, 540 cc/min at 3 bar, two pulses/revolution.
 * Ignition: two Delphi 28198992 coils via two ST VBG08H-E drivers.
 * Idle: Continental 26179 bipolar stepper via DRV8843.
 * Tuning: USART1 service/HC-06 + USART2 fallback, 115200 8N1.
 * Native USB is deliberately disabled in this recovery build.
 */

#include "stm32f103xb_min.h"

#define FW_VERSION "0.8.0-C6-BT-DIAG"
#define ARRAY_LEN(a) ((uint32_t)(sizeof(a) / sizeof((a)[0])))

enum {
  RPM_COUNT = 13,
  LOAD_COUNT = 9,
  EVENT_COUNT = 12,
  RX_SIZE = 256,
  LINE_SIZE = 192
};

static const uint16_t rpm_bins[RPM_COUNT] =
    {600, 900, 1200, 1600, 2200, 3000, 3800, 4500, 5000, 5500, 6000, 7000, 8000};
static const uint16_t load_bins[LOAD_COUNT] = {0, 20, 50, 100, 200, 350, 550, 750, 1000};

static const uint16_t default_fuel[LOAD_COUNT][RPM_COUNT] = {
  {1880,1590,1470,1260, 890, 770, 770, 770, 770, 770, 770, 770, 770},
  {1930,1670,1550,1410,1160,1060,1050,1030,1020,1020,1000, 990, 960},
  {2000,1790,1670,1620,1560,1500,1470,1420,1400,1380,1350,1310,1250},
  {2150,2000,1910,1850,1820,1770,1750,1730,1710,1700,1670,1640,1590},
  {2410,2280,2200,2150,2130,2120,2120,2110,2090,2070,2050,2020,1970},
  {2650,2560,2500,2480,2480,2480,2500,2500,2490,2460,2430,2400,2340},
  {2950,2870,2840,2830,2850,2890,2920,2940,2920,2870,2840,2810,2750},
  {3190,3140,3120,3110,3150,3200,3240,3250,3240,3190,3160,3140,3070},
  {3420,3380,3360,3370,3410,3440,3470,3450,3410,3320,3300,3250,3180}
};

/* Degrees BTDC multiplied by ten. */
static const int16_t default_ign[LOAD_COUNT][RPM_COUNT] = {
  {50,100,140,180,220,260,280,280,270,250,240,220,200},
  {50,100,140,180,224,264,284,284,274,254,240,220,200},
  {50,100,140,180,230,270,290,290,280,260,240,220,200},
  {50, 90,130,180,230,270,290,290,280,260,240,220,200},
  {50, 90,130,170,220,260,280,280,270,250,230,210,190},
  {50, 80,120,170,210,250,270,270,260,240,220,200,180},
  {50, 80,120,160,208,248,268,268,258,238,218,188,168},
  {50, 80,120,160,200,240,260,260,250,230,210,180,160},
  {50, 80,120,160,200,240,260,260,250,230,210,180,160}
};

enum FaultBits {
  FAULT_EVENT_OVERFLOW = 1U << 0,
  FAULT_DWELL_SHORT     = 1U << 1,
  FAULT_PW_CLAMP        = 1U << 2,
  FAULT_SENSOR          = 1U << 3,
  FAULT_OVERHEAT        = 1U << 4,
  FAULT_REV_LIMIT       = 1U << 5,
  FAULT_SYNC_LOSS       = 1U << 6,
  FAULT_IAC_DRIVER      = 1U << 7,
  FAULT_O2_INVALID      = 1U << 8,
  FAULT_FLASH           = 1U << 9
};

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  uint16_t fuel_us[LOAD_COUNT][RPM_COUNT];
  int16_t ignition_tenths[LOAD_COUNT][RPM_COUNT];
  int16_t trigger_trim_tenths;
  uint16_t dwell_us;
  uint16_t injector_deadtime_us;
  uint16_t tps_min_raw;
  uint16_t tps_max_raw;
  uint16_t fuel_scale_permille;
  uint16_t soft_rev_limit;
  uint16_t hard_rev_limit;
  uint16_t iac_max_steps;
  uint16_t iac_crank_steps;
  uint16_t iac_hot_steps;
  uint16_t iac_target_rpm;
  int8_t iac_direction;
  uint8_t o2_heater_duty_pct;
  uint8_t o2_mode; /* 0: OSM28488580 narrowband, 1: external 0-5 V wideband */
  uint8_t reserved;
  uint16_t wideband_lambda_min_milli;
  uint16_t wideband_lambda_max_milli;
  uint16_t crc;
} Calibration;

#define CAL_MAGIC 0x56454649UL
#define CAL_VERSION 5U
#define CAL_FLASH_ADDRESS 0x08007C00UL

static Calibration cal;
static volatile uint32_t ms_ticks;
static uint32_t core_clock_hz = 8000000U;
static uint32_t apb1_clock_hz = 8000000U;
static uint8_t clock_pll_ok;
static volatile uint16_t fault_flags;
static volatile uint16_t engine_rpm;
static volatile uint8_t crank_synced;
static volatile uint32_t last_crank_edge_us;
static volatile uint16_t prepared_fuel_us = 1600;
static volatile uint16_t prepared_dwell_us = 1600;
static volatile int16_t prepared_advance_tenths = 50;
static volatile int16_t prepared_trigger_tenths = 1700;
static volatile uint8_t prepared_fuel_cut;
static int16_t fixed_ign_tenths = -1;
static uint16_t peak_rpm;
static uint16_t current_fuel_us;
static int16_t current_advance_tenths;

typedef struct {
  uint16_t tps_raw;
  uint16_t tps_tenths;
  uint16_t map_kpa_tenths;
  int16_t cht_c_tenths;
  int16_t iat_c_tenths;
  uint16_t battery_mv;
  uint16_t o2_mv;
  uint16_t lambda_milli;
  int8_t lambda_direction; /* -1 rich, 0 target/transition, +1 lean, +2 warming/invalid */
  uint16_t baro_kpa_tenths;
} SensorState;

static SensorState sensors = {0, 0, 1013, 200, 200, 12500, 450, 0, 2, 1013};
static uint16_t accel_enrich_permille = 1000;
static uint16_t previous_tps_tenths;
static uint32_t last_sensor_ms;

typedef struct {
  USART_TypeDef *hw;
  volatile uint16_t head, tail;
  char rx[RX_SIZE];
  char line[LINE_SIZE];
  uint16_t line_len;
} SerialPort;

static SerialPort wire_port = {USART1, 0, 0, {0}, {0}, 0};
static SerialPort bt_port   = {USART2, 0, 0, {0}, {0}, 0};
static uint8_t stream_hz = 10;
static uint32_t last_stream_ms;

enum ActuatorTest {
  ACT_TEST_NONE = 0,
  ACT_TEST_PUMP,
  ACT_TEST_INJECTOR,
  ACT_TEST_COIL1,
  ACT_TEST_COIL2,
  ACT_TEST_IAC_OPEN,
  ACT_TEST_IAC_CLOSE,
  ACT_TEST_O2_HEATER
};
static volatile uint8_t actuator_test;
static uint32_t actuator_test_deadline_ms, actuator_test_next_ms;
static uint16_t actuator_test_steps;

static uint8_t str_eq(const char *a, const char *b);
static uint8_t mutation_allowed(void);

static void mem_zero(void *target, uint32_t length) {
  uint8_t *p = (uint8_t *)target;
  while (length--) *p++ = 0;
}

static void mem_copy(void *target, const void *source, uint32_t length) {
  uint8_t *d = (uint8_t *)target;
  const uint8_t *s = (const uint8_t *)source;
  while (length--) *d++ = *s++;
}

static int32_t clamp_i32(int32_t v, int32_t lo, int32_t hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

static uint16_t crc16_ccitt(const uint8_t *data, uint32_t length) {
  uint16_t crc = 0xFFFFU;
  while (length--) {
    crc ^= (uint16_t)(*data++) << 8;
    for (uint8_t i = 0; i < 8; ++i)
      crc = (crc & 0x8000U) ? (uint16_t)((crc << 1) ^ 0x1021U)
                            : (uint16_t)(crc << 1);
  }
  return crc;
}

static uint32_t calibration_crc_length(void) {
  return (uint32_t)((uintptr_t)&cal.crc - (uintptr_t)&cal);
}

static void load_defaults(void) {
  mem_zero(&cal, sizeof(cal));
  cal.magic = CAL_MAGIC;
  cal.version = CAL_VERSION;
  cal.size = (uint16_t)sizeof(cal);
  mem_copy(cal.fuel_us, default_fuel, sizeof(default_fuel));
  mem_copy(cal.ignition_tenths, default_ign, sizeof(default_ign));
  cal.dwell_us = 1600;
  cal.injector_deadtime_us = 650;
  cal.tps_min_raw = 420;
  cal.tps_max_raw = 3720;
  cal.fuel_scale_permille = 1000;
  cal.soft_rev_limit = 6800;
  cal.hard_rev_limit = 7000;
  cal.iac_max_steps = 180;
  cal.iac_crank_steps = 90;
  cal.iac_hot_steps = 30;
  cal.iac_target_rpm = 1100;
  cal.iac_direction = 1;
  cal.o2_heater_duty_pct = 70;
  cal.o2_mode = 0;
  cal.wideband_lambda_min_milli = 700;
  cal.wideband_lambda_max_milli = 1300;
  cal.crc = crc16_ccitt((const uint8_t *)&cal, calibration_crc_length());
}

static uint8_t load_calibration(void) {
  const Calibration *stored = (const Calibration *)CAL_FLASH_ADDRESS;
  mem_copy(&cal, stored, sizeof(cal));
  uint16_t expected = crc16_ccitt((const uint8_t *)&cal, calibration_crc_length());
  if (cal.magic != CAL_MAGIC || cal.version != CAL_VERSION ||
      cal.size != sizeof(cal) || cal.crc != expected) {
    load_defaults();
    return 0;
  }
  return 1;
}

static uint8_t flash_wait(void) {
  uint32_t timeout = 3000000U;
  while ((FLASH_IF->SR & FLASH_SR_BSY) && timeout--) {}
  if (!timeout || (FLASH_IF->SR & (FLASH_SR_PGERR | FLASH_SR_WRPRTERR))) return 0;
  return 1;
}

static uint8_t save_calibration(void) {
  cal.magic = CAL_MAGIC;
  cal.version = CAL_VERSION;
  cal.size = (uint16_t)sizeof(cal);
  cal.crc = crc16_ccitt((const uint8_t *)&cal, calibration_crc_length());
  irq_disable();
  if (FLASH_IF->CR & FLASH_CR_LOCK) {
    FLASH_IF->KEYR = 0x45670123UL;
    FLASH_IF->KEYR = 0xCDEF89ABUL;
  }
  FLASH_IF->SR = FLASH_SR_EOP | FLASH_SR_PGERR | FLASH_SR_WRPRTERR;
  FLASH_IF->CR |= FLASH_CR_PER;
  FLASH_IF->AR = CAL_FLASH_ADDRESS;
  FLASH_IF->CR |= FLASH_CR_STRT;
  uint8_t ok = flash_wait();
  FLASH_IF->CR &= ~FLASH_CR_PER;
  const uint16_t *source = (const uint16_t *)&cal;
  volatile uint16_t *target = (volatile uint16_t *)CAL_FLASH_ADDRESS;
  if (ok) {
    FLASH_IF->CR |= FLASH_CR_PG;
    for (uint32_t i = 0; i < (sizeof(cal) + 1U) / 2U; ++i) {
      target[i] = source[i];
      if (!flash_wait()) { ok = 0; break; }
    }
    FLASH_IF->CR &= ~FLASH_CR_PG;
  }
  FLASH_IF->CR |= FLASH_CR_LOCK;
  irq_enable();
  if (!ok) fault_flags |= FAULT_FLASH;
  return ok;
}

static void gpio_config(GPIO_TypeDef *port, uint8_t pin, uint8_t nibble) {
  volatile uint32_t *cr = pin < 8 ? &port->CRL : &port->CRH;
  uint8_t shift = (uint8_t)((pin & 7U) * 4U);
  *cr = (*cr & ~(0xFUL << shift)) | ((uint32_t)nibble << shift);
}

static void gpio_write(GPIO_TypeDef *port, uint8_t pin, uint8_t high) {
  port->BSRR = high ? (1UL << pin) : (1UL << (pin + 16U));
}

static uint8_t gpio_read(GPIO_TypeDef *port, uint8_t pin) {
  return (port->IDR & (1UL << pin)) != 0;
}

static uint8_t kill_active(void) { return !gpio_read(GPIOB, 12); }
static uint8_t service_jumper(void) { return !gpio_read(GPIOB, 13); }
static uint8_t bluetooth_connected(void) { return gpio_read(GPIOB, 14); }

static void clock_init(void) {
  /*
   * Use the internal 8 MHz oscillator as the only clock source.  This removes
   * the hard dependency on the clone board's HSE crystal and its load parts.
   * HSI/2 * 16 = 64 MHz; APB1 is divided by two and the ADC by six.
   */
  RCC->CR |= 1UL << 0; /* HSION */
  uint32_t timeout = 2000000U;
  while (!(RCC->CR & (1UL << 1)) && timeout--) {}

  RCC->CFGR &= ~3UL; /* request HSI before reconfiguring PLL */
  timeout = 2000000U;
  while (((RCC->CFGR >> 2) & 3UL) != 0U && timeout--) {}
  RCC->CR &= ~(1UL << 24); /* PLL off */
  timeout = 2000000U;
  while ((RCC->CR & (1UL << 25)) && timeout--) {}

  FLASH_IF->ACR = FLASH_ACR_PRFTBE | FLASH_ACR_LATENCY_2;
  RCC->CFGR = (4UL << 8) | (2UL << 14) | (14UL << 18);
  RCC->CR |= 1UL << 24; /* PLLON */
  timeout = 2000000U;
  while (!(RCC->CR & (1UL << 25)) && timeout--) {}
  if (timeout) {
    RCC->CFGR = (RCC->CFGR & ~3UL) | 2UL;
    timeout = 2000000U;
    while (((RCC->CFGR >> 2) & 3UL) != 2UL && timeout--) {}
    if (timeout) {
      core_clock_hz = 64000000U;
      apb1_clock_hz = 32000000U;
      clock_pll_ok = 1U;
      return;
    }
  }

  /* Safe fallback: direct HSI at 8 MHz.  No wait below can block forever. */
  RCC->CFGR &= ~3UL;
  timeout = 2000000U;
  while (((RCC->CFGR >> 2) & 3UL) != 0U && timeout--) {}
  RCC->CR &= ~(1UL << 24);
  RCC->CFGR = 0U;
  FLASH_IF->ACR = FLASH_ACR_PRFTBE;
  core_clock_hz = 8000000U;
  apb1_clock_hz = 8000000U;
  clock_pll_ok = 0U;
}

static void systick_init(void) {
  SYST_RVR = core_clock_hz / 1000U - 1U;
  SYST_CVR = 0;
  SYST_CSR = 7U;
}

static void watchdog_init(void) {
  /* LSI nominal 40 kHz: prescaler 64 and reload 625 give about 1 s. */
  IWDG->KR = 0x5555U;
  IWDG->PR = 4U;
  IWDG->RLR = 625U;
  uint32_t timeout = 200000U;
  while (IWDG->SR && timeout--) {}
  if (timeout) {
    IWDG->KR = 0xAAAAU;
    IWDG->KR = 0xCCCCU;
  } else fault_flags |= FAULT_SENSOR;
}

void SysTick_Handler(void) { ++ms_ticks; }

static void uart_init(void) {
  /* PA9/PA2 AF push-pull; PA10/PA3 floating input. */
  gpio_config(GPIOA, 9, 0xA); gpio_config(GPIOA, 10, 0x4);
  gpio_config(GPIOA, 2, 0xA); gpio_config(GPIOA, 3, 0x4);
  USART1->BRR = (core_clock_hz + 57600U) / 115200U;
  USART2->BRR = (apb1_clock_hz + 57600U) / 115200U;
  USART1->CR1 = USART_CR1_UE | USART_CR1_RE | USART_CR1_TE | USART_CR1_RXNEIE;
  USART2->CR1 = USART_CR1_UE | USART_CR1_RE | USART_CR1_TE | USART_CR1_RXNEIE;
  NVIC_IPR[37] = 0x60; NVIC_IPR[38] = 0x60;
  NVIC_ISER1 = (1UL << (37 - 32)) | (1UL << (38 - 32));
}

static void serial_rx_isr(SerialPort *port) {
  if (port->hw->SR & USART_SR_RXNE) {
    char ch = (char)port->hw->DR;
    uint16_t next = (uint16_t)((port->head + 1U) & (RX_SIZE - 1U));
    if (next != port->tail) { port->rx[port->head] = ch; port->head = next; }
  }
}

void USART1_IRQHandler(void) { serial_rx_isr(&wire_port); }
void USART2_IRQHandler(void) { serial_rx_isr(&bt_port); }

static void port_char(SerialPort *port, char ch) {
  uint32_t timeout = 200000U;
  while (!(port->hw->SR & USART_SR_TXE) && timeout--) {}
  if (timeout) port->hw->DR = (uint8_t)ch;
}

static void port_text(SerialPort *port, const char *text) {
  while (*text) port_char(port, *text++);
}

static void port_u32(SerialPort *port, uint32_t value) {
  char digits[11]; uint8_t n = 0;
  do { digits[n++] = (char)('0' + value % 10U); value /= 10U; } while (value);
  while (n) port_char(port, digits[--n]);
}

static void port_i32(SerialPort *port, int32_t value) {
  if (value < 0) { port_char(port, '-'); value = -value; }
  port_u32(port, (uint32_t)value);
}

static void port_csv_u32(SerialPort *port, uint32_t value) {
  port_char(port, ','); port_u32(port, value);
}

static void port_csv_i32(SerialPort *port, int32_t value) {
  port_char(port, ','); port_i32(port, value);
}

static void port_line(SerialPort *port, const char *text) {
  port_text(port, text); port_text(port, "\r\n");
}

static uint16_t adc_read(uint8_t channel) {
  ADC1->SQR3 = channel;
  ADC1->SR = 0;
  ADC1->CR2 |= 1UL << 22;
  uint32_t timeout = 100000U;
  while (!(ADC1->SR & (1UL << 1)) && timeout--) {}
  return (uint16_t)ADC1->DR;
}

static void adc_init(void) {
  ADC1->SMPR2 = 0x00DB6DB6UL; /* 71.5 cycles for channels 0..7 */
  ADC1->CR2 = (1UL << 20) | (7UL << 17) | 1UL;
  for (volatile uint32_t i = 0; i < 10000U; ++i) cpu_nop();
  ADC1->CR2 |= 1UL << 3;
  uint32_t timeout = 500000U;
  while ((ADC1->CR2 & (1UL << 3)) && timeout--) {}
  if (!timeout) fault_flags |= FAULT_SENSOR;
  ADC1->CR2 |= 1UL << 2;
  timeout = 500000U;
  while ((ADC1->CR2 & (1UL << 2)) && timeout--) {}
  if (!timeout) fault_flags |= FAULT_SENSOR;
}

typedef struct { uint16_t adc; int16_t temp_tenths; } NtcPoint;
static const NtcPoint cht_table[] = {
  {4000,-200},{3927,-100},{3813,0},{3645,100},{3416,200},{3126,300},
  {2786,400},{2417,500},{2046,600},{1696,700},{1383,800},{1117,900},
  {896,1000},{718,1100},{575,1200},{463,1300},{374,1400}
};
static const NtcPoint iat_table[] = {
  {3558,-200},{3262,-100},{2893,0},{2477,100},{2052,200},{1653,300},
  {1306,400},{1019,500},{791,600},{614,700},{478,800},{374,900},
  {295,1000},{235,1100},{188,1200},{152,1300},{124,1400}
};

static int16_t ntc_lookup(uint16_t adc, const NtcPoint *table, uint32_t count) {
  if (adc >= table[0].adc) return table[0].temp_tenths;
  if (adc <= table[count - 1].adc) return table[count - 1].temp_tenths;
  for (uint32_t i = 0; i + 1U < count; ++i) {
    if (adc <= table[i].adc && adc >= table[i + 1U].adc) {
      int32_t span = (int32_t)table[i].adc - table[i + 1U].adc;
      int32_t offset = (int32_t)table[i].adc - adc;
      return (int16_t)(table[i].temp_tenths +
          offset * (table[i + 1U].temp_tenths - table[i].temp_tenths) / span);
    }
  }
  return 200;
}

static int32_t smooth_i32(int32_t old_value, int32_t new_value, uint8_t num, uint8_t den) {
  return old_value + (new_value - old_value) * num / den;
}

static volatile uint8_t current_o2_heater_pct;

static void read_sensors(void) {
  uint16_t tps_raw = adc_read(0), map_raw = adc_read(1);
  uint16_t cht_raw = adc_read(4), iat_raw = adc_read(5);
  uint16_t battery_raw = adc_read(6), o2_raw = adc_read(7);
  int32_t tps_span = (int32_t)cal.tps_max_raw - cal.tps_min_raw;
  if (tps_span < 80) tps_span = 80;
  int32_t tps = ((int32_t)tps_raw - cal.tps_min_raw) * 1000 / tps_span;
  tps = clamp_i32(tps, 0, 1000);
  uint32_t adc_mv = (uint32_t)map_raw * 3300U / 4095U;
  int32_t sensor_mv = (int32_t)adc_mv * 3 / 2;
  int32_t map_tenths = 200 + (sensor_mv - 500) * 19 / 80;
  map_tenths = clamp_i32(map_tenths, 100, 1200);
  int16_t cht = ntc_lookup(cht_raw, cht_table, ARRAY_LEN(cht_table));
  int16_t iat = ntc_lookup(iat_raw, iat_table, ARRAY_LEN(iat_table));
  uint32_t battery_mv = (uint32_t)battery_raw * 3300U * 57U / (4095U * 10U);

  sensors.tps_raw = tps_raw;
  sensors.tps_tenths = (uint16_t)smooth_i32(sensors.tps_tenths, tps, 1, 4);
  sensors.map_kpa_tenths = (uint16_t)smooth_i32(sensors.map_kpa_tenths, map_tenths, 1, 8);
  sensors.cht_c_tenths = (int16_t)smooth_i32(sensors.cht_c_tenths, cht, 1, 12);
  sensors.iat_c_tenths = (int16_t)smooth_i32(sensors.iat_c_tenths, iat, 1, 12);
  sensors.battery_mv = (uint16_t)smooth_i32(sensors.battery_mv, battery_mv, 1, 6);

  uint16_t direct_mv = (uint16_t)((uint32_t)o2_raw * 3300U / 4095U);
  if (cal.o2_mode == 0) {
    sensors.o2_mv = (uint16_t)smooth_i32(sensors.o2_mv, direct_mv, 1, 10);
    sensors.lambda_milli = 0;
    if (!engine_rpm || current_o2_heater_pct < 50) sensors.lambda_direction = 2;
    else if (sensors.o2_mv < 120) sensors.lambda_direction = 1;
    else if (sensors.o2_mv > 750) sensors.lambda_direction = -1;
    else sensors.lambda_direction = 0;
  } else {
    uint16_t controller_mv = (uint16_t)clamp_i32((int32_t)direct_mv * 3 / 2, 0, 5000);
    sensors.o2_mv = (uint16_t)smooth_i32(sensors.o2_mv, controller_mv, 1, 10);
    uint16_t span = cal.wideband_lambda_max_milli - cal.wideband_lambda_min_milli;
    sensors.lambda_milli = (uint16_t)(cal.wideband_lambda_min_milli +
        (uint32_t)sensors.o2_mv * span / 5000U);
    if (sensors.o2_mv < 50 || sensors.o2_mv > 4950) sensors.lambda_direction = 2;
    else if (sensors.lambda_milli < 980) sensors.lambda_direction = -1;
    else if (sensors.lambda_milli > 1020) sensors.lambda_direction = 1;
    else sensors.lambda_direction = 0;
  }
  if (sensors.lambda_direction == 2) fault_flags |= FAULT_O2_INVALID;
  else fault_flags &= (uint16_t)~FAULT_O2_INVALID;

  if (tps_raw < 15 || tps_raw > 4080 || map_raw < 15 || map_raw > 4080 ||
      cht_raw < 15 || cht_raw > 4080 || iat_raw < 15 || iat_raw > 4080)
    fault_flags |= FAULT_SENSOR;

  int32_t rise = (int32_t)sensors.tps_tenths - previous_tps_tenths;
  if (rise > 12) accel_enrich_permille = (uint16_t)clamp_i32(
      accel_enrich_permille + rise * 5 / 2, 1000, 1350);
  accel_enrich_permille = (uint16_t)(1000 +
      ((uint32_t)(accel_enrich_permille - 1000) * 920U / 1000U));
  previous_tps_tenths = sensors.tps_tenths;
}

typedef struct { uint8_t lo, hi; uint16_t fraction; } Bracket;

static Bracket bracket_value(uint16_t value, const uint16_t *bins, uint8_t count) {
  Bracket b = {0, 0, 0};
  if (value <= bins[0]) return b;
  if (value >= bins[count - 1]) { b.lo = b.hi = count - 1; return b; }
  for (uint8_t i = 0; i + 1U < count; ++i) {
    if (value <= bins[i + 1U]) {
      b.lo = i; b.hi = i + 1U;
      b.fraction = (uint16_t)(((uint32_t)(value - bins[i]) * 1000U) /
                             (bins[i + 1U] - bins[i]));
      return b;
    }
  }
  return b;
}

static int32_t lerp_i32(int32_t a, int32_t b, uint16_t fraction) {
  return a + (b - a) * fraction / 1000;
}

static uint16_t lookup_fuel(uint16_t rpm, uint16_t load) {
  Bracket x = bracket_value(rpm, rpm_bins, RPM_COUNT);
  Bracket y = bracket_value(load, load_bins, LOAD_COUNT);
  int32_t a = lerp_i32(cal.fuel_us[y.lo][x.lo], cal.fuel_us[y.lo][x.hi], x.fraction);
  int32_t b = lerp_i32(cal.fuel_us[y.hi][x.lo], cal.fuel_us[y.hi][x.hi], x.fraction);
  return (uint16_t)lerp_i32(a, b, y.fraction);
}

static int16_t lookup_ignition(uint16_t rpm, uint16_t load) {
  Bracket x = bracket_value(rpm, rpm_bins, RPM_COUNT);
  Bracket y = bracket_value(load, load_bins, LOAD_COUNT);
  int32_t a = lerp_i32(cal.ignition_tenths[y.lo][x.lo], cal.ignition_tenths[y.lo][x.hi], x.fraction);
  int32_t b = lerp_i32(cal.ignition_tenths[y.hi][x.lo], cal.ignition_tenths[y.hi][x.hi], x.fraction);
  return (int16_t)lerp_i32(a, b, y.fraction);
}

static uint16_t warmup_permille(int16_t cht) {
  static const int16_t t[] = {-100, 0, 200, 400, 600, 750};
  static const uint16_t f[] = {1450,1350,1200,1100,1030,1000};
  if (cht <= t[0]) return f[0];
  if (cht >= t[5]) return f[5];
  for (uint8_t i = 0; i < 5; ++i)
    if (cht <= t[i + 1]) return (uint16_t)(f[i] +
        (int32_t)(cht - t[i]) * (f[i + 1] - f[i]) / (t[i + 1] - t[i]));
  return 1000;
}

static uint16_t injector_deadtime(uint16_t mv) {
  static const uint16_t vb[] = {8000,9000,10000,11000,12000,13000,14000,15000,16000};
  static const uint16_t dt[] = {1951,1567,1277,1088,876,726,649,555,491};
  if (mv <= vb[0]) return dt[0];
  if (mv >= vb[8]) return dt[8];
  for (uint8_t i = 0; i < 8; ++i)
    if (mv <= vb[i + 1]) return (uint16_t)(dt[i] +
        (int32_t)(mv - vb[i]) * (dt[i + 1] - dt[i]) / 1000);
  return dt[8];
}

static uint16_t coil_dwell(uint16_t mv) {
  static const uint16_t vb[] = {8000,10000,12000,13800,14500,16000};
  static const uint16_t fp[] = {1500,1240,1120,1000,1000,940};
  uint16_t factor = fp[0];
  if (mv >= vb[5]) factor = fp[5];
  else for (uint8_t i = 0; i < 5; ++i) if (mv <= vb[i + 1]) {
    factor = (uint16_t)(fp[i] + (int32_t)(mv - vb[i]) *
        (fp[i + 1] - fp[i]) / (vb[i + 1] - vb[i])); break;
  }
  return (uint16_t)clamp_i32((uint32_t)cal.dwell_us * factor / 1000U, 1000, 2600);
}

static void prepare_realtime(void) {
  uint16_t rpm = engine_rpm;
  if (rpm > peak_rpm) peak_rpm = rpm;
  int16_t advance = fixed_ign_tenths >= 0 ? fixed_ign_tenths :
                    lookup_ignition(rpm, sensors.tps_tenths);
  if (rpm < 450) advance = 50;
  if (sensors.cht_c_tenths > 850) {
    int16_t retard = (int16_t)clamp_i32((sensors.cht_c_tenths - 850) * 3 / 10, 0, 70);
    advance -= retard; fault_flags |= FAULT_OVERHEAT;
  } else fault_flags &= (uint16_t)~FAULT_OVERHEAT;
  advance = (int16_t)clamp_i32(advance, 0, 300);

  int32_t pulse = (int32_t)lookup_fuel(rpm, sensors.tps_tenths) - cal.injector_deadtime_us;
  if (pulse < 0) pulse = 0;
  uint16_t warm = warmup_permille(sensors.cht_c_tenths);
  int32_t kelvin_milli = (int32_t)sensors.iat_c_tenths * 100 + 273150;
  uint16_t iat_factor = kelvin_milli > 0 ?
      (uint16_t)clamp_i32(293150000L / kelvin_milli, 880, 1180) : 1000;
  uint16_t baro_factor = (uint16_t)clamp_i32(
      (uint32_t)sensors.baro_kpa_tenths * 1000U / 1013U, 750, 1080);
  pulse = pulse * warm / 1000;
  pulse = pulse * iat_factor / 1000;
  pulse = pulse * baro_factor / 1000;
  pulse = pulse * accel_enrich_permille / 1000;
  pulse = pulse * cal.fuel_scale_permille / 1000;
  if (sensors.cht_c_tenths > 900) pulse = pulse * 1040 / 1000;
  pulse += injector_deadtime(sensors.battery_mv);
  pulse = clamp_i32(pulse, 500, 10000);

  prepared_advance_tenths = advance;
  prepared_trigger_tenths = (int16_t)(1700 - cal.trigger_trim_tenths);
  prepared_fuel_us = (uint16_t)pulse;
  prepared_dwell_us = coil_dwell(sensors.battery_mv);
  prepared_fuel_cut = (sensors.tps_tenths < 15 && rpm > 1800) || kill_active() ||
                      ((fault_flags & FAULT_SENSOR) && sensors.tps_tenths > 950);
  current_advance_tenths = advance;
  current_fuel_us = (uint16_t)pulse;
}

enum EventAction { EV_COIL1_ON, EV_COIL1_OFF, EV_COIL2_ON, EV_COIL2_OFF, EV_INJECTOR_OFF };
typedef struct { uint32_t time; uint8_t action, active; } TimedEvent;
static volatile TimedEvent events[EVENT_COUNT];

static void apply_action(uint8_t action) {
  if (action == EV_COIL1_ON) gpio_write(GPIOB, 0, 1);
  else if (action == EV_COIL1_OFF) gpio_write(GPIOB, 0, 0);
  else if (action == EV_COIL2_ON) gpio_write(GPIOB, 1, 1);
  else if (action == EV_COIL2_OFF) gpio_write(GPIOB, 1, 0);
  else if (action == EV_INJECTOR_OFF) gpio_write(GPIOB, 10, 0);
}

static void arm_next_event(void) {
  uint32_t now = TIM2->CNT, best_time = 0; int32_t best_delta = 0x7FFFFFFF;
  uint8_t found = 0;
  for (uint8_t i = 0; i < EVENT_COUNT; ++i) if (events[i].active) {
    int32_t delta = (int32_t)(events[i].time - now);
    if (delta < 3) delta = 3;
    if (!found || delta < best_delta) { found = 1; best_delta = delta; best_time = now + (uint32_t)delta; }
  }
  if (found) { TIM2->CCR1 = best_time; TIM2->DIER |= TIM_DIER_CC1IE; }
  else TIM2->DIER &= ~TIM_DIER_CC1IE;
}

static uint8_t queue_event(uint32_t delay_us, uint8_t action) {
  if (delay_us < 3) { apply_action(action); return 1; }
  uint32_t now = TIM2->CNT;
  for (uint8_t i = 0; i < EVENT_COUNT; ++i) if (!events[i].active) {
    events[i].time = now + delay_us; events[i].action = action; events[i].active = 1;
    arm_next_event(); return 1;
  }
  fault_flags |= FAULT_EVENT_OVERFLOW; return 0;
}

void TIM2_IRQHandler(void) {
  if (TIM2->SR & TIM_SR_CC1IF) {
    TIM2->SR &= ~TIM_SR_CC1IF;
    uint32_t now = TIM2->CNT;
    for (uint8_t i = 0; i < EVENT_COUNT; ++i) if (events[i].active &&
        (int32_t)(events[i].time - now) <= 2) {
      uint8_t action = events[i].action; events[i].active = 0; apply_action(action);
    }
    arm_next_event();
  }
}

static void clear_events_outputs(void) {
  irq_disable();
  for (uint8_t i = 0; i < EVENT_COUNT; ++i) events[i].active = 0;
  TIM2->DIER &= ~TIM_DIER_CC1IE;
  gpio_write(GPIOB, 0, 0); gpio_write(GPIOB, 1, 0); gpio_write(GPIOB, 10, 0);
  irq_enable();
}

static volatile uint32_t previous_tooth_us, normal_tooth_us;
static volatile uint8_t tooth_index = 255, cut_alternator;

static void schedule_cylinder(uint8_t cylinder, uint32_t revolution_us) {
  uint16_t rpm = engine_rpm; uint8_t cut = 0;
  if (rpm >= cal.hard_rev_limit) { cut = 1; fault_flags |= FAULT_REV_LIMIT; }
  else if (rpm >= cal.soft_rev_limit) { cut_alternator ^= 1U; cut = cut_alternator; fault_flags |= FAULT_REV_LIMIT; }
  else fault_flags &= (uint16_t)~FAULT_REV_LIMIT;
  if (kill_active()) cut = 1;
  uint8_t on = cylinder == 1 ? EV_COIL1_ON : EV_COIL2_ON;
  uint8_t off = cylinder == 1 ? EV_COIL1_OFF : EV_COIL2_OFF;
  if (cut) { apply_action(off); return; }

  int32_t angle_to_spark = prepared_trigger_tenths - prepared_advance_tenths;
  if (angle_to_spark < 50) angle_to_spark = 50;
  uint32_t spark_delay = revolution_us * (uint32_t)angle_to_spark / 3600U;
  if (spark_delay > prepared_dwell_us + 20U) queue_event(spark_delay - prepared_dwell_us, on);
  else { apply_action(on); fault_flags |= FAULT_DWELL_SHORT; }
  queue_event(spark_delay, off);

  if (!prepared_fuel_cut) {
    uint32_t pulse = prepared_fuel_us;
    uint32_t max_pulse = revolution_us * 85U / 200U;
    if (pulse > max_pulse) { pulse = max_pulse; fault_flags |= FAULT_PW_CLAMP; }
    gpio_write(GPIOB, 10, 1); queue_event(pulse, EV_INJECTOR_OFF);
  }
}

void EXTI9_5_IRQHandler(void) {
  if (!(EXTI->PR & (1UL << 5))) return;
  EXTI->PR = 1UL << 5;
  uint32_t now = TIM2->CNT;
  if (!previous_tooth_us) { previous_tooth_us = now; return; }
  uint32_t delta = now - previous_tooth_us; previous_tooth_us = now;
  if (delta < 50 || delta > 100000U) return;
  last_crank_edge_us = now;
  uint8_t gap = normal_tooth_us && delta > normal_tooth_us * 16U / 10U;
  if (gap) { tooth_index = 0; crank_synced = 1; }
  else {
    if (!normal_tooth_us) normal_tooth_us = delta;
    else normal_tooth_us = (normal_tooth_us * 7U + delta) / 8U;
    if (crank_synced) {
      if (tooth_index >= 34) { crank_synced = 0; tooth_index = 255; }
      else ++tooth_index;
    }
  }
  if (normal_tooth_us) {
    uint32_t rpm = 60000000U / (normal_tooth_us * 36U);
    engine_rpm = (uint16_t)(rpm > 12000U ? 12000U : rpm);
  }
  if (!actuator_test && crank_synced && (tooth_index == 0 || tooth_index == 18))
    schedule_cylinder(tooth_index == 0 ? 1 : 2, normal_tooth_us * 36U);
}

static const uint8_t iac_pattern[4][4] = {
  {1,0,0,0},{0,0,1,0},{0,1,0,0},{0,0,0,1}
};
static int16_t iac_position, iac_target;
static uint8_t iac_phase, iac_homed;
static uint16_t iac_homing_remaining;
static uint32_t last_iac_step_ms, last_iac_target_ms, o2_heater_start_ms;

static void apply_iac_phase(void) {
  gpio_write(GPIOB, 6, iac_pattern[iac_phase][0]);
  gpio_write(GPIOB, 7, iac_pattern[iac_phase][1]);
  gpio_write(GPIOB, 8, iac_pattern[iac_phase][2]);
  gpio_write(GPIOB, 9, iac_pattern[iac_phase][3]);
}

static void step_iac(int8_t logical_direction) {
  int8_t electrical = (int8_t)(logical_direction * cal.iac_direction);
  iac_phase = (uint8_t)((iac_phase + (electrical > 0 ? 1 : 3)) & 3U);
  apply_iac_phase();
  if (iac_homed) iac_position = (int16_t)clamp_i32(
      iac_position + logical_direction, 0, cal.iac_max_steps);
}

static const char *actuator_test_name(uint8_t test) {
  if (test == ACT_TEST_PUMP) return "PUMP";
  if (test == ACT_TEST_INJECTOR) return "INJECTOR";
  if (test == ACT_TEST_COIL1) return "COIL1";
  if (test == ACT_TEST_COIL2) return "COIL2";
  if (test == ACT_TEST_IAC_OPEN) return "IAC_OPEN";
  if (test == ACT_TEST_IAC_CLOSE) return "IAC_CLOSE";
  if (test == ACT_TEST_O2_HEATER) return "O2_HEATER";
  return "NONE";
}

static void print_test_event(SerialPort *port, const char *event, uint8_t test) {
  port_text(port, "TEST,"); port_text(port, event); port_char(port, ',');
  port_text(port, actuator_test_name(test)); port_text(port, "\r\n");
}

static void stop_actuator_test(uint8_t report_done) {
  uint8_t completed = actuator_test;
  actuator_test = ACT_TEST_NONE;
  clear_events_outputs();
  gpio_write(GPIOB, 11, 0); gpio_write(GPIOB, 15, 0);
  current_o2_heater_pct = 0;
  for (uint8_t p = 6; p <= 9; ++p) gpio_write(GPIOB, p, 0);
  gpio_write(GPIOA, 8, 0);
  actuator_test_steps = 0;
  if (report_done && completed != ACT_TEST_NONE) {
    print_test_event(&wire_port, "DONE", completed);
    print_test_event(&bt_port, "DONE", completed);
  }
}

static uint8_t start_actuator_test(const char *name) {
  if (!mutation_allowed()) return 0;
  stop_actuator_test(0);
  uint32_t now_ms = ms_ticks;
  if (str_eq(name, "PUMP")) {
    actuator_test = ACT_TEST_PUMP; actuator_test_deadline_ms = now_ms + 2000U;
    gpio_write(GPIOB, 11, 1);
  } else if (str_eq(name, "INJECTOR")) {
    actuator_test = ACT_TEST_INJECTOR; actuator_test_deadline_ms = now_ms + 50U;
    gpio_write(GPIOB, 10, 1);
    if (!queue_event(3000U, EV_INJECTOR_OFF)) { stop_actuator_test(0); return 0; }
  } else if (str_eq(name, "COIL1")) {
    actuator_test = ACT_TEST_COIL1; actuator_test_deadline_ms = now_ms + 50U;
    gpio_write(GPIOB, 0, 1);
    if (!queue_event(1000U, EV_COIL1_OFF)) { stop_actuator_test(0); return 0; }
  } else if (str_eq(name, "COIL2")) {
    actuator_test = ACT_TEST_COIL2; actuator_test_deadline_ms = now_ms + 50U;
    gpio_write(GPIOB, 1, 1);
    if (!queue_event(1000U, EV_COIL2_OFF)) { stop_actuator_test(0); return 0; }
  } else if (str_eq(name, "IAC_OPEN") || str_eq(name, "IAC_CLOSE")) {
    if (!gpio_read(GPIOC, 13)) return 0;
    actuator_test = str_eq(name, "IAC_OPEN") ? ACT_TEST_IAC_OPEN : ACT_TEST_IAC_CLOSE;
    actuator_test_steps = 20U; actuator_test_next_ms = now_ms;
    actuator_test_deadline_ms = now_ms + 500U; gpio_write(GPIOA, 8, 1);
  } else if (str_eq(name, "O2_HEATER")) {
    actuator_test = ACT_TEST_O2_HEATER; actuator_test_deadline_ms = now_ms + 2000U;
    current_o2_heater_pct = 20U;
  } else return 0;
  return 1;
}

static void service_actuator_test(uint32_t now_ms) {
  uint8_t test = actuator_test;
  if (test == ACT_TEST_NONE) return;
  if (!mutation_allowed() || kill_active()) { stop_actuator_test(1); return; }
  if ((int32_t)(now_ms - actuator_test_deadline_ms) >= 0) {
    stop_actuator_test(1); return;
  }
  if (test == ACT_TEST_PUMP) gpio_write(GPIOB, 11, 1);
  else if (test == ACT_TEST_O2_HEATER) {
    current_o2_heater_pct = 20U;
    gpio_write(GPIOB, 15, (now_ms % 100U) < 20U);
  } else if ((test == ACT_TEST_IAC_OPEN || test == ACT_TEST_IAC_CLOSE) &&
             actuator_test_steps && (int32_t)(now_ms - actuator_test_next_ms) >= 0) {
    actuator_test_next_ms = now_ms + 5U;
    step_iac(test == ACT_TEST_IAC_OPEN ? 1 : -1);
    if (--actuator_test_steps == 0U) stop_actuator_test(1);
  }
}

static void update_iac(uint32_t now_ms, uint16_t rpm) {
  if (!gpio_read(GPIOC, 13)) {
    fault_flags |= FAULT_IAC_DRIVER; gpio_write(GPIOA, 8, 0); return;
  }
  fault_flags &= (uint16_t)~FAULT_IAC_DRIVER; gpio_write(GPIOA, 8, 1);
  if (now_ms - last_iac_step_ms < 4U) return;
  last_iac_step_ms = now_ms;
  if (!iac_homed) {
    if (iac_homing_remaining) { step_iac(-1); --iac_homing_remaining; return; }
    iac_homed = 1; iac_position = 0; iac_target = (int16_t)cal.iac_crank_steps;
  }
  if (now_ms - last_iac_target_ms >= 50U) {
    last_iac_target_ms = now_ms;
    if (kill_active()) iac_target = 0;
    else if (rpm < 450) iac_target = (int16_t)cal.iac_crank_steps;
    else if (sensors.tps_tenths >= 30) iac_target = 0;
    else {
      int16_t cold_extra = (int16_t)clamp_i32((500 - sensors.cht_c_tenths) * 8 / 100, 0, 50);
      int16_t rpm_correction = (int16_t)clamp_i32(((int32_t)cal.iac_target_rpm - rpm) / 25, -20, 45);
      iac_target = (int16_t)clamp_i32(cal.iac_hot_steps + cold_extra + rpm_correction,
                                     0, cal.iac_max_steps);
    }
  }
  if (iac_position < iac_target) step_iac(1);
  else if (iac_position > iac_target) step_iac(-1);
}

static void update_o2_heater(uint32_t now_ms, uint16_t rpm, uint8_t sync) {
  uint8_t enabled = cal.o2_mode == 0 && sync && rpm >= 450 && !kill_active() &&
                    sensors.battery_mv >= 9000 && sensors.battery_mv <= 16500;
  if (!enabled) {
    current_o2_heater_pct = 0; o2_heater_start_ms = 0; gpio_write(GPIOB, 15, 0); return;
  }
  if (!o2_heater_start_ms) o2_heater_start_ms = now_ms;
  uint32_t elapsed = now_ms - o2_heater_start_ms;
  uint8_t requested = cal.o2_heater_duty_pct;
  if (elapsed < 2000U && requested > 20) requested = 20;
  else if (elapsed < 7000U) {
    uint8_t ramp = (uint8_t)(20U + (elapsed - 2000U) * 50U / 5000U);
    if (requested > ramp) requested = ramp;
  }
  current_o2_heater_pct = requested;
  gpio_write(GPIOB, 15, (now_ms % 100U) < requested);
}

static uint8_t str_eq(const char *a, const char *b) {
  while (*a && *b && *a == *b) { ++a; ++b; }
  return *a == 0 && *b == 0;
}

static int32_t parse_i32(const char *text) {
  int32_t sign = 1, value = 0;
  if (*text == '-') { sign = -1; ++text; }
  while (*text >= '0' && *text <= '9') value = value * 10 + (*text++ - '0');
  return value * sign;
}

static uint8_t split_tokens(char *line, char **tokens, uint8_t max_tokens) {
  uint8_t count = 0;
  while (*line && count < max_tokens) {
    while (*line == ' ') ++line;
    if (!*line) break;
    tokens[count++] = line;
    while (*line && *line != ' ') ++line;
    if (*line) *line++ = 0;
  }
  return count;
}

static uint8_t mutation_allowed(void) {
  return service_jumper() && engine_rpm == 0 && !crank_synced;
}

static uint16_t injector_duty_tenths(void) {
  uint16_t rpm = engine_rpm;
  if (!rpm || current_fuel_us <= injector_deadtime(sensors.battery_mv)) return 0;
  uint32_t period = 30000000U / rpm;
  return (uint16_t)clamp_i32((uint32_t)(current_fuel_us - injector_deadtime(sensors.battery_mv)) *
                             1000U / period, 0, 1000);
}

static void print_status(SerialPort *port) {
  port_text(port, "T");
  port_csv_u32(port, engine_rpm); port_csv_u32(port, sensors.tps_tenths);
  port_csv_u32(port, sensors.map_kpa_tenths); port_csv_i32(port, sensors.cht_c_tenths);
  port_csv_i32(port, sensors.iat_c_tenths); port_csv_u32(port, sensors.battery_mv);
  port_csv_u32(port, sensors.o2_mv); port_csv_u32(port, sensors.lambda_milli);
  port_csv_i32(port, sensors.lambda_direction); port_csv_u32(port, current_fuel_us);
  port_csv_i32(port, current_advance_tenths); port_csv_u32(port, crank_synced);
  port_csv_u32(port, fault_flags); port_csv_u32(port, bluetooth_connected());
  port_csv_u32(port, mutation_allowed()); port_csv_u32(port, peak_rpm);
  port_csv_i32(port, iac_position); port_csv_i32(port, iac_target);
  port_csv_u32(port, current_o2_heater_pct); port_csv_u32(port, injector_duty_tenths());
  port_csv_u32(port, 0U); /* native USB disabled in this build */
  port_csv_u32(port, actuator_test);
  /* v0.8 diagnostics are appended to preserve compatibility with v0.7 clients. */
  port_csv_u32(port, kill_active());
  port_csv_u32(port, ms_ticks);
  port_csv_u32(port, sensors.tps_raw);
  port_csv_u32(port, sensors.baro_kpa_tenths);
  port_csv_u32(port, prepared_dwell_us);
  port_csv_u32(port, accel_enrich_permille);
  port_csv_u32(port, normal_tooth_us);
  port_csv_u32(port, tooth_index);
  port_csv_u32(port, prepared_fuel_cut);
  port_csv_u32(port, clock_pll_ok);
  uint32_t output_mask = 0;
  if (gpio_read(GPIOB, 0)) output_mask |= 1U << 0;
  if (gpio_read(GPIOB, 1)) output_mask |= 1U << 1;
  if (gpio_read(GPIOB, 10)) output_mask |= 1U << 2;
  if (gpio_read(GPIOB, 11)) output_mask |= 1U << 3;
  if (gpio_read(GPIOB, 15)) output_mask |= 1U << 4;
  if (gpio_read(GPIOA, 8)) output_mask |= 1U << 5;
  port_csv_u32(port, output_mask);
  port_text(port, "\r\n");
}

static void print_maps(SerialPort *port) {
  port_text(port, "R"); for (uint8_t i = 0; i < RPM_COUNT; ++i) port_csv_u32(port, rpm_bins[i]);
  port_text(port, "\r\nL"); for (uint8_t i = 0; i < LOAD_COUNT; ++i) port_csv_u32(port, load_bins[i]);
  port_text(port, "\r\n");
  for (uint8_t r = 0; r < LOAD_COUNT; ++r) {
    port_text(port, "F,"); port_u32(port, r);
    for (uint8_t c = 0; c < RPM_COUNT; ++c) port_csv_u32(port, cal.fuel_us[r][c]);
    port_text(port, "\r\n");
  }
  for (uint8_t r = 0; r < LOAD_COUNT; ++r) {
    port_text(port, "I,"); port_u32(port, r);
    for (uint8_t c = 0; c < RPM_COUNT; ++c) port_csv_i32(port, cal.ignition_tenths[r][c]);
    port_text(port, "\r\n");
  }
  port_line(port, "END");
}

static void print_param(SerialPort *p, const char *name, int32_t value) {
  port_text(p, "P,"); port_text(p, name); port_char(p, ','); port_i32(p, value); port_text(p, "\r\n");
}

static void print_params(SerialPort *p) {
  print_param(p,"trigger_trim_tenths",cal.trigger_trim_tenths);
  print_param(p,"dwell_us",cal.dwell_us); print_param(p,"injector_deadtime_us",cal.injector_deadtime_us);
  print_param(p,"tps_min_raw",cal.tps_min_raw); print_param(p,"tps_max_raw",cal.tps_max_raw);
  print_param(p,"fuel_scale_permille",cal.fuel_scale_permille);
  print_param(p,"rev_limit_soft",cal.soft_rev_limit); print_param(p,"rev_limit_hard",cal.hard_rev_limit);
  print_param(p,"iac_max_steps",cal.iac_max_steps); print_param(p,"iac_crank_steps",cal.iac_crank_steps);
  print_param(p,"iac_hot_steps",cal.iac_hot_steps); print_param(p,"iac_target_rpm",cal.iac_target_rpm);
  print_param(p,"iac_direction",cal.iac_direction); print_param(p,"o2_heater_duty_pct",cal.o2_heater_duty_pct);
  print_param(p,"o2_mode",cal.o2_mode); print_param(p,"wideband_lambda_min_milli",cal.wideband_lambda_min_milli);
  print_param(p,"wideband_lambda_max_milli",cal.wideband_lambda_max_milli);
  print_param(p,"fixed_ign_tenths",fixed_ign_tenths); port_line(p,"END");
}

static uint8_t set_parameter(const char *name, int32_t value) {
  if (str_eq(name,"trigger_trim_tenths")) cal.trigger_trim_tenths = (int16_t)clamp_i32(value,-100,100);
  else if (str_eq(name,"dwell_us")) cal.dwell_us = (uint16_t)clamp_i32(value,1000,2600);
  else if (str_eq(name,"injector_deadtime_us")) cal.injector_deadtime_us=(uint16_t)clamp_i32(value,450,2200);
  else if (str_eq(name,"tps_min_raw")) cal.tps_min_raw=(uint16_t)clamp_i32(value,0,3500);
  else if (str_eq(name,"tps_max_raw")) cal.tps_max_raw=(uint16_t)clamp_i32(value,400,4095);
  else if (str_eq(name,"fuel_scale_permille")) cal.fuel_scale_permille=(uint16_t)clamp_i32(value,700,1300);
  else if (str_eq(name,"rev_limit_soft")) { cal.soft_rev_limit=(uint16_t)clamp_i32(value,5500,8500); if(cal.hard_rev_limit<cal.soft_rev_limit+100)cal.hard_rev_limit=cal.soft_rev_limit+100; }
  else if (str_eq(name,"rev_limit_hard")) { cal.hard_rev_limit=(uint16_t)clamp_i32(value,5700,9000); if(cal.hard_rev_limit<cal.soft_rev_limit+100)cal.hard_rev_limit=cal.soft_rev_limit+100; }
  else if (str_eq(name,"iac_max_steps")) { cal.iac_max_steps=(uint16_t)clamp_i32(value,60,300); if(cal.iac_crank_steps>cal.iac_max_steps)cal.iac_crank_steps=cal.iac_max_steps; if(cal.iac_hot_steps>cal.iac_max_steps)cal.iac_hot_steps=cal.iac_max_steps; }
  else if (str_eq(name,"iac_crank_steps")) cal.iac_crank_steps=(uint16_t)clamp_i32(value,0,cal.iac_max_steps);
  else if (str_eq(name,"iac_hot_steps")) cal.iac_hot_steps=(uint16_t)clamp_i32(value,0,cal.iac_max_steps);
  else if (str_eq(name,"iac_target_rpm")) cal.iac_target_rpm=(uint16_t)clamp_i32(value,800,1600);
  else if (str_eq(name,"iac_direction")) cal.iac_direction=value<0?-1:1;
  else if (str_eq(name,"o2_heater_duty_pct")) cal.o2_heater_duty_pct=(uint8_t)clamp_i32(value,0,70);
  else if (str_eq(name,"o2_mode")) cal.o2_mode=value?1:0;
  else if (str_eq(name,"wideband_lambda_min_milli")) cal.wideband_lambda_min_milli=(uint16_t)clamp_i32(value,500,1000);
  else if (str_eq(name,"wideband_lambda_max_milli")) cal.wideband_lambda_max_milli=(uint16_t)clamp_i32(value,1000,2000);
  else if (str_eq(name,"fixed_ign_tenths")) fixed_ign_tenths=value<0?-1:(int16_t)clamp_i32(value,0,300);
  else return 0;
  return 1;
}

static void process_command(SerialPort *port, char *line) {
  char *t[6]; uint8_t n = split_tokens(line,t,6); if(!n)return;
  if (str_eq(t[0],"PING")) { port_text(port,"OK,VIKHR30_STM32,"); port_text(port,FW_VERSION); port_text(port,"\r\n"); }
  else if (str_eq(t[0],"GET") && n>=2) {
    if(str_eq(t[1],"STATUS"))print_status(port); else if(str_eq(t[1],"MAPS"))print_maps(port);
    else if(str_eq(t[1],"PARAMS"))print_params(port);
    else if(str_eq(t[1],"INFO"))port_line(port,"INFO,STM32F103C6T6A,BAREMETAL,USART1,HC06,ACTUATOR_TEST,FULL_DIAG,36-1,1700,BOSCH0280158117,DRV8843,VBG08H");
    else port_line(port,"ERR,bad_get");
  } else if (str_eq(t[0],"SET")) {
    if(!mutation_allowed()){port_line(port,"ERR,service_lock");return;}
    if(n>=5&&(str_eq(t[1],"FUEL")||str_eq(t[1],"IGN"))){
      int32_t r=parse_i32(t[2]),c=parse_i32(t[3]),v=parse_i32(t[4]);
      if(r<0||r>=LOAD_COUNT||c<0||c>=RPM_COUNT){port_line(port,"ERR,index");return;}
      if(str_eq(t[1],"FUEL"))cal.fuel_us[r][c]=(uint16_t)clamp_i32(v,500,10000);
      else cal.ignition_tenths[r][c]=(int16_t)clamp_i32(v,0,300);
      port_line(port,"OK");
    } else if(n>=4&&str_eq(t[1],"PARAM")) {
      if(set_parameter(t[2],parse_i32(t[3])))port_line(port,"OK"); else port_line(port,"ERR,unknown_parameter");
    } else port_line(port,"ERR,bad_set");
  } else if(str_eq(t[0],"SAVE")) {
    if(!mutation_allowed())port_line(port,"ERR,service_lock");
    else if(save_calibration())port_line(port,"OK,SAVED"); else port_line(port,"ERR,flash");
  } else if(str_eq(t[0],"DEFAULTS")) {
    if(!mutation_allowed())port_line(port,"ERR,service_lock"); else{load_defaults();port_line(port,"OK,DEFAULTS_RAM");}
  } else if(str_eq(t[0],"HOMEIAC")) {
    if(!mutation_allowed())port_line(port,"ERR,service_lock"); else{iac_homed=0;iac_homing_remaining=cal.iac_max_steps+40;port_line(port,"OK,IAC_HOMING");}
  } else if(str_eq(t[0],"TEST")&&n>=2) {
    if(str_eq(t[1],"STOP")){stop_actuator_test(1);port_line(port,"OK,TEST,STOP");}
    else if(!mutation_allowed())port_line(port,"ERR,service_lock");
    else if(start_actuator_test(t[1])){port_text(port,"OK,TEST,");port_line(port,t[1]);}
    else port_line(port,"ERR,bad_test");
  } else if(str_eq(t[0],"STREAM")&&n>=2){stream_hz=(uint8_t)clamp_i32(parse_i32(t[1]),0,20);port_line(port,"OK");}
  else if(str_eq(t[0],"CLEARFAULTS")){fault_flags=0;peak_rpm=0;port_line(port,"OK");}
  else port_line(port,"ERR,unknown_command");
}

static void service_port(SerialPort *port) {
  while (port->tail != port->head) {
    char ch = port->rx[port->tail]; port->tail = (uint16_t)((port->tail + 1U) & (RX_SIZE - 1U));
    if (ch=='\n'||ch=='\r') {
      if(port->line_len){port->line[port->line_len]=0;process_command(port,port->line);port->line_len=0;}
    } else if(port->line_len<LINE_SIZE-1U)port->line[port->line_len++]=ch;
    else{port->line_len=0;port_line(port,"ERR,line_too_long");}
  }
}

static void hardware_init(void) {
  clock_init();
  RCC->APB2ENR |= (1UL<<0)|(1UL<<2)|(1UL<<3)|(1UL<<4)|(1UL<<9)|(1UL<<14);
  RCC->APB1ENR |= (1UL<<0)|(1UL<<17);
  /* Analog inputs PA0,1,4,5,6,7. */
  gpio_config(GPIOA,0,0);gpio_config(GPIOA,1,0);gpio_config(GPIOA,4,0);
  gpio_config(GPIOA,5,0);gpio_config(GPIOA,6,0);gpio_config(GPIOA,7,0);
  /* Outputs: ignition, IAC, injector, pump, heater, IAC sleep. */
  gpio_config(GPIOB,0,2);gpio_config(GPIOB,1,2);gpio_config(GPIOB,6,2);gpio_config(GPIOB,7,2);
  gpio_config(GPIOB,8,2);gpio_config(GPIOB,9,2);gpio_config(GPIOB,10,2);gpio_config(GPIOB,11,2);
  gpio_config(GPIOB,15,2);gpio_config(GPIOA,8,2);
  /* Pull-up inputs crank, kill, service and IAC fault; pull-down BT state. */
  gpio_config(GPIOB,5,8);GPIOB->ODR|=1UL<<5;
  gpio_config(GPIOB,12,8);GPIOB->ODR|=1UL<<12;
  gpio_config(GPIOB,13,8);GPIOB->ODR|=1UL<<13;
  gpio_config(GPIOB,14,8);GPIOB->ODR&=~(1UL<<14);
  gpio_config(GPIOC,13,8);GPIOC->ODR|=1UL<<13;
  gpio_write(GPIOB,0,0);gpio_write(GPIOB,1,0);gpio_write(GPIOB,10,0);gpio_write(GPIOB,11,0);
  gpio_write(GPIOB,15,0);gpio_write(GPIOA,8,0);
  for(uint8_t p=6;p<=9;++p)gpio_write(GPIOB,p,0);
  /* TIM2 free-running at 1 MHz. */
  TIM2->PSC=core_clock_hz/1000000U-1U;TIM2->ARR=0xFFFFFFFFUL;TIM2->EGR=1;TIM2->CR1=1;
  NVIC_IPR[28]=0x20;NVIC_ISER0=1UL<<28;
  /* EXTI5 routed to PB5, rising edge. */
  AFIO->EXTICR[1]=(AFIO->EXTICR[1]&~(0xFUL<<4))|(1UL<<4);
  EXTI->IMR|=1UL<<5;EXTI->RTSR|=1UL<<5;EXTI->FTSR&=~(1UL<<5);EXTI->PR=1UL<<5;
  NVIC_IPR[23]=0x10;NVIC_ISER0=1UL<<23;
  uart_init();systick_init();
  port_line(&wire_port,clock_pll_ok?"BOOTSTAGE,UART_READY,HSI_PLL64":"BOOTSTAGE,UART_READY,HSI8_FALLBACK");
  port_line(&bt_port,clock_pll_ok?"BOOTSTAGE,UART_READY,HSI_PLL64":"BOOTSTAGE,UART_READY,HSI8_FALLBACK");
  adc_init();
  port_line(&wire_port,"BOOTSTAGE,HW_READY");
  port_line(&bt_port,"BOOTSTAGE,HW_READY");
}

int main(void) {
  hardware_init();
  uint8_t calibration_ok = load_calibration();
  iac_homing_remaining = cal.iac_max_steps + 40;
  for(uint8_t i=0;i<16;++i)read_sensors();
  sensors.baro_kpa_tenths=sensors.map_kpa_tenths;
  if(!kill_active())gpio_write(GPIOB,11,1);
  port_text(&wire_port,"BOOT,VIKHR30_STM32,");port_text(&wire_port,FW_VERSION);port_char(&wire_port,',');port_line(&wire_port,calibration_ok?"FLASH":"DEFAULTS");
  port_text(&bt_port,"BOOT,VIKHR30_STM32,");port_text(&bt_port,FW_VERSION);port_char(&bt_port,',');port_line(&bt_port,calibration_ok?"FLASH":"DEFAULTS");
  watchdog_init();
  for(;;){
    IWDG->KR=0xAAAAU;
    uint32_t now_ms=ms_ticks,now_us=TIM2->CNT;
    service_port(&wire_port);service_port(&bt_port);
    if(now_ms-last_sensor_ms>=10U){last_sensor_ms=now_ms;read_sensors();prepare_realtime();}
    uint16_t rpm=engine_rpm;uint8_t sync=crank_synced;uint32_t edge=last_crank_edge_us;
    if(edge&&(uint32_t)(now_us-edge)>250000U&&(sync||rpm)){
      irq_disable();crank_synced=0;engine_rpm=0;tooth_index=255;irq_enable();
      fault_flags|=FAULT_SYNC_LOSS;clear_events_outputs();rpm=0;sync=0;
    }
    if(actuator_test!=ACT_TEST_IAC_OPEN&&actuator_test!=ACT_TEST_IAC_CLOSE)update_iac(now_ms,rpm);
    if(actuator_test!=ACT_TEST_O2_HEATER)update_o2_heater(now_ms,rpm,sync);
    if(kill_active()){stop_actuator_test(1);gpio_write(GPIOB,11,0);clear_events_outputs();}
    else if(actuator_test==ACT_TEST_PUMP){}
    else if(now_ms<2000U||(edge&&(uint32_t)(now_us-edge)<1000000U))gpio_write(GPIOB,11,1);
    else gpio_write(GPIOB,11,0);
    service_actuator_test(now_ms);
    if(stream_hz&&now_ms-last_stream_ms>=1000U/stream_hz){last_stream_ms=now_ms;print_status(&wire_port);print_status(&bt_port);}
  }
}
