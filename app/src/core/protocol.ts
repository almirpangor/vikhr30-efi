// Протокол обмена с ECU: разбор строк и очередь команд с ожиданием ответа.
import { LOAD_COUNT, RPM_COUNT, TELEMETRY_KEYS, TELEMETRY_MIN_FIELDS, emptyTelemetry, type MapTable, type Telemetry } from './types';

/** Канал байтов до ECU: COM-порт или эмулятор. */
export interface Transport {
  /** Отправить текст (уже с завершающим \n). */
  write(data: string): Promise<void> | void;
  /** Подписка на принятый текст (произвольными кусками). */
  onData: ((chunk: string) => void) | null;
  /** Канал закрылся сам (выдернули кабель и т. п.). */
  onClose: (() => void) | null;
  close(): Promise<void> | void;
}

export type ParsedLine =
  | { kind: 'telemetry'; t: Telemetry }
  | { kind: 'fuelRow' | 'ignRow'; row: number; values: number[] }
  | { kind: 'axis'; axis: 'R' | 'L'; values: number[] }
  | { kind: 'param'; key: string; value: number }
  | { kind: 'end' }
  | { kind: 'ok'; args: string[] }
  | { kind: 'err'; code: string }
  | { kind: 'test'; event: string; name: string }
  | { kind: 'boot' | 'info' | 'bootstage'; args: string[] }
  | { kind: 'bad'; reason: string };

/** Предел длины принимаемой строки, байт. */
const MAX_LINE = 1024;

const isInt = (s: string) => /^-?\d+$/.test(s);

/** Разобрать одну строку протокола. Никогда не бросает исключений. */
export function parseLine(line: string): ParsedLine {
  const p = line.trim().split(',');
  const head = p[0];
  if (head === 'T') {
    const n = p.length - 1;
    if (n < TELEMETRY_MIN_FIELDS) return { kind: 'bad', reason: 'короткая телеметрия' };
    const t = emptyTelemetry() as unknown as Record<string, number>;
    const count = Math.min(n, TELEMETRY_KEYS.length);
    for (let i = 0; i < count; i++) {
      if (!isInt(p[i + 1])) return { kind: 'bad', reason: `поле ${i + 1} не число` };
      t[TELEMETRY_KEYS[i]] = Number(p[i + 1]);
    }
    return { kind: 'telemetry', t: t as unknown as Telemetry };
  }
  if (head === 'F' || head === 'I') {
    if (p.length !== RPM_COUNT + 2 || !p.slice(1).every(isInt)) return { kind: 'bad', reason: 'строка карты' };
    const row = Number(p[1]);
    if (row < 0 || row >= LOAD_COUNT) return { kind: 'bad', reason: 'номер строки карты' };
    return { kind: head === 'F' ? 'fuelRow' : 'ignRow', row, values: p.slice(2).map(Number) };
  }
  if (head === 'R' || head === 'L') {
    if (!p.slice(1).every(isInt)) return { kind: 'bad', reason: 'ось карты' };
    return { kind: 'axis', axis: head, values: p.slice(1).map(Number) };
  }
  if (head === 'P') {
    if (p.length < 3 || !isInt(p[2])) return { kind: 'bad', reason: 'параметр' };
    return { kind: 'param', key: p[1], value: Number(p[2]) };
  }
  if (head === 'END') return { kind: 'end' };
  if (head === 'OK') return { kind: 'ok', args: p.slice(1) };
  if (head === 'ERR') return { kind: 'err', code: p[1] ?? 'unknown' };
  if (head === 'TEST' && p.length >= 3) return { kind: 'test', event: p[1], name: p[2] };
  if (head === 'BOOT') return { kind: 'boot', args: p.slice(1) };
  if (head === 'INFO') return { kind: 'info', args: p.slice(1) };
  if (head === 'BOOTSTAGE') return { kind: 'bootstage', args: p.slice(1) };
  return { kind: 'bad', reason: 'неизвестная строка' };
}

export const ERROR_TEXT: Record<string, string> = {
  service_lock: 'ECU заблокировал команду: нужны остановленный двигатель (RPM = 0) и замкнутая перемычка SERVICE.',
  index: 'ECU отверг номер ячейки карты.',
  bad_set: 'ECU не понял команду записи.',
  bad_get: 'ECU не понял запрос.',
  bad_test: 'ECU не смог запустить тест (для РХХ — драйвер сообщает об ошибке).',
  unknown_parameter: 'ECU не знает такой параметр.',
  unknown_command: 'ECU не знает такую команду.',
  flash: 'ECU не смог записать Flash.',
  line_too_long: 'ECU получил слишком длинную строку.',
  timeout: 'ECU не ответил вовремя.',
  closed: 'Соединение закрыто.',
};

