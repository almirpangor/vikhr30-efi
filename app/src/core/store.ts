// Состояние приложения и действия. Интерфейс подписывается через useApp().
import { useSyncExternalStore } from 'react';
import { cloneMap, mapsEqual } from './calc';
import { EcuEmulator } from './emulator';
import { EcuError, Link, type ParsedLine, type Transport } from './protocol';
import { SerialTransport, serialSupported } from './serial';
import { ACTUATOR_TESTS, DEFAULT_FUEL, DEFAULT_IGN, PARAMS, TELEMETRY_KEYS, type LinkStatus, type MapTable, type Telemetry } from './types';

export interface LogEntry { n: number; time: number; dir: 'rx' | 'tx' | 'app'; text: string; kind: string }
export interface Busy { label: string; done: number; total: number }
export interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string }

export const HISTORY_LEN = 600; // 60 с при 10 Гц

export interface AppState {
  status: LinkStatus;
  demo: boolean;
  portName: string;
  fwVersion: string;
  telemetry: Telemetry | null;
  /** Последняя полученная телеметрия остаётся для справки, но при потере связи live=false. */
  live: boolean;
  frames: number;
  ecuFuel: MapTable;   // то, что сейчас в RAM ECU (по последнему чтению)
  ecuIgn: MapTable;
  fuel: MapTable;      // рабочая копия в программе
  ign: MapTable;
  mapsLoaded: boolean;
  ecuParams: Record<string, number>;
  params: Record<string, number>;
  paramsLoaded: boolean;
  /** Есть изменения в RAM ECU, не сохранённые во Flash. */
  unsaved: boolean;
  log: LogEntry[];
  logPaused: boolean;
  recording: boolean;
  recordedRows: number;
  busy: Busy | null;
  toasts: Toast[];
  testMessage: string;
  page: string;
  /** Выбранная цепь на 3D-схеме. */
  selectedNet: string | null;
}

const defParams = () => Object.fromEntries(PARAMS.map((p) => [p.key, p.def]));

let state: AppState = {
  status: 'disconnected', demo: false, portName: '', fwVersion: '', telemetry: null, live: false, frames: 0,
  ecuFuel: cloneMap(DEFAULT_FUEL), ecuIgn: cloneMap(DEFAULT_IGN), fuel: cloneMap(DEFAULT_FUEL), ign: cloneMap(DEFAULT_IGN), mapsLoaded: false,
  ecuParams: defParams(), params: defParams(), paramsLoaded: false, unsaved: false,
  log: [], logPaused: false, recording: false, recordedRows: 0, busy: null, toasts: [], testMessage: 'Ожидание команды. Все тестовые выходы выключены.',
  page: 'dashboard', selectedNet: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export const getState = () => state;
export function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

// ---- история для графиков (кольцевые буферы вне React) ----
export const history: Record<string, Float32Array> = Object.fromEntries(TELEMETRY_KEYS.map((k) => [k, new Float32Array(HISTORY_LEN)]));
export const historyMeta = { pos: 0, count: 0, paused: false };
function pushHistory(t: Telemetry) {
  if (historyMeta.paused) return;
  for (const k of TELEMETRY_KEYS) history[k][historyMeta.pos] = t[k];
  historyMeta.pos = (historyMeta.pos + 1) % HISTORY_LEN;
  historyMeta.count = Math.min(HISTORY_LEN, historyMeta.count + 1);
}
/** Значения показателя от старых к новым. */
export function historySeries(key: keyof Telemetry): number[] {
  const out: number[] = [], n = historyMeta.count, buf = history[key];
  for (let i = 0; i < n; i++) out.push(buf[(historyMeta.pos - n + i + HISTORY_LEN * 2) % HISTORY_LEN]);
  return out;
}

// ---- соединение ----
let link: Link | null = null;
let emulator: EcuEmulator | null = null;
let lastFrameAt = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
let logN = 0;
let toastN = 0;
let recorded: string[] = [];
let pendingLog: LogEntry[] = [];
let logFlush: ReturnType<typeof setTimeout> | null = null;

export const getEmulator = () => emulator;
export const isSerialSupported = serialSupported;

function addLog(dir: LogEntry['dir'], text: string, kind = 'app') {
  if (state.logPaused) return;
  pendingLog.push({ n: ++logN, time: Date.now(), dir, text, kind });
  if (!logFlush) logFlush = setTimeout(() => {
    logFlush = null;
    const merged = state.log.concat(pendingLog);
    pendingLog = [];
    set({ log: merged.length > 1500 ? merged.slice(-1200) : merged });
  }, 150);
}

export function toast(kind: Toast['kind'], text: string) {
  const id = ++toastN;
  set({ toasts: [...state.toasts, { id, kind, text }] });
  addLog('app', text, kind);
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), kind === 'error' ? 9000 : 4500);
}
export const dismissToast = (id: number) => set({ toasts: state.toasts.filter((t) => t.id !== id) });

