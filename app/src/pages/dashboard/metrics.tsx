// Показатели страницы «Приборы»: единицы, диапазоны, цвета состояния.
import { fuelFlowMlMin, lookupMap } from '../../core/calc';
import type { MapTable, Telemetry } from '../../core/types';
import { fmt } from '../../ui/kit';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'plain';
export const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', info: 'var(--info)', plain: 'var(--text)',
};

/** То, что нужно для оценки «норма / не норма» помимо самой телеметрии. */
export interface Ctx { params: Record<string, number>; ecuIgn: MapTable; mapsLoaded: boolean }

export const CHT_COLD = 40, CHT_HOT = 85;

export function rpmTone(t: Telemetry, c: Ctx): Tone {
  return t.rpm >= c.params.rev_limit_hard ? 'danger' : t.rpm >= c.params.rev_limit_soft ? 'warn' : 'plain';
}
export function mapTone(t: Telemetry): Tone {
  const v = t.map10 / 10;
  return v < 15 || v > 115 ? 'danger' : v < 20 || v > 110 ? 'warn' : 'ok';
}
/** Дроссель оценивается по сырому АЦП относительно калибровки: выход за неё — признак обрыва или сбитой настройки. */
export function tpsTone(t: Telemetry, c: Ctx): Tone {
  const lo = c.params.tps_min_raw, hi = c.params.tps_max_raw;
  if (!t.tpsRaw && !t.tps10) return 'ok'; // старая прошивка без поля tpsRaw
  return t.tpsRaw < lo - 100 || t.tpsRaw > hi + 100 ? 'danger' : t.tpsRaw < lo || t.tpsRaw > hi ? 'warn' : 'ok';
}
export function chtTone(t: Telemetry): Tone {
  const v = t.cht10 / 10;
  return v > CHT_HOT ? 'danger' : v < CHT_COLD ? 'info' : 'ok';
}
export function vbatTone(t: Telemetry): Tone {
  const v = t.batteryMv / 1000;
  return v < 11 || v > 15.5 ? 'danger' : v < 12 || v > 14.8 ? 'warn' : 'ok';
}
export function dutyTone(t: Telemetry): Tone {
  return t.duty10 <= 750 ? 'ok' : t.duty10 <= 850 ? 'warn' : 'danger';
}
/** УОЗ сравнивается с тем, что должна выдать карта в ECU (как в старой программе): ±2° норма, ±5° предупреждение. */
export function advanceTone(t: Telemetry, c: Ctx): Tone {
  if (t.rpm <= 0 || !c.mapsLoaded) return 'plain';
  let expected = c.params.fixed_ign_tenths >= 0 ? c.params.fixed_ign_tenths : lookupMap(c.ecuIgn, t.rpm, t.tps10);
  if (t.rpm < 450) expected = 50;
  if (t.cht10 > 850) expected -= Math.max(0, Math.min(70, Math.trunc(((t.cht10 - 850) * 3) / 10)));
  expected = Math.max(0, Math.min(300, expected));
  const err = Math.abs(t.advance10 - expected);
  return err <= 20 ? 'ok' : err <= 50 ? 'warn' : 'danger';
}

export interface Mixture { text: string; sub: string; tone: Tone | 'nodata' }
export function mixture(t: Telemetry): Mixture {
  if (t.lambdaMilli > 0) {
    // Широкополосный вход у края шкалы (обрыв, воздух в выпуске): прошивка сама помечает значение недостоверным.
    if (t.lambdaDir === 2) return { text: 'нет данных', sub: fmt(t.o2Mv / 1000, 2) + ' В', tone: 'nodata' };
    // Цель как в прошивке: 0,98 до 30 % дросселя, 0,875 от 70 %, между ними линейно.
    const target = t.tps10 <= 300 ? 0.98 : t.tps10 >= 700 ? 0.875 : 0.98 - (t.tps10 - 300) * (0.105 / 400);
    const err = Math.abs(t.lambdaMilli / 1000 - target);
    return { text: 'λ ' + fmt(t.lambdaMilli / 1000, 3), sub: 'цель ' + fmt(target, 2), tone: err <= 0.04 ? 'ok' : err <= 0.08 ? 'warn' : 'danger' };
  }
  const sub = t.o2Mv + ' мВ';
  if (t.lambdaDir === 2) return { text: 'нет данных', sub, tone: 'nodata' };
  if (t.lambdaDir < 0) return { text: 'богатая', sub, tone: 'warn' };
  if (t.lambdaDir > 0) return { text: 'бедная', sub, tone: 'warn' };
  return { text: 'норма', sub, tone: 'ok' };
}

