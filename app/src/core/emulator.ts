// Эмулятор ECU: модель прошивки v0.8 на уровне протокола и упрощённая модель
// двигателя. Используется для демо-режима и автотестов без железа.
import { clamp, coilDwell, injectorDeadtime, lookupMap, warmupPermille } from './calc';
import type { Transport } from './protocol';
import { ACTUATOR_TESTS, DEFAULT_FUEL, DEFAULT_IGN, FUEL_LIMITS, IGN_LIMITS, LOAD_BINS, LOAD_COUNT, PARAMS, RPM_BINS, RPM_COUNT, type MapTable } from './types';

export const EMU_FW_VERSION = '0.8.0-C6-BT-DIAG';

interface Cal { fuel: MapTable; ign: MapTable; p: Record<string, number> }

function defaults(): Cal {
  const p: Record<string, number> = {};
  for (const d of PARAMS) if (!d.volatile) p[d.key] = d.def;
  return { fuel: DEFAULT_FUEL.map((r) => r.slice()), ign: DEFAULT_IGN.map((r) => r.slice()), p };
}
const copyCal = (c: Cal): Cal => ({ fuel: c.fuel.map((r) => r.slice()), ign: c.ign.map((r) => r.slice()), p: { ...c.p } });

/** То, чем управляет человек в демо-режиме (и тесты). */
export interface EmuInputs {
  /** Стартер/двигатель: true — двигатель крутится. */
  running: boolean;
  /** Положение дросселя 0..1. */
  throttle: number;
  /** Перемычка SERVICE замкнута. */
  service: boolean;
  /** Аварийная чека выдернута (STOP). */
  kill: boolean;
  /** Драйвер РХХ исправен (PC13 = 1). */
  iacDriverOk: boolean;
  /** Напряжение АКБ на стоянке, мВ. */
  batteryMv: number;
  /** Температура воздуха, °C. */
  ambientC: number;
}

/** Помехи в канале для тестов надёжности. Вероятности 0..1 на строку. */
export interface EmuNoise { dropToEcu: number; corruptToEcu: number; dropFromEcu: number; corruptFromEcu: number }

export class EcuEmulator implements Transport {
  onData: ((chunk: string) => void) | null = null;
  onClose: (() => void) | null = null;
  inputs: EmuInputs = { running: false, throttle: 0, service: true, kill: false, iacDriverOk: true, batteryMv: 12600, ambientC: 20 };
  noise: EmuNoise = { dropToEcu: 0, corruptToEcu: 0, dropFromEcu: 0, corruptFromEcu: 0 };
  /** Моделировать 256-байтный буфер приёма и скорость 115200 бод, как в железе. */
  realisticUart = true;
  /** Что сохранено «во Flash». */
  flash: Cal = defaults();
  cal: Cal = defaults();
  /**
   * «Обрыв провода»: порт остаётся открытым, но ECU ничего не слышит и ничего не передаёт
   * (модель двигателя продолжает работать). Для проверки состояния «Нет ответа ECU».
   */
  silent = false;
  /** Счётчик потерянных из-за переполнения буфера байтов. */
  rxOverflowBytes = 0;

  private fixedIgn = -1;
  private streamHz = 10;
  private rxWire = '';       // байты «в проводе» к ECU
  private rxRing = '';       // буфер приёма ECU (до 255 байт)
  private lineBuf = '';
  private stallMs = 0;       // основной цикл занят передачей телеметрии
  private nowMs = 0;
  private lastStreamMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReal = 0;
  private closed = false;
  private rand: () => number;