function errText(e: unknown): string {
  if (e instanceof EcuError) return e.message + (e.code === 'verify' ? ` (${e.command})` : '');
  return e instanceof Error ? e.message : String(e);
}

/**
 * ECU прислал «BOOT»: он только что включился или перезапустился. В его оперативной памяти снова
 * калибровки из Flash — всё, что было записано, но не сохранено, пропало.
 */
function onEcuBoot() {
  const lost = state.unsaved, midSession = state.status === 'online' && state.mapsLoaded;
  if (lost) set({ unsaved: false });
  if (!midSession) return;
  toast(lost ? 'error' : 'info', lost
    ? 'ECU перезапустился. Изменения, не сохранённые во Flash, в его памяти потеряны — запишите их заново.'
    : 'ECU перезапустился: в его памяти калибровки из Flash.');
  const l = link;
  if (!l) return;
  // обновляем только сведения «что сейчас в ECU»; правки пользователя в программе остаются
  (async () => {
    try {
      await l.ok('STREAM 10');
      const maps = await l.readMaps(), params = await l.readParams();
      if (link === l) set({ ecuFuel: maps.fuel, ecuIgn: maps.ign, ecuParams: params });
    } catch { /* связь пропала — состояние обновится при следующем чтении */ }
  })();
}

function onLine(dir: 'rx' | 'tx', text: string, parsed?: ParsedLine) {
  if (parsed?.kind === 'boot') onEcuBoot();
  if (parsed?.kind === 'telemetry') {
    if (state.recording) { recorded.push(Date.now() + ',' + text.slice(2)); if (recorded.length % 10 === 0) set({ recordedRows: recorded.length }); }
    return; // телеметрию в журнал не пишем — она в графиках
  }
  addLog(dir, text, parsed?.kind ?? 'cmd');
}

function onTelemetry(t: Telemetry) {
  lastFrameAt = Date.now();
  pushHistory(t);
  set({ telemetry: t, live: true, frames: state.frames + 1, status: state.status === 'lost' || state.status === 'waiting' ? 'online' : state.status });
}

function onTest(event: string, name: string) {
  const title = ACTUATOR_TESTS.find((d) => d.cmd === name)?.title ?? name;
  if (event === 'DONE' && !state.testMessage.startsWith('Остановлено')) set({ testMessage: `Завершено: ${title}. Все тестовые выходы выключены.` });
}

function startWatchdog() {
  stopWatchdog();
  watchdog = setInterval(() => {
    if (!link) return;
    const silent = Date.now() - lastFrameAt;
    if ((state.status === 'online') && silent > 1700) {
      set({ status: 'lost', live: false });
      addLog('app', 'ECU не отвечает дольше 1,7 с', 'error');
    }
    if (state.status === 'lost' && !link.busy) {
      link.ping(400, 0).then(() => link?.ok('STREAM 10').catch(() => {})).catch(() => {});
    }
  }, 500);
}
function stopWatchdog() { if (watchdog) clearInterval(watchdog); watchdog = null; }