export type Mode = 'hide' | 'num' | 'graph';
export interface Metric {
  id: string;
  title: string;
  unit: string;
  /** Цвет линии графика (не цвет состояния). */
  color: string;
  min: number;
  max: number;
  digits: number;
  base: keyof Telemetry;
  conv: (raw: number) => number;
  tone?: (t: Telemetry, c: Ctx) => Tone;
  note?: (t: Telemetry) => string;
  def: Mode;
}

const same = (v: number) => v;
export const METRICS: Metric[] = [
  { id: 'rpm', title: 'Обороты', unit: 'об/мин', color: '#2fd4c2', min: 0, max: 8000, digits: 0, base: 'rpm', conv: same, tone: rpmTone, note: (t) => 'пик ' + t.peak, def: 'graph' },
  { id: 'tps', title: 'Дроссель', unit: '%', color: '#5b8def', min: 0, max: 100, digits: 1, base: 'tps10', conv: (v) => v / 10, tone: tpsTone, note: (t) => 'АЦП ' + t.tpsRaw, def: 'num' },
  { id: 'map', title: 'Давление во впуске (MAP)', unit: 'кПа', color: '#a674ff', min: 0, max: 120, digits: 1, base: 'map10', conv: (v) => v / 10, tone: mapTone, note: (t) => 'атм. ' + fmt(t.baro10 / 10, 1), def: 'num' },
  { id: 'cht', title: 'Температура головки (CHT)', unit: '°C', color: '#ff8f5c', min: 0, max: 120, digits: 1, base: 'cht10', conv: (v) => v / 10, tone: chtTone, def: 'graph' },
  { id: 'iat', title: 'Температура воздуха (IAT)', unit: '°C', color: '#6ec1ff', min: -20, max: 80, digits: 1, base: 'iat10', conv: (v) => v / 10, def: 'num' },
  { id: 'vbat', title: 'Бортсеть', unit: 'В', color: '#e0b3ff', min: 8, max: 18, digits: 2, base: 'batteryMv', conv: (v) => v / 1000, tone: vbatTone, def: 'num' },
  { id: 'o2', title: 'Сигнал лямбды', unit: 'мВ', color: '#e56bb5', min: 0, max: 1000, digits: 0, base: 'o2Mv', conv: same, note: (t) => mixture(t).text, def: 'graph' },
  { id: 'pw', title: 'Впрыск', unit: 'мс', color: '#44c9dd', min: 0, max: 10, digits: 2, base: 'pwUs', conv: (v) => v / 1000, tone: dutyTone, def: 'graph' },
  { id: 'adv', title: 'УОЗ', unit: '°', color: '#f2a65a', min: 0, max: 35, digits: 1, base: 'advance10', conv: (v) => v / 10, tone: advanceTone, note: () => 'до ВМТ', def: 'num' },
  { id: 'dwell', title: 'Время накопления', unit: 'мс', color: '#9fb4ff', min: 0, max: 3, digits: 2, base: 'preparedDwellUs', conv: (v) => v / 1000, def: 'num' },
  { id: 'iac', title: 'РХХ', unit: 'шаг', color: '#7fd1a8', min: 0, max: 300, digits: 0, base: 'iacPos', conv: same, note: (t) => 'цель ' + t.iacTarget, def: 'num' },
  { id: 'duty', title: 'Загрузка форсунки', unit: '%', color: '#4fb0c6', min: 0, max: 100, digits: 1, base: 'duty10', conv: (v) => v / 10, tone: dutyTone, def: 'num' },
  { id: 'flow', title: 'Расход топлива', unit: 'мл/мин', color: '#c9a2ff', min: 0, max: 540, digits: 1, base: 'duty10', conv: fuelFlowMlMin, tone: dutyTone, note: (t) => fmt(fuelFlowMlMin(t.duty10) * 0.06, 2) + ' л/ч', def: 'num' },
  { id: 'accel', title: 'Обогащение при ускорении', unit: '%', color: '#ffb38a', min: 0, max: 50, digits: 1, base: 'accelPermille', conv: (v) => (v - 1000) / 10, def: 'num' },
  { id: 'tooth', title: 'Период зуба', unit: 'мкс', color: '#8fa9c4', min: 0, max: 5000, digits: 0, base: 'toothUs', conv: same, note: (t) => (t.toothIndex === 255 ? 'зуб — нет' : 'зуб ' + t.toothIndex), def: 'num' },
];