  // состояние «двигателя» и датчиков
  private rpm = 0;
  private sync = 0;
  private tps10 = 0;
  private map10 = 1013;
  private cht10 = 200;
  private iat10 = 200;
  private battMv = 12600;
  private o2Mv = 450;
  private lambdaDir = 2;
  private lambdaMilli = 0;
  private flags = 0;
  private peak = 0;
  private iacPos = 0;
  private iacTarget = 0;
  private iacHomed = false;
  private iacHoming = 0;
  private heater = 0;
  private heaterStart = -1;
  private accel = 1000;
  private prevTps = 0;
  private test = 0;
  private testDeadline = 0;
  private testSteps = 0;
  private pwUs = 1600;
  private adv10 = 50;
  private fuelCut = 0;
  private crank = 0;         // фаза коленвала, обороты
  private o2Phase = 0;
  private everRan = false;

  constructor(opts: { seed?: number; autoRun?: boolean } = {}) {
    let s = opts.seed ?? 12345;
    this.rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    this.boot();
    if (opts.autoRun !== false) this.start();
  }

  /** Запустить ход времени в реальном масштабе. */
  start() {
    if (this.timer) return;
    this.lastReal = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now(), dt = Math.min(200, now - this.lastReal);
      this.lastReal = now;
      this.step(dt);
    }, 5);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
  }

  /** Имитация обрыва связи (выдернули кабель). */
  unplug() { this.close(); this.onClose?.(); }

  write(data: string) {
    if (this.closed) throw new Error('closed');
    if (this.silent) return;
    this.rxWire += data;
  }

  /** Перезапуск питания: RAM-калибровки заменяются сохранёнными во Flash. */
  boot() {
    this.cal = copyCal(this.flash);
    this.fixedIgn = -1;
    this.streamHz = 10;
    this.nowMs = 0; this.lastStreamMs = 0;
    this.iacHomed = false; this.iacHoming = this.cal.p.iac_max_steps + 40;
    this.flags = 0; this.peak = 0; this.test = 0;
    this.send('BOOTSTAGE,UART_READY,HSI_PLL64');
    this.send('BOOTSTAGE,HW_READY');
    this.send(`BOOT,VIKHR30_STM32,${EMU_FW_VERSION},FLASH`);
  }

  /** Продвинуть модель на dt миллисекунд. */
  step(dtMs: number) {
    if (this.closed) return;
    let left = dtMs;
    while (left > 0) {
      const d = Math.min(5, left);
      left -= d;
      this.nowMs += d;
      this.deliver(d);
      this.physics(d);
      if (this.stallMs > 0) { this.stallMs -= d; continue; }
      this.serviceRx();
      this.serviceTest();
      if (this.streamHz && this.nowMs - this.lastStreamMs >= 1000 / this.streamHz) {
        this.lastStreamMs = this.nowMs;
        const status = this.statusLine();
        this.send(status);
        // прошивка передаёт строку блокирующе в оба порта (USART1 и USART2): 10 бит на байт при 115200 бод
        if (this.realisticUart) this.stallMs = ((status.length + 2) * 2 * 10) / 115.2;
      }
    }
  }

  private deliver(dtMs: number) {
    if (!this.rxWire) return;
    const n = this.realisticUart ? Math.max(1, Math.round(dtMs * 11.52)) : this.rxWire.length;
    const part = this.rxWire.slice(0, n);
    this.rxWire = this.rxWire.slice(n);
    const room = this.realisticUart ? 255 - this.rxRing.length : Infinity;
    if (part.length > room) this.rxOverflowBytes += part.length - room;
    this.rxRing += part.slice(0, Math.max(0, room));
  }

  private serviceRx() {
    const data = this.rxRing;
    this.rxRing = '';
    for (const ch of data) {
      if (ch === '\n' || ch === '\r') {
        if (this.lineBuf.length) {
          let line = this.lineBuf;
          this.lineBuf = '';
          if (this.rand() < this.noise.dropToEcu) continue;
          if (this.rand() < this.noise.corruptToEcu) line = this.corrupt(line);
          this.command(line);
        }
      } else if (this.lineBuf.length < 191) this.lineBuf += ch;
      else { this.lineBuf = ''; this.send('ERR,line_too_long'); }
    }
  }

  private corrupt(line: string): string {
    const i = Math.floor(this.rand() * line.length);
    const pool = '0123456789 ,XQ';
    return line.slice(0, i) + pool[Math.floor(this.rand() * pool.length)] + line.slice(i + 1);
  }

  private send(line: string) {
    if (this.silent) return;
    if (this.rand() < this.noise.dropFromEcu) return;
    if (this.rand() < this.noise.corruptFromEcu) line = this.corrupt(line);
    const out = line + '\r\n';
    // отдаём асинхронно и двумя кусками, как приходит из настоящего порта
    const cut = Math.floor(out.length / 2);
    queueMicrotask(() => { if (!this.closed) { this.onData?.(out.slice(0, cut)); this.onData?.(out.slice(cut)); } });
  }

  private mutationAllowed(): boolean {
    return this.inputs.service && this.rpm === 0 && !this.sync;
  }

  private command(line: string) {
    const t = line.trim().split(/[ ,]+/).filter(Boolean);
    if (!t.length) return;
    const int = (s: string | undefined) => { const v = parseInt(s ?? '', 10); return Number.isFinite(v) ? v : 0; };
    const c = this.cal;
    if (t[0] === 'PING') return this.send(`OK,VIKHR30_STM32,${EMU_FW_VERSION}`);
    if (t[0] === 'GET' && t.length >= 2) {
      if (t[1] === 'STATUS') return this.send(this.statusLine());
      if (t[1] === 'MAPS') {
        this.send('R,' + RPM_BINS.join(','));
        this.send('L,' + LOAD_BINS.join(','));
        for (let r = 0; r < LOAD_COUNT; r++) this.send(`F,${r},` + c.fuel[r].join(','));
        for (let r = 0; r < LOAD_COUNT; r++) this.send(`I,${r},` + c.ign[r].join(','));
        return this.send('END');
      }
      if (t[1] === 'PARAMS') {
        for (const d of PARAMS) this.send(`P,${d.key},${d.volatile ? this.fixedIgn : c.p[d.key]}`);
        return this.send('END');
      }
      if (t[1] === 'INFO') return this.send('INFO,STM32F103C6T6A,BAREMETAL,USART1,HC06,ACTUATOR_TEST,FULL_DIAG,36-1,1700,BOSCH0280158117');
      return this.send('ERR,bad_get');
    }
    if (t[0] === 'SET') {
      if (!this.mutationAllowed()) return this.send('ERR,service_lock');
      if (t.length >= 5 && (t[1] === 'FUEL' || t[1] === 'IGN')) {
        const r = int(t[2]), col = int(t[3]), v = int(t[4]);
        if (r < 0 || r >= LOAD_COUNT || col < 0 || col >= RPM_COUNT) return this.send('ERR,index');
        if (t[1] === 'FUEL') c.fuel[r][col] = clamp(v, FUEL_LIMITS.min, FUEL_LIMITS.max);
        else c.ign[r][col] = clamp(v, IGN_LIMITS.min, IGN_LIMITS.max);
        return this.send('OK');
      }
      if (t.length >= 4 && t[1] === 'PARAM') return this.send(this.setParam(t[2], int(t[3])) ? 'OK' : 'ERR,unknown_parameter');
      return this.send('ERR,bad_set');
    }
    if (t[0] === 'SAVE') {
      if (!this.mutationAllowed()) return this.send('ERR,service_lock');
      this.flash = copyCal(c);
      return this.send('OK,SAVED');
    }
    if (t[0] === 'DEFAULTS') {
      if (!this.mutationAllowed()) return this.send('ERR,service_lock');
      this.cal = defaults();
      return this.send('OK,DEFAULTS_RAM');
    }
    if (t[0] === 'HOMEIAC') {
      if (!this.mutationAllowed()) return this.send('ERR,service_lock');
      this.iacHomed = false; this.iacHoming = c.p.iac_max_steps + 40;
      return this.send('OK,IAC_HOMING');
    }
    if (t[0] === 'TEST' && t.length >= 2) {
      if (t[1] === 'STOP') { this.stopTest(true); return this.send('OK,TEST,STOP'); }
      if (!this.mutationAllowed()) return this.send('ERR,service_lock');
      return this.send(this.startTest(t[1]) ? `OK,TEST,${t[1]}` : 'ERR,bad_test');
    }
    if (t[0] === 'STREAM' && t.length >= 2) { this.streamHz = clamp(int(t[1]), 0, 20); return this.send('OK'); }
    if (t[0] === 'CLEARFAULTS') { this.flags = 0; this.peak = 0; return this.send('OK'); }
    this.send('ERR,unknown_command');
  }

  private setParam(name: string, v: number): boolean {
    const p = this.cal.p;
    switch (name) {
      case 'trigger_trim_tenths': p[name] = clamp(v, -100, 100); break;
      case 'dwell_us': p[name] = clamp(v, 1000, 2600); break;
      case 'injector_deadtime_us': p[name] = clamp(v, 450, 2200); break;
      case 'tps_min_raw': p[name] = clamp(v, 0, 3500); break;
      case 'tps_max_raw': p[name] = clamp(v, 400, 4095); break;
      case 'fuel_scale_permille': p[name] = clamp(v, 700, 1300); break;
      case 'rev_limit_soft': p[name] = clamp(v, 5500, 8500); if (p.rev_limit_hard < p[name] + 100) p.rev_limit_hard = p[name] + 100; break;
      case 'rev_limit_hard': p[name] = clamp(v, 5700, 9000); if (p[name] < p.rev_limit_soft + 100) p[name] = p.rev_limit_soft + 100; break;
      case 'iac_max_steps': p[name] = clamp(v, 60, 300); p.iac_crank_steps = Math.min(p.iac_crank_steps, p[name]); p.iac_hot_steps = Math.min(p.iac_hot_steps, p[name]); break;
      case 'iac_crank_steps': case 'iac_hot_steps': p[name] = clamp(v, 0, p.iac_max_steps); break;
      case 'iac_target_rpm': p[name] = clamp(v, 800, 1600); break;
      case 'iac_direction': p[name] = v < 0 ? -1 : 1; break;
      case 'o2_heater_duty_pct': p[name] = clamp(v, 0, 70); break;
      case 'o2_mode': p[name] = v ? 1 : 0; break;
      case 'wideband_lambda_min_milli': p[name] = clamp(v, 500, 1000); break;
      case 'wideband_lambda_max_milli': p[name] = clamp(v, 1000, 2000); break;
      case 'fixed_ign_tenths': this.fixedIgn = v < 0 ? -1 : clamp(v, 0, 300); break;
      default: return false;
    }
    return true;
  }

  private startTest(name: string): boolean {
    const def = ACTUATOR_TESTS.find((d) => d.cmd === name);
    if (!def) return false;
    this.stopTest(false);
    if ((def.id === 5 || def.id === 6) && !this.inputs.iacDriverOk) return false;
    this.test = def.id;
    this.testSteps = 20;
    this.testDeadline = this.nowMs + (def.id === 1 || def.id === 7 ? 2000 : def.id === 5 || def.id === 6 ? 500 : 50);
    return true;
  }

  private stopTest(report: boolean) {
    const done = this.test;
    this.test = 0;
    if (done && report) this.send('TEST,DONE,' + (ACTUATOR_TESTS.find((d) => d.id === done)?.cmd ?? 'NONE'));
  }

  private serviceTest() {
    if (!this.test) return;
    if (!this.mutationAllowed() || this.inputs.kill) return this.stopTest(true);
    if ((this.test === 5 || this.test === 6) && this.testSteps > 0) {
      this.iacPos = clamp(this.iacPos + (this.test === 5 ? 1 : -1) * this.cal.p.iac_direction, 0, this.cal.p.iac_max_steps);
      if (--this.testSteps === 0) return this.stopTest(true);
    }
    if (this.nowMs >= this.testDeadline) this.stopTest(true);
  }

  private physics(dtMs: number) {
    const inp = this.inputs, p = this.cal.p, dt = dtMs / 1000;
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    // дроссель и сырой АЦП
    const tpsTarget = clamp(inp.throttle, 0, 1) * 1000;
    this.tps10 += (tpsTarget - this.tps10) * k(0.06);
    // обогащение при ускорении (раз в 10 мс в прошивке; здесь приближённо)
    const rise = this.tps10 - this.prevTps;
    if (rise > 1.2) this.accel = clamp(this.accel + rise * 2.5, 1000, 1350);
    this.accel = 1000 + (this.accel - 1000) * Math.exp(-dt / 0.12);
    this.prevTps = this.tps10;
    // обороты
    const kill = inp.kill;
    let target = 0;
    if (inp.running && !kill) {
      const idle = p.iac_target_rpm + clamp((50 - this.cht10 / 10) * 6, 0, 300);
      target = idle + Math.pow(this.tps10 / 1000, 0.75) * (7400 - idle);
      this.everRan = true;
    }
    const soft = p.rev_limit_soft, hard = p.rev_limit_hard;
    if (this.rpm >= hard) target = Math.min(target, hard - 250);
    else if (this.rpm >= soft) target = Math.min(target, soft + 60);
    this.rpm += (target - this.rpm) * k(target > this.rpm ? 0.55 : 0.9);
    if (this.rpm < 40 && target === 0) this.rpm = 0;
    if (this.rpm >= soft) this.flags |= 1 << 5; else this.flags &= ~(1 << 5);
    const rpm = Math.round(this.rpm);
    if (rpm > 120) this.sync = 1;
    else if (rpm === 0) { if (this.sync) this.flags |= 1 << 6; this.sync = 0; }
    if (rpm > this.peak) this.peak = rpm;
    this.crank = (this.crank + (this.rpm / 60) * dt) % 1;
    // давление, температуры, напряжение
    const mapTarget = rpm > 200 ? 300 + 713 * Math.pow(this.tps10 / 1000, 0.6) * (0.55 + 0.45 * Math.min(1, 2500 / Math.max(rpm, 600))) + 250 * (this.tps10 / 1000) : 1013;
    this.map10 += (clamp(mapTarget, 250, 1013) - this.map10) * k(0.15);
    const chtTarget = rpm > 200 ? 620 + 180 * (this.tps10 / 1000) + (rpm / 8000) * 80 : inp.ambientC * 10;
    this.cht10 += (chtTarget - this.cht10) * k(rpm > 200 ? 45 : 240);
    this.iat10 += (inp.ambientC * 10 + (rpm > 200 ? 60 : 0) - this.iat10) * k(30);
    const battTarget = rpm > 900 ? 14100 : rpm > 200 ? 13200 : inp.batteryMv;
    this.battMv += (battTarget - this.battMv) * k(0.4);
    if (this.cht10 > 850) this.flags |= 1 << 4; else this.flags &= ~(1 << 4);
    // топливо и зажигание (как prepare_realtime)
    let adv = this.fixedIgn >= 0 ? this.fixedIgn : lookupMap(this.cal.ign, rpm, Math.round(this.tps10));
    if (rpm < 450) adv = 50;
    if (this.cht10 > 850) adv -= clamp(Math.trunc(((this.cht10 - 850) * 3) / 10), 0, 70);
    this.adv10 = clamp(adv, 0, 300);
    let pulse = Math.max(0, lookupMap(this.cal.fuel, rpm, Math.round(this.tps10)) - p.injector_deadtime_us);
    pulse = Math.trunc((pulse * warmupPermille(Math.round(this.cht10))) / 1000);
    pulse = Math.trunc((pulse * clamp(Math.trunc(293150000 / (Math.round(this.iat10) * 100 + 273150)), 880, 1180)) / 1000);
    pulse = Math.trunc((pulse * Math.round(this.accel)) / 1000);
    pulse = Math.trunc((pulse * p.fuel_scale_permille) / 1000);
    if (this.cht10 > 900) pulse = Math.trunc((pulse * 1040) / 1000);
    pulse += injectorDeadtime(Math.round(this.battMv));
    this.pwUs = clamp(pulse, 500, 10000);
    this.fuelCut = (this.tps10 < 15 && rpm > 1800) || kill ? 1 : 0;
    // РХХ
    if (!inp.iacDriverOk) this.flags |= 1 << 7;
    else {
      this.flags &= ~(1 << 7);
      const steps = Math.max(1, Math.round(dtMs / 4));
      for (let s = 0; s < steps && this.test !== 5 && this.test !== 6; s++) {
        if (!this.iacHomed) {
          if (this.iacHoming > 0) { this.iacHoming--; continue; }
          this.iacHomed = true; this.iacPos = 0; this.iacTarget = p.iac_crank_steps;
        }
        if (kill) this.iacTarget = 0;
        else if (rpm < 450) this.iacTarget = p.iac_crank_steps;
        else if (this.tps10 >= 30) this.iacTarget = 0;
        else {
          const cold = clamp(Math.trunc(((500 - this.cht10) * 8) / 100), 0, 50);
          const corr = clamp(Math.trunc((p.iac_target_rpm - rpm) / 25), -20, 45);
          this.iacTarget = clamp(p.iac_hot_steps + cold + corr, 0, p.iac_max_steps);
        }
        if (this.iacPos < this.iacTarget) this.iacPos++; else if (this.iacPos > this.iacTarget) this.iacPos--;
      }
    }
    // нагреватель и лямбда
    const heatOn = p.o2_mode === 0 && this.sync && rpm >= 450 && !kill && this.battMv >= 9000 && this.battMv <= 16500;
    if (this.test === 7) this.heater = 20;
    else if (!heatOn) { this.heater = 0; this.heaterStart = -1; }
    else {
      if (this.heaterStart < 0) this.heaterStart = this.nowMs;
      const el = this.nowMs - this.heaterStart;
      let req = p.o2_heater_duty_pct;
      if (el < 2000) req = Math.min(req, 20);
      else if (el < 7000) req = Math.min(req, Math.trunc(20 + ((el - 2000) * 50) / 5000));
      this.heater = req;
    }
    this.o2Phase += dt * 1.6;
    if (p.o2_mode === 0) {
      const o2Target = rpm > 400 && this.heater >= 50 ? 450 + 370 * Math.sign(Math.sin(this.o2Phase * Math.PI * 2)) * (this.fuelCut ? -1 : 1) : 450;
      this.o2Mv += (o2Target - this.o2Mv) * k(0.12);
      this.lambdaMilli = 0;
      if (!rpm || this.heater < 50) this.lambdaDir = 2;
      else if (this.o2Mv < 120) this.lambdaDir = 1;
      else if (this.o2Mv > 750) this.lambdaDir = -1;
      else this.lambdaDir = 0;
    } else {
      // Внешний широкополосный контроллер с линейным выходом 0–5 В = λ 0,70…1,30 (свой нагрев, от ECU не зависит).
      // Двигатель стоит или топливо отсечено — в выпуске воздух, выход упирается в 5 В; прошивка считает это «нет данных».
      let controllerMv = 5000;
      if (rpm > 400 && !this.fuelCut) {
        const tps = this.tps10;
        const target = tps <= 300 ? 980 : tps >= 700 ? 875 : 980 - ((tps - 300) * 105) / 400; // цель смеси, как в подсказке программы
        const lambda = target - (this.accel - 1000) * 0.35 + 14 * Math.sin(this.o2Phase * Math.PI * 2);
        controllerMv = clamp(((lambda - 700) * 5000) / 600, 0, 5000);
      }
      // как read_sensors(): делитель 2/3 на входе АЦП, обратный пересчёт ×3/2, сглаживание, шкала из калибровок
      const directMv = Math.trunc((Math.trunc((controllerMv * 2 * 4095) / (3 * 3300)) * 3300) / 4095);
      this.o2Mv += (clamp(Math.trunc((directMv * 3) / 2), 0, 5000) - this.o2Mv) * k(0.12);
      const mv = Math.round(this.o2Mv);
      this.lambdaMilli = p.wideband_lambda_min_milli + Math.trunc((mv * (p.wideband_lambda_max_milli - p.wideband_lambda_min_milli)) / 5000);
      if (mv < 50 || mv > 4950) this.lambdaDir = 2;
      else if (this.lambdaMilli < 980) this.lambdaDir = -1;
      else if (this.lambdaMilli > 1020) this.lambdaDir = 1;
      else this.lambdaDir = 0;
    }
    if (this.lambdaDir === 2) this.flags |= 1 << 8; else this.flags &= ~(1 << 8);
  }

  private statusLine(): string {
    const p = this.cal.p, rpm = Math.round(this.rpm), batt = Math.round(this.battMv);
    const span = Math.max(80, p.tps_max_raw - p.tps_min_raw);
    const tpsRaw = Math.round(p.tps_min_raw + (this.tps10 * span) / 1000);
    const dead = injectorDeadtime(batt);
    const duty = !rpm || this.pwUs <= dead ? 0 : clamp(Math.trunc(((this.pwUs - dead) * 1000) / Math.trunc(30000000 / rpm)), 0, 1000);
    const toothUs = rpm ? Math.round(60000000 / (rpm * 36)) : 0;
    const toothIndex = this.sync ? Math.floor(this.crank * 36) % 35 : 255;
    // маска выходов: мгновенные состояния ножек (катушки и форсунка — по фазе коленвала)
    let mask = 0;
    const running = rpm > 0 && this.sync && !this.inputs.kill;
    if (running) {
      const rev = 60000000 / rpm, dwellFrac = coilDwell(p.dwell_us, batt) / rev;
      const sparkAt = (1700 - p.trigger_trim_tenths - this.adv10) / 3600;
      const inWin = (ph: number, end: number, len: number) => { const d = (end - ph + 1) % 1; return d < len; };
      if (inWin(this.crank, sparkAt, dwellFrac)) mask |= 1;
      if (inWin((this.crank + 0.5) % 1, sparkAt, dwellFrac)) mask |= 2;
      if (!this.fuelCut && (this.crank % 0.5) < Math.min(0.425, this.pwUs / rev)) mask |= 4;
    }
    if (this.test === 2) mask |= 4;
    if (this.test === 3) mask |= 1;
    if (this.test === 4) mask |= 2;
    const pumpOn = !this.inputs.kill && (this.test === 1 || this.nowMs < 2000 || rpm > 0);
    if (pumpOn) mask |= 8;
    if (this.heater > 0 && (this.nowMs % 100) < this.heater) mask |= 16;
    if (this.inputs.iacDriverOk) mask |= 32;
    const f = [
      rpm, Math.round(this.tps10), Math.round(this.map10), Math.round(this.cht10), Math.round(this.iat10), batt,
      Math.round(this.o2Mv), this.lambdaMilli, this.lambdaDir, this.pwUs, this.adv10, this.sync, this.flags, 1,
      this.mutationAllowed() ? 1 : 0, this.peak, this.iacPos, this.iacTarget, this.heater, duty, 0, this.test,
      this.inputs.kill ? 1 : 0, Math.round(this.nowMs), tpsRaw, 1013, coilDwell(p.dwell_us, batt), Math.round(this.accel),
      toothUs, toothIndex, this.fuelCut, 1, mask,
    ];
    return 'T,' + f.join(',');
  }
}
