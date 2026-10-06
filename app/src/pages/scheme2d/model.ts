// Декларативное описание листа принципиальной схемы: элементы на сетке 10 и провода-ломаные.
import { schemePart, type BlockId } from '../../core/hardware';

export type Pt = [number, number];

/** Двухвыводные элементы: выводы a (−30,0) и b (30,0) до поворота. */
export type Kind2 = 'R' | 'C' | 'CP' | 'D' | 'DS' | 'DZ' | 'L' | 'F' | 'SW' | 'RT' | 'M' | 'BAT';
/** Транзисторы: g/база (−30,0), d/коллектор (10,−30), s/эмиттер (10,30). */
export type Kind3 = 'NMOS' | 'IGBT' | 'NPN';
/** Внешние нагрузки с двумя выводами слева: (0,−10) и (0,10). */
export type KindLoad = 'IGN' | 'WIND' | 'HEAT' | 'KCOIL';

export interface IcPin { num?: string; name: string }

interface Base { x: number; y: number; ref?: string; val?: string; role?: string; verify?: boolean }
export type El = Base & (
  | { k: Kind2; rot: 0 | 1 | 2 | 3; lp?: 't' | 'b' | 'l' | 'r' | 't1' | 'b1'; pn?: [string, string] }
  | { k: Kind3; flip?: boolean; lp?: 'l' | 'r'; pn?: [string, string, string] }
  | { k: 'POT'; flip?: boolean }
  | { k: KindLoad; note?: string }
  | { k: 'ic'; w: number; left: (IcPin | null)[]; right: (IcPin | null)[] }
  | { k: 'conn'; w: number; rows: string[] }
  | { k: 'pwr'; net: string; v?: boolean; lbl?: 'r' | 'l' }
  | { k: 'gnd' }
  | { k: 'tag'; net: string; side: 'l' | 'r' | 't' | 'b'; text?: string; desc?: string; anchor?: 'start' | 'middle' | 'end'; v?: boolean; plain?: boolean }
  | { k: 'nc'; text?: string; side?: 'l' | 'r' }
  | { k: 'text'; text: string; anchor?: 'start' | 'middle' | 'end'; cls?: string }
  | { k: 'frame'; w: number; h: number; title: string }
  | { k: 'block'; w: number; h: number; title: string; sub?: string; block: BlockId; sheet: string; ext?: boolean }
  | { k: 'line'; to: Pt }
);

export interface Wire { net: string | null; pts: Pt[]; dash?: boolean }
export interface Sheet { id: string; title: string; w: number; h: number; els: El[]; wires: Wire[]; notes: string[] }

/** Цепи, которых нет в NETS, но которые нужно назвать на схеме. */
export interface LocalNet { name: string; title: string; color: string; measureAs?: string }
export const LOCAL_NETS: Record<string, LocalNet> = {
  F2: { name: '+12V_F2', title: 'Питание нагрузок: плюс аккумулятора после предохранителя F2 10 А. Напряжение — как на BAT+', color: '#ff7a5c', measureAs: 'BAT' },
  SWDIO: { name: 'SWDIO', title: 'Линия данных отладчика (PA13)', color: '#9fb0c0' },
  SWCLK: { name: 'SWCLK', title: 'Линия тактов отладчика (PA14)', color: '#9fb0c0' },
};

const rotPt = (p: Pt, rot: number): Pt => { let [x, y] = p; for (let i = 0; i < rot; i++) [x, y] = [-y, x]; return [x, y]; };
const add = (o: { x: number; y: number }, p: Pt): Pt => [o.x + p[0], o.y + p[1]];

const K2 = new Set(['R', 'C', 'CP', 'D', 'DS', 'DZ', 'L', 'F', 'SW', 'RT', 'M', 'BAT']);
const K3 = new Set(['NMOS', 'IGBT', 'NPN']);
const KL = new Set(['IGN', 'WIND', 'HEAT', 'KCOIL']);
export const isK2 = (e: El): e is Extract<El, { k: Kind2 }> => K2.has(e.k);
export const isK3 = (e: El): e is Extract<El, { k: Kind3 }> => K3.has(e.k);
export const isLoad = (e: El): e is Extract<El, { k: KindLoad }> => KL.has(e.k);

export const icH = (e: { left: unknown[]; right: unknown[] }) => 20 * Math.max(e.left.length, e.right.length) + 20;