export class EcuError extends Error {
  constructor(public code: string, public command: string) {
    super(ERROR_TEXT[code] ?? `Ошибка ECU: ${code}`);
  }
}

interface Pending {
  cmd: string;
  /** Вернуть true, когда ответ получен полностью. */
  accept: (l: ParsedLine) => boolean;
  resolve: () => void;
  reject: (e: Error) => void;
  timeoutMs: number;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Служебный PING-барьер: игнорирует всё, кроме своего ответа. */
  barrier?: boolean;
}

export interface LinkEvents {
  telemetry?: (t: Telemetry) => void;
  line?: (dir: 'rx' | 'tx', text: string, parsed?: ParsedLine) => void;
  test?: (event: string, name: string) => void;
  closed?: () => void;
}

export interface MapsSnapshot { fuel: MapTable; ign: MapTable }

/** Какой ответ «OK…» прошивка v0.8 даёт на команду. Чужой OK (опоздавший ответ на другую команду) не принимается. */
function okMatches(cmd: string, args: string[]): boolean {
  const t = cmd.trim().split(/\s+/);
  switch (t[0]) {
    case 'PING': return args[0] === 'VIKHR30_STM32';
    case 'SAVE': return args[0] === 'SAVED';
    case 'DEFAULTS': return args[0] === 'DEFAULTS_RAM';
    case 'HOMEIAC': return args[0] === 'IAC_HOMING';
    case 'TEST': return args[0] === 'TEST' && args[1] === t[1];
    default: return args.length === 0; // SET, STREAM, CLEARFAULTS отвечают просто «OK»
  }
}

/**
 * Соединение с ECU. Команды уходят строго по одной: следующая отправляется
 * только после ответа на предыдущую (или после исчерпания повторов).
 *
 * Защита от опоздавших ответов. В протоколе v0.8 ответы не нумерованы, поэтому
 * после таймаута ответ на прежнюю посылку может прийти позже и быть принят за
 * ответ на следующую команду (например, «OK» на первый SET — за подтверждение
 * второго, который на самом деле потерялся). Поэтому после любого таймаута
 * канал считается «грязным», и перед следующей командой отправляется PING-барьер:
 * ECU обрабатывает команды по порядку, значит, когда пришёл ответ на PING
 * («OK,VIKHR30_STM32,…» — его ни с чем не спутать), все опоздавшие ответы уже
 * получены и отброшены. Кроме того, ok() принимает только тот вид «OK», который
 * прошивка даёт именно на эту команду (SAVE → OK,SAVED и т. д.).
 */
export class Link {
  private buf = '';
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private closed = false;
  /** Был таймаут: в канале могут быть опоздавшие ответы, перед следующей командой нужен PING-барьер. */
  private dirty = false;
  /** Счётчики для диагностики качества канала. */
  stats = { rxLines: 0, badLines: 0, retries: 0, timeouts: 0, barriers: 0, staleDropped: 0 };

  constructor(private transport: Transport, private ev: LinkEvents = {}) {
    transport.onData = (chunk) => this.feed(chunk);
    transport.onClose = () => this.handleClose();
  }

  /** Принять кусок текста от транспорта. */
  feed(chunk: string) {
    this.buf += chunk;
    let start = 0;
    const eol = /[\r\n]/g;
    for (;;) {
      eol.lastIndex = start;
      const m = eol.exec(this.buf);
      if (!m) break;
      const line = this.buf.slice(start, m.index);
      start = m.index + 1;
      if (!line.length) continue;
      // Самая длинная строка протокола (телеметрия) короче 250 байт; длиннее — заведомо мусор.
      if (line.length > MAX_LINE) { this.stats.rxLines++; this.stats.badLines++; continue; }
      this.handleLine(line);
    }
    this.buf = start ? this.buf.slice(start) : this.buf;
    // Хвост без перевода строки длиннее предела — мусор (не та скорость порта, помехи): не копим его.
    if (this.buf.length > MAX_LINE) { this.buf = ''; this.stats.badLines++; }
  }