async function attach(transport: Transport, name: string, demo: boolean) {
  set({ status: 'waiting', portName: name, demo, fwVersion: '', mapsLoaded: false, paramsLoaded: false });
  const l = new Link(transport, {
    telemetry: onTelemetry, line: onLine, test: onTest,
    closed: () => {
      if (link !== l) return;
      link = null; emulator = null;
      stopWatchdog();
      set({ status: 'disconnected', live: false, demo: false, busy: null });
      addLog('app', 'Соединение закрыто', 'info');
    },
  });
  link = l;
  lastFrameAt = Date.now();
  historyMeta.pos = 0; historyMeta.count = 0; // графики: история прежнего подключения не должна склеиваться с новой
  try {
    let version = '';
    for (let i = 0; ; i++) {
      try { version = await l.ping(600, 1); break; } catch (e) { if (i >= 3 || l.isClosed) throw e; }
    }
    set({ fwVersion: version, status: 'online' });
    lastFrameAt = Date.now();
    startWatchdog();
    await l.ok('STREAM 10');
    await readAll(true);
    toast('ok', demo ? 'Демо-режим: подключён эмулятор ECU' : `ECU отвечает, прошивка ${version}`);
  } catch (e) {
    toast('error', demo ? errText(e) : 'Порт открыт, но ECU не отвечает. Проверьте: выбран ли нужный COM-порт, скорость 115200, питание ECU, не перепутаны ли TX/RX.');
    await l.close().catch(() => {});
  }
}

export async function connectSerial() {
  if (link) await disconnect();
  if (!serialSupported()) { toast('error', 'Этот браузер не умеет работать с COM-портами. Откройте программу в Chrome или Edge.'); return; }
  set({ status: 'opening' });
  try {
    const t = await SerialTransport.open();
    await attach(t, t.name, false);
  } catch (e) {
    set({ status: 'disconnected' });
    const msg = errText(e);
    if (!/No port selected|cancel/i.test(msg)) toast('error', 'Не удалось открыть порт: ' + msg + '. Закройте другие программы, которые его используют.');
  }
}

export async function connectDemo() {
  if (link) await disconnect();
  emulator = new EcuEmulator();
  emulator.realisticUart = true;
  await attach(emulator, 'Эмулятор ECU', true);
}

export async function disconnect() {
  const l = link;
  if (!l) return;
  try { await l.close(); } catch { /* уже закрыт */ }
}

function needLink(): Link {
  if (!link || link.isClosed) throw new Error('ECU не подключён.');
  return link;
}

/** Обёртка: показывает ошибку и не даёт действию «упасть» молча. */
async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); }
  catch (e) { toast('error', `${label}: ${errText(e)}`); return undefined; }
  finally { if (state.busy) set({ busy: null }); }
}

export async function readAll(silent = false) {
  return guard('Чтение из ECU', async () => {
    const l = needLink();
    set({ busy: { label: 'Чтение карт и параметров', done: 0, total: 2 } });
    const maps = await l.readMaps();
    set({ busy: { label: 'Чтение карт и параметров', done: 1, total: 2 } });
    const params = await l.readParams();
    undoStack.length = 0; redoStack.length = 0; // история правок относится к прежним данным
    set({ ecuFuel: maps.fuel, ecuIgn: maps.ign, fuel: cloneMap(maps.fuel), ign: cloneMap(maps.ign), mapsLoaded: true, ecuParams: params, params: { ...params }, paramsLoaded: true });
    if (!silent) toast('ok', 'Карты и параметры прочитаны из ECU');
  });
}

export function canMutate(): string | null {
  const t = state.telemetry;
  if (link && state.status === 'lost') return 'ECU не отвечает. Проверьте питание блока и кабель.';
  if (!link || state.status !== 'online' || !t) return 'ECU не подключён.';
  if (t.rpm > 0) return 'Двигатель работает. Запись и тесты возможны только при RPM = 0.';
  if (!t.service) return 'Перемычка SERVICE не установлена (PB13 не замкнут на массу).';
  return null;
}

/**
 * После неудачной записи в ECU могло попасть только начало посылки. Если блок ещё отвечает,
 * читаем из него то, что там на самом деле (правки пользователя в программе не трогаем).
 */