/** Точки подключения элемента (в координатах листа). */
export function pinsOf(e: El): Pt[] {
  if (isK2(e)) return [add(e, rotPt([-30, 0], e.rot)), add(e, rotPt([30, 0], e.rot))];
  if (isK3(e)) { const f = e.flip ? -1 : 1; return [add(e, [-30 * f, 0]), add(e, [10 * f, -30]), add(e, [10 * f, 30])]; }
  if (isLoad(e)) return [add(e, [0, -10]), add(e, [0, 10])];
  switch (e.k) {
    case 'POT': return [add(e, [0, -20]), add(e, [0, 20]), add(e, [e.flip ? -20 : 20, 0])];
    case 'ic': {
      const out: Pt[] = [];
      e.left.forEach((p, i) => { if (p) out.push([e.x - 20, e.y + 20 + 20 * i]); });
      e.right.forEach((p, i) => { if (p) out.push([e.x + e.w + 20, e.y + 20 + 20 * i]); });
      return out;
    }
    case 'conn': return e.rows.flatMap((_, i): Pt[] => [[e.x, e.y + 10 + 20 * i], [e.x + e.w, e.y + 10 + 20 * i]]);
    case 'tag': return e.plain ? [] : [[e.x, e.y]];
    case 'pwr': case 'gnd': case 'nc': return [[e.x, e.y]];
    default: return [];
  }
}

/** Габарит условного обозначения без подписей: [x0, y0, x1, y1]. */
export function bodyOf(e: El): [number, number, number, number] | null {
  if (isK2(e)) { const v = e.rot % 2 === 1; return v ? [e.x - 12, e.y - 22, e.x + 12, e.y + 22] : [e.x - 22, e.y - 12, e.x + 22, e.y + 12]; }
  if (isK3(e)) return [e.x - 17, e.y - 19, e.x + 21, e.y + 19];
  if (isLoad(e)) return [e.x + 8, e.y - 26, e.x + (e.k === 'IGN' ? 60 : 40), e.y + 26];
  switch (e.k) {
    case 'POT': return [e.x - 8, e.y - 15, e.x + 8, e.y + 15];
    case 'ic': return [e.x, e.y, e.x + e.w, e.y + icH(e)];
    case 'conn': return [e.x + 1, e.y, e.x + e.w - 1, e.y + 20 * e.rows.length];
    case 'block': return [e.x, e.y, e.x + e.w, e.y + e.h];
    default: return null;
  }
}

/** Перенос текста по словам; продолжение абзаца — с отступом. */
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > max) { out.push(line); line = '   ' + word; } else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out;
}

/** Сборщик листа: элементы возвращают свои выводы, провода достраиваются до прямых углов. */
export class SheetBuilder {
  els: El[] = [];
  wires: Wire[] = [];
  notes: string[] = [];
  /** h — высота рисунка без примечаний: место под них добавляется само. */
  constructor(public id: string, public title: string, public w: number, public h: number) {}