  private handleLine(line: string) {
    const parsed = parseLine(line);
    this.stats.rxLines++;
    if (parsed.kind === 'bad') this.stats.badLines++;
    this.ev.line?.('rx', line, parsed);
    if (parsed.kind === 'telemetry') { this.ev.telemetry?.(parsed.t); return; }
    if (parsed.kind === 'test') { this.ev.test?.(parsed.event, parsed.name); return; }
    if (parsed.kind === 'boot' || parsed.kind === 'bootstage' || parsed.kind === 'bad') return;
    const cur = this.current;
    if (!cur) return;
    if (cur.barrier) {
      if (parsed.kind === 'ok' && parsed.args[0] === 'VIKHR30_STM32') { this.dirty = false; this.finish(cur, null); }
      else this.stats.staleDropped++; // опоздавший ответ на прежнюю команду
      return;
    }
    if (parsed.kind === 'err') {
      // line_too_long и unknown_command обычно означают искажённую строку — повторяем
      const garbled = ['line_too_long', 'unknown_command', 'bad_set', 'bad_get', 'index', 'unknown_parameter'].includes(parsed.code);
      if (garbled && cur.retries > 0) {
        this.retry(cur);
        return;
      }
      this.finish(cur, new EcuError(parsed.code, cur.cmd));
      return;
    }
    let done = false;
    try { done = cur.accept(parsed); } catch (e) {
      // неполный ответ (потерянная строка) — повторяем запрос, пока есть попытки
      if (cur.retries > 0) this.retry(cur); else this.finish(cur, e as Error);
      return;
    }
    if (done) this.finish(cur, null);
  }

  private finish(p: Pending, err: Error | null) {
    if (p.timer) clearTimeout(p.timer);
    if (this.current === p) this.current = null;
    if (err) p.reject(err); else p.resolve();
    this.pump();
  }

  private retry(p: Pending) {
    if (p.timer) clearTimeout(p.timer);
    p.retries--;
    this.stats.retries++;
    this.transmit(p);
  }

  private transmit(p: Pending) {
    this.ev.line?.('tx', p.cmd);
    p.timer = setTimeout(() => {
      this.stats.timeouts++;
      if (!p.barrier) this.dirty = true;
      if (p.retries > 0) this.retry(p);
      else this.finish(p, new EcuError('timeout', p.cmd));
    }, p.timeoutMs);
    Promise.resolve(this.transport.write(p.cmd + '\n')).catch(() => this.finish(p, new EcuError('closed', p.cmd)));
  }

  private pump() {
    if (this.current || this.closed) return;
    if (!this.queue.length) return;
    if (this.dirty) {
      // Барьер: дождаться ответа на PING, отбрасывая всё, что пришло раньше него.
      this.stats.barriers++;
      const barrier: Pending = {
        cmd: 'PING', accept: () => false, timeoutMs: 400, retries: 2, timer: null, barrier: true,
        resolve: () => {},
        // ECU молчит: команда из очереди не отправляется и завершается таймаутом, канал остаётся «грязным».
        reject: () => { const q = this.queue.shift(); if (q) q.reject(new EcuError('timeout', q.cmd)); },
      };
      this.current = barrier;
      this.transmit(barrier);
      return;
    }
    const next = this.queue.shift()!;
    this.current = next;
    this.transmit(next);
  }

  private handleClose() {
    if (this.closed) return;
    this.closed = true;
    const all = [this.current, ...this.queue].filter(Boolean) as Pending[];
    this.current = null;
    this.queue = [];
    for (const p of all) { if (p.timer) clearTimeout(p.timer); p.reject(new EcuError('closed', p.cmd)); }
    this.ev.closed?.();
  }

  async close() {
    await this.transport.close();
    this.handleClose();
  }

  get isClosed() { return this.closed; }
  get busy() { return !!this.current || this.queue.length > 0; }

