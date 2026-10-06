// Расчёты, повторяющие целочисленную арифметику прошивки.
import { INJECTOR_CC_MIN, LOAD_BINS, RPM_BINS, type MapTable } from './types';

export interface Bracket { lo: number; hi: number; fraction: number } // fraction 0..1000

/** Точная копия bracket_value() из прошивки. */
export function bracket(value: number, bins: readonly number[]): Bracket {
  const n = bins.length;
  if (value <= bins[0]) return { lo: 0, hi: 0, fraction: 0 };
  if (value >= bins[n - 1]) return { lo: n - 1, hi: n - 1, fraction: 0 };
  for (let i = 0; i + 1 < n; i++)
    if (value <= bins[i + 1])
      return { lo: i, hi: i + 1, fraction: Math.trunc(((value - bins[i]) * 1000) / (bins[i + 1] - bins[i])) };
  return { lo: 0, hi: 0, fraction: 0 };
}

/** lerp_i32(): деление в C усекает к нулю. */
export function lerpI(a: number, b: number, fraction: number): number {
  return a + Math.trunc(((b - a) * fraction) / 1000);
}

/** Билинейная интерполяция карты так же, как lookup_fuel()/lookup_ignition(). */
export function lookupMap(map: MapTable, rpm: number, load10: number): number {
  const x = bracket(rpm, RPM_BINS), y = bracket(load10, LOAD_BINS);
  const a = lerpI(map[y.lo][x.lo], map[y.lo][x.hi], x.fraction);
  const b = lerpI(map[y.hi][x.lo], map[y.hi][x.hi], x.fraction);
  return lerpI(a, b, y.fraction);
}

export interface WorkPoint {
  rpm: Bracket;
  load: Bracket;
  /** Ячейки с весами интерполяции, по убыванию веса. */
  cells: { row: number; col: number; weight: number }[];
}

export function workPoint(rpm: number, load10: number): WorkPoint {
  const x = bracket(rpm, RPM_BINS), y = bracket(load10, LOAD_BINS);
  const fx = x.fraction / 1000, fy = y.fraction / 1000;
  const acc = new Map<string, { row: number; col: number; weight: number }>();
  const put = (row: number, col: number, w: number) => {
    const k = row + ':' + col, e = acc.get(k);
    if (e) e.weight += w; else acc.set(k, { row, col, weight: w });
  };
  put(y.lo, x.lo, (1 - fx) * (1 - fy));
  put(y.lo, x.hi, fx * (1 - fy));
  put(y.hi, x.lo, (1 - fx) * fy);
  put(y.hi, x.hi, fx * fy);
  return { rpm: x, load: y, cells: [...acc.values()].filter((c) => c.weight > 0.001).sort((a, b) => b.weight - a.weight) };
}

/** Расход топлива, мл/мин, по загрузке форсунки (0,1 %). */
export function fuelFlowMlMin(duty10: number): number {
  return Math.max(0, Math.min(INJECTOR_CC_MIN, (duty10 * INJECTOR_CC_MIN) / 1000));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Поправка мёртвого времени форсунки по напряжению — injector_deadtime(). */
export function injectorDeadtime(mv: number): number {
  const vb = [8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000];
  const dt = [1951, 1567, 1277, 1088, 876, 726, 649, 555, 491];
  if (mv <= vb[0]) return dt[0];
  if (mv >= vb[8]) return dt[8];
  for (let i = 0; i < 8; i++) if (mv <= vb[i + 1]) return dt[i] + Math.trunc(((mv - vb[i]) * (dt[i + 1] - dt[i])) / 1000);
  return dt[8];
}

/** Обогащение на прогреве — warmup_permille(). */
export function warmupPermille(cht10: number): number {
  const t = [-100, 0, 200, 400, 600, 750], f = [1450, 1350, 1200, 1100, 1030, 1000];
  if (cht10 <= t[0]) return f[0];
  if (cht10 >= t[5]) return f[5];
  for (let i = 0; i < 5; i++) if (cht10 <= t[i + 1]) return f[i] + Math.trunc(((cht10 - t[i]) * (f[i + 1] - f[i])) / (t[i + 1] - t[i]));
  return 1000;
}

/** Время накопления с поправкой по напряжению — coil_dwell(). */
export function coilDwell(baseUs: number, mv: number): number {
  const vb = [8000, 10000, 12000, 13800, 14500, 16000], fp = [1500, 1240, 1120, 1000, 1000, 940];
  let factor = fp[0];
  if (mv >= vb[5]) factor = fp[5];
  else for (let i = 0; i < 5; i++) if (mv <= vb[i + 1]) { factor = fp[i] + Math.trunc(((mv - vb[i]) * (fp[i + 1] - fp[i])) / (vb[i + 1] - vb[i])); break; }
  return clamp(Math.trunc((baseUs * factor) / 1000), 1000, 2600);
}

/** Разбор CSV карты в формате старой программы (первая строка и первый столбец — оси). */
export function parseMapCsv(text: string, scale: number): MapTable {
  // Если в файле есть «;» или табуляция (Excel с русскими настройками), запятая — десятичный знак, а не разделитель.
  const sep = /[;\t]/.test(text) ? /[;\t]/ : /,/;
  const rows = text.replace(/^\ufeff/, '').trim().split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => l.split(sep).map((c) => c.trim()));
  if (rows.length < 10) throw new Error('В файле меньше 10 строк: нужна строка оси и 9 строк нагрузки.');
  const out: MapTable = [];
  for (let r = 1; r <= 9; r++) {
    const cells = rows[r].slice(1, 14);
    if (cells.length < 13) throw new Error(`Строка ${r + 1}: нужно 13 значений, найдено ${cells.length}.`);
    out.push(cells.map((c, i) => {
      const v = Number(c.replace(',', '.'));
      if (!Number.isFinite(v)) throw new Error(`Строка ${r + 1}, столбец ${i + 2}: «${c}» не число.`);
      return Math.round(v * scale);
    }));
  }
  return out;
}

export function mapToCsv(map: MapTable, scale: number, digits: number): string {
  const head = 'TPS_pct,' + RPM_BINS.join(',');
  const lines = map.map((row, r) => `${LOAD_BINS[r] / 10},` + row.map((v) => (v / scale).toFixed(digits)).join(','));
  return [head, ...lines].join('\r\n') + '\r\n';
}

export const cloneMap = (m: MapTable): MapTable => m.map((r) => r.slice());
export function mapsEqual(a: MapTable, b: MapTable): boolean {
  for (let r = 0; r < a.length; r++) for (let c = 0; c < a[r].length; c++) if (a[r][c] !== b[r]?.[c]) return false;
  return true;
}
export function diffCells(a: MapTable, b: MapTable): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = [];
  for (let r = 0; r < a.length; r++) for (let c = 0; c < a[r].length; c++) if (a[r][c] !== b[r][c]) out.push({ row: r, col: c });
  return out;
}