  private part<T extends El>(e: T): T {
    if (e.ref) {
      const p = schemePart(e.ref);
      if (!p) throw new Error(`Нет элемента ${e.ref} в SCHEME_PARTS`);
      if (e.val === undefined) e.val = p.value;
      e.role = p.role;
      e.verify = !!p.verify;
    }
    this.els.push(e);
    return e;
  }
  /** Двухвыводной элемент; rot: 0 — a слева, 1 — a сверху, 2 — a справа, 3 — a снизу. */
  two(k: Kind2, ref: string, x: number, y: number, rot: 0 | 1 | 2 | 3 = 0, o: { lp?: 't' | 'b' | 'l' | 'r' | 't1' | 'b1'; val?: string; pn?: [string, string] } = {}) {
    const e = this.part({ k, ref, x, y, rot, ...o } as El);
    const [a, b] = pinsOf(e);
    return { a, b };
  }
  tr(k: Kind3, ref: string, x: number, y: number, o: { flip?: boolean; lp?: 'l' | 'r'; pn?: [string, string, string] } = {}) {
    const [g, d, s] = pinsOf(this.part({ k, ref, x, y, ...o } as El));
    return { g, d, s };
  }
  pot(ref: string, x: number, y: number, val?: string) { const [a, b, w] = pinsOf(this.part({ k: 'POT', ref, x, y, val } as El)); return { a, b, w }; }
  load(k: KindLoad, ref: string, x: number, y: number, o: { val?: string; note?: string } = {}) { const [a, b] = pinsOf(this.part({ k, ref, x, y, ...o } as El)); return { a, b }; }
  ic(ref: string, x: number, y: number, w: number, left: (IcPin | string | null)[], right: (IcPin | string | null)[], val?: string) {
    const norm = (l: (IcPin | string | null)[]) => l.map((p) => (typeof p === 'string' ? (p.includes('|') ? { num: p.split('|')[0], name: p.split('|')[1] } : { name: p }) : p));
    const e = this.part({ k: 'ic', ref, x, y, w, left: norm(left), right: norm(right), val } as El) as Extract<El, { k: 'ic' }>;
    return { l: e.left.map((_, i): Pt => [x - 20, y + 20 + 20 * i]), r: e.right.map((_, i): Pt => [x + w + 20, y + 20 + 20 * i]) };
  }
  conn(ref: string, x: number, y: number, w: number, rows: string[]) {
    this.part({ k: 'conn', ref, x, y, w, rows } as El);
    return { l: rows.map((_, i): Pt => [x, y + 10 + 20 * i]), r: rows.map((_, i): Pt => [x + w, y + 10 + 20 * i]) };
  }
  pwr(net: string, x: number, y: number, o: { v?: boolean; lbl?: 'r' | 'l' } = {}): Pt { this.els.push({ k: 'pwr', net, x, y, ...o }); return [x, y]; }
  gnd(x: number, y: number): Pt { this.els.push({ k: 'gnd', x, y }); return [x, y]; }
  tag(net: string, x: number, y: number, side: 'l' | 'r' | 't' | 'b', o: { text?: string; desc?: string; anchor?: 'start' | 'middle' | 'end'; v?: boolean; plain?: boolean } = {}): Pt {
    this.els.push({ k: 'tag', net, x, y, side, v: true, ...o });
    return [x, y];
  }
  nc(x: number, y: number, text?: string, side: 'l' | 'r' = 'r') { this.els.push({ k: 'nc', x, y, text, side }); }
  text(x: number, y: number, text: string, o: { anchor?: 'start' | 'middle' | 'end'; cls?: string } = {}) { this.els.push({ k: 'text', x, y, text, ...o }); }
  frame(x: number, y: number, w: number, h: number, title: string) { this.els.push({ k: 'frame', x, y, w, h, title }); }
  line(a: Pt, b: Pt) { this.els.push({ k: 'line', x: a[0], y: a[1], to: b }); }
  block(block: BlockId, x: number, y: number, w: number, h: number, title: string, sheet: string, o: { sub?: string; ext?: boolean } = {}) {
    this.els.push({ k: 'block', block, x, y, w, h, title, sheet, ...o });
    return { l: (dy = h / 2): Pt => [x, y + dy], r: (dy = h / 2): Pt => [x + w, y + dy], t: (dx = w / 2): Pt => [x + dx, y], b: (dx = w / 2): Pt => [x + dx, y + h] };
  }
  private route(net: string | null, pts: Pt[], vFirst: boolean, dash = false) {
    const out: Pt[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = out[out.length - 1], b = pts[i];
      if (a[0] !== b[0] && a[1] !== b[1]) out.push(vFirst ? [a[0], b[1]] : [b[0], a[1]]);
      out.push(b);
    }
    this.wires.push({ net, pts: out, dash });
  }
  /** Провод цепи; на изломах сначала горизонталь, затем вертикаль. */
  wire(net: string | null, ...pts: Pt[]) { this.route(net, pts, false); }
  /** То же, но сначала вертикаль. */
  wireV(net: string | null, ...pts: Pt[]) { this.route(net, pts, true); }
  dashed(net: string | null, ...pts: Pt[]) { this.route(net, pts, false, true); }
  note(s: string) { this.notes.push(s); }
  done(): Sheet {
    const notes = this.notes.flatMap((n) => wrap(n, Math.floor((this.w - 40) / 6.5)));
    return { id: this.id, title: this.title, w: this.w, h: this.h + notes.length * 15 + 14, els: this.els, wires: this.wires, notes };
  }
}

/** Точки соединения проводов: там, где сходятся три и более ветви одной цепи. */
export function junctions(sheet: Sheet): { p: Pt; net: string | null }[] {
  const deg = new Map<string, { p: Pt; n: number; net: string | null }>();
  const cand: { p: Pt; net: string | null; wi: number }[] = [];
  sheet.wires.forEach((w, wi) => w.pts.forEach((p) => cand.push({ p, net: w.net, wi })));
  const pins = sheet.els.flatMap(pinsOf);
  for (const c of cand) {
    const key = c.p.join(',');
    if (deg.has(key)) continue;
    let n = 0;
    for (const w of sheet.wires) {
      for (let i = 1; i < w.pts.length; i++) {
        const a = w.pts[i - 1], b = w.pts[i], [x, y] = c.p;
        const on = a[0] === b[0] ? x === a[0] && y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1]) : y === a[1] && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]);
        if (!on) continue;
        const end = (x === a[0] && y === a[1]) || (x === b[0] && y === b[1]);
        // пересечение проводов РАЗНЫХ цепей серединами — не соединение
        if (w.net !== c.net && !end) continue;
        if (a[0] === b[0] && a[1] === b[1]) continue;
        n += end ? 1 : 2;
      }
    }
    n += pins.filter((q) => q[0] === c.p[0] && q[1] === c.p[1]).length;
    deg.set(key, { p: c.p, n, net: c.net });
  }
  return [...deg.values()].filter((d) => d.n >= 3).map((d) => ({ p: d.p, net: d.net }));
}