  /** Отправить команду и дождаться ответа. accept получает строки ответа по одной. */
  request(cmd: string, accept: (l: ParsedLine) => boolean, timeoutMs = 600, retries = 2): Promise<void> {
    if (this.closed) return Promise.reject(new EcuError('closed', cmd));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ cmd, accept, resolve, reject, timeoutMs, retries, timer: null });
      this.pump();
    });
  }

  /** Команда с ответом «OK…». Возвращает аргументы после OK. */
  async ok(cmd: string, timeoutMs = 600, retries = 2): Promise<string[]> {
    let args: string[] = [];
    await this.request(cmd, (l) => {
      if (l.kind !== 'ok') return false;
      if (!okMatches(cmd, l.args)) { this.stats.staleDropped++; return false; }
      args = l.args;
      return true;
    }, timeoutMs, retries);
    return args;
  }

  /** PING → версия прошивки. */
  async ping(timeoutMs = 500, retries = 1): Promise<string> {
    let version = '';
    await this.request('PING', (l) => {
      if (l.kind === 'ok' && l.args[0] === 'VIKHR30_STM32') { version = l.args[1] ?? ''; return true; }
      return false;
    }, timeoutMs, retries);
    return version;
  }

  /**
   * Прочитать карты. В протоколе нет контрольных сумм, поэтому читаем до тех
   * пор, пока два чтения подряд не совпадут: так искажённая в канале цифра
   * не попадёт в таблицу незамеченной.
   */
  async readMaps(): Promise<MapsSnapshot> {
    let prev = await this.readMapsOnce();
    for (let i = 0; i < 4; i++) {
      const next = await this.readMapsOnce();
      if (JSON.stringify(prev) === JSON.stringify(next)) return next;
      prev = next;
    }
    throw new EcuError('unstable', 'GET MAPS');
  }

  private async readMapsOnce(): Promise<MapsSnapshot> {
    const blank = () => Array.from({ length: LOAD_COUNT }, () => null as number[] | null);
    let fuel = blank(), ign = blank();
    await this.request('GET MAPS', (l) => {
      if (l.kind === 'fuelRow') fuel[l.row] = l.values;
      else if (l.kind === 'ignRow') ign[l.row] = l.values;
      else if (l.kind === 'end') {
        if (fuel.some((r) => !r) || ign.some((r) => !r)) {
          fuel = blank(); ign = blank();
          throw new EcuError('incomplete', 'GET MAPS');
        }
        return true;
      }
      return false;
    }, 1500, 6);
    return { fuel: fuel as MapTable, ign: ign as MapTable };
  }

  async readParams(): Promise<Record<string, number>> {
    let prev = await this.readParamsOnce();
    for (let i = 0; i < 4; i++) {
      const next = await this.readParamsOnce();
      if (JSON.stringify(prev) === JSON.stringify(next)) return next;
      prev = next;
    }
    throw new EcuError('unstable', 'GET PARAMS');
  }

  private async readParamsOnce(): Promise<Record<string, number>> {
    let out: Record<string, number> = {};
    await this.request('GET PARAMS', (l) => {
      if (l.kind === 'param') out[l.key] = l.value;
      else if (l.kind === 'end') {
        if (Object.keys(out).length < 17) { out = {}; throw new EcuError('incomplete', 'GET PARAMS'); }
        return true;
      }
      return false;
    }, 1200, 6);
    return out;
  }

  /**
   * Записать в RAM ECU ячейки, отличающиеся от того, что в нём сейчас, затем
   * прочитать карты обратно и сверить все 234 ячейки. Бросает исключение,
   * если после записи остались расхождения.
   */
  async writeMaps(target: MapsSnapshot, onProgress?: (done: number, total: number) => void): Promise<{ written: number }> {
    const before = await this.readMaps();
    const total = () => jobs.length;
    const jobs: string[] = [];
    for (let r = 0; r < LOAD_COUNT; r++)
      for (let c = 0; c < RPM_COUNT; c++) {
        if (before.fuel[r][c] !== target.fuel[r][c]) jobs.push(`SET FUEL ${r} ${c} ${target.fuel[r][c]}`);
        if (before.ign[r][c] !== target.ign[r][c]) jobs.push(`SET IGN ${r} ${c} ${target.ign[r][c]}`);
      }
    let done = 0;
    onProgress?.(0, jobs.length);
    for (const j of jobs) { await this.ok(j, 400, 5); onProgress?.(++done, total()); }
    // Сверка; искажённую при передаче ячейку переписываем до двух раз.
    for (let attempt = 0; ; attempt++) {
      const after = await this.readMaps();
      const fix: string[] = [];
      for (let r = 0; r < LOAD_COUNT; r++)
        for (let c = 0; c < RPM_COUNT; c++) {
          if (after.fuel[r][c] !== target.fuel[r][c]) fix.push(`SET FUEL ${r} ${c} ${target.fuel[r][c]}`);
          if (after.ign[r][c] !== target.ign[r][c]) fix.push(`SET IGN ${r} ${c} ${target.ign[r][c]}`);
        }
      if (!fix.length) return { written: jobs.length };
      if (attempt >= 3) throw new EcuError('verify', `расхождений: ${fix.length}`);
      for (const j of fix) await this.ok(j, 400, 5);
    }
  }

  /** Записать параметры и сверить обратным чтением. Возвращает прочитанные значения. */
  async writeParams(values: Record<string, number>): Promise<Record<string, number>> {
    for (const [k, v] of Object.entries(values)) await this.ok(`SET PARAM ${k} ${v}`, 400, 5);
    const back = await this.readParams();
    const wrong = Object.entries(values).filter(([k, v]) => back[k] !== v).map(([k]) => k);
    if (wrong.length) throw new EcuError('verify', wrong.join(', '));
    return back;
  }
}
ERROR_TEXT.verify = 'После записи значения в ECU не совпали с отправленными.';
ERROR_TEXT.unstable = 'Два чтения подряд дали разные данные: канал связи сильно зашумлён.';
ERROR_TEXT.incomplete = 'ECU прислал неполный ответ.';