async function resyncAfterFailure(l: Link, what: 'maps' | 'params', cause: unknown) {
  if (l.isClosed || (cause instanceof EcuError && (cause.code === 'timeout' || cause.code === 'closed'))) return; // блок молчит — не тянем время
  try {
    await l.ping(400, 0);
    if (what === 'maps') {
      const now = await l.readMaps();
      const touched = !mapsEqual(now.fuel, state.ecuFuel) || !mapsEqual(now.ign, state.ecuIgn);
      set({ ecuFuel: now.fuel, ecuIgn: now.ign, unsaved: state.unsaved || touched });
      if (touched) addLog('app', 'Запись прервана: часть ячеек уже в ECU, остальные остались прежними. Состояние ECU перечитано.', 'error');
    } else {
      const now = await l.readParams();
      const touched = PARAMS.some((p) => now[p.key] !== state.ecuParams[p.key]);
      set({ ecuParams: now, unsaved: state.unsaved || touched });
      if (touched) addLog('app', 'Запись прервана: часть параметров уже в ECU. Состояние ECU перечитано.', 'error');
    }
  } catch { /* блок не отвечает — оставляем как есть, пользователь увидит исходную ошибку */ }
}

export async function writeMaps() {
  return guard('Запись карт', async () => {
    const why = canMutate();
    if (why) throw new Error(why);
    const l = needLink(), target = { fuel: cloneMap(state.fuel), ign: cloneMap(state.ign) };
    set({ busy: { label: 'Запись карт в ECU', done: 0, total: 1 } });
    let res: { written: number };
    try {
      res = await l.writeMaps(target, (done, total) => set({ busy: { label: 'Запись карт в ECU', done, total: Math.max(1, total) } }));
    } catch (e) {
      // Запись оборвалась на середине: часть ячеек уже в ECU. Перечитываем, чтобы программа показывала правду.
      await resyncAfterFailure(l, 'maps', e);
      throw e;
    }
    set({ ecuFuel: target.fuel, ecuIgn: target.ign, unsaved: state.unsaved || res.written > 0 });
    toast('ok', res.written ? `Записано ячеек: ${res.written}. Сверка всех 234 ячеек прошла. Чтобы сохранить после выключения — «Сохранить во Flash».` : 'Карты в ECU уже совпадают с программой.');
  });
}

export async function writeParams() {
  return guard('Запись параметров', async () => {
    const why = canMutate();
    if (why) throw new Error(why);
    const problems = validateParams(state.params);
    if (problems.length) throw new Error(problems[0]);
    const l = needLink(), changed: Record<string, number> = {};
    for (const p of PARAMS) if (state.params[p.key] !== state.ecuParams[p.key]) changed[p.key] = state.params[p.key];
    if (!Object.keys(changed).length) { toast('info', 'Параметры в ECU уже совпадают с программой.'); return; }
    set({ busy: { label: 'Запись параметров', done: 0, total: 1 } });
    let back: Record<string, number>;
    try { back = await l.writeParams(changed); }
    catch (e) { await resyncAfterFailure(l, 'params', e); throw e; }
    set({ ecuParams: back, params: { ...back }, unsaved: true });
    toast('ok', `Записано параметров: ${Object.keys(changed).length}, сверка прошла.`);
  });
}

export function validateParams(v: Record<string, number>): string[] {
  const out: string[] = [];
  for (const p of PARAMS) {
    const x = v[p.key];
    if (!Number.isInteger(x)) out.push(`«${p.label}»: нужно целое число.`);
    else if (x < p.min || x > p.max) out.push(`«${p.label}»: допустимо от ${p.min} до ${p.max}.`);
  }
  if (v.tps_max_raw - v.tps_min_raw < 80) out.push('Диапазон TPS (открыт − закрыт) должен быть не меньше 80 отсчётов АЦП.');
  if (v.rev_limit_hard < v.rev_limit_soft + 100) out.push('Жёсткая отсечка должна быть минимум на 100 об/мин выше мягкой.');
  if (v.iac_crank_steps > v.iac_max_steps || v.iac_hot_steps > v.iac_max_steps) out.push('Положения РХХ не могут превышать полный ход.');
  if (v.iac_direction === 0) out.push('Направление РХХ: только −1 или 1.');
  return out;
}

export async function saveFlash() {
  return guard('Сохранение во Flash', async () => {
    const why = canMutate();
    if (why) throw new Error(why);
    await needLink().ok('SAVE', 1500, 1);
    set({ unsaved: false });
    toast('ok', 'Калибровки сохранены во Flash ECU.');
  });
}

export async function loadDefaults() {
  return guard('Сброс к заводским', async () => {
    const why = canMutate();
    if (why) throw new Error(why);
    await needLink().ok('DEFAULTS');
    await readAll(true);
    set({ unsaved: true });
    toast('ok', 'В RAM ECU загружены заводские калибровки. Во Flash они попадут только после «Сохранить во Flash».');
  });
}

export async function homeIac() {
  return guard('Калибровка РХХ', async () => {
    const why = canMutate();
    if (why) throw new Error(why);
    await needLink().ok('HOMEIAC');
    toast('ok', 'РХХ уходит в нулевое положение и возвращается в рабочее.');
  });
}

export async function clearFaults() {
  return guard('Сброс ошибок', async () => { await needLink().ok('CLEARFAULTS'); toast('ok', 'Ошибки и пик оборотов сброшены.'); });
}

export async function runTest(cmd: string) {
  return guard('Тест', async () => {
    const why = canMutate();
    if (why) { set({ testMessage: 'Заблокировано: ' + why }); throw new Error(why); }
    if (state.telemetry?.kill) { set({ testMessage: 'Заблокировано: активна аварийная чека STOP.' }); throw new Error('Активна аварийная чека STOP.'); }
    const def = ACTUATOR_TESTS.find((d) => d.cmd === cmd);
    await needLink().ok('TEST ' + cmd, 600, 0); // тесты не повторяем автоматически
    set({ testMessage: `Выполняется: ${def?.title ?? cmd} — ${def?.note ?? ''}` });
  });
}

/** Аварийный останов тестов: уходит вне очереди проверок и не требует условий. */
export async function stopTests() {
  try {
    await needLink().ok('TEST STOP', 400, 3);
    set({ testMessage: 'Остановлено. Все тестовые выходы выключены.' });
  } catch (e) { toast('error', 'СТОП не подтверждён ECU: ' + errText(e) + ' Выключите питание!'); }
}

// ---- правка карт с отменой ----
type Snapshot = { fuel: MapTable; ign: MapTable };
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
export function editMaps(fn: (fuel: MapTable, ign: MapTable) => void) {
  const fuel = cloneMap(state.fuel), ign = cloneMap(state.ign);
  fn(fuel, ign);
  if (mapsEqual(fuel, state.fuel) && mapsEqual(ign, state.ign)) return;
  undoStack.push({ fuel: state.fuel, ign: state.ign });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  set({ fuel, ign });
}
export function undo() { const s = undoStack.pop(); if (s) { redoStack.push({ fuel: state.fuel, ign: state.ign }); set(s); } }
export function redo() { const s = redoStack.pop(); if (s) { undoStack.push({ fuel: state.fuel, ign: state.ign }); set(s); } }
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export function revertMaps() { editMaps((f, i) => { for (let r = 0; r < f.length; r++) { f[r] = state.ecuFuel[r].slice(); i[r] = state.ecuIgn[r].slice(); } }); }

export const setParam = (key: string, value: number) => set({ params: { ...state.params, [key]: value } });
export const revertParams = () => set({ params: { ...state.ecuParams } });
export const setPage = (page: string) => { set({ page }); save('page', page); };
export const selectNet = (id: string | null) => set({ selectedNet: id });
export const setLogPaused = (p: boolean) => set({ logPaused: p });
export const clearLog = () => set({ log: [] });

// ---- запись телеметрии в CSV ----
export function toggleRecording() {
  if (!state.recording) { recorded = []; set({ recording: true, recordedRows: 0 }); return; }
  set({ recording: false, recordedRows: recorded.length });
  if (!recorded.length) { toast('info', 'Запись пуста: телеметрия не приходила.'); return; }
  downloadText(`vikhr30-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, 'time_ms,' + TELEMETRY_KEYS.join(',') + '\r\n' + recorded.join('\r\n') + '\r\n');
  toast('ok', `Сохранено строк: ${recorded.length}`);
}

export function downloadText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- настройки интерфейса между запусками ----
export function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem('vikhr30.' + key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
export function save(key: string, value: unknown) {
  try { localStorage.setItem('vikhr30.' + key, JSON.stringify(value)); } catch { /* хранилище недоступно — работаем без него */ }
}
state.page = load('page', 'dashboard');

// Отладочный доступ для автотестов в браузере — только в сборке `--dev`, в обычную сборку не попадает.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production')
  (window as unknown as Record<string, unknown>).__vikhr = { getState, getEmulator, getLink: () => link, undoDepth: () => [undoStack.length, redoStack.length] };
