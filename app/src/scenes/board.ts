// 3D-схема блока управления: макетная плата, внешние устройства и все цепи из NETS.
// Раскладка задана таблицей LAYOUT; провода прокладываются автоматически по NETS.path
// через «каналы» (полосы свободного места) вокруг Blue Pill и вокруг платы.
import { MAT, Node3, type Material, type Viewer } from '../gl/viewer';
import { box, cylinder, extrude, lathe, merge, placed, roundedRect, smoothPath, sphere, torus, transform, tube, type Geometry } from '../gl/geometry';
import { M, V, type Mat4, type Vec3 } from '../gl/math';
import { BLOCKS, NETS, probeNet, type BlockId, type NetDef } from '../core/hardware';
import { getState } from '../core/store';

// ───────────────────────── раскладка ─────────────────────────

type Side = 'L' | 'R' | 'T' | 'B';
interface Slot {
  /** Центр блока (x, z). */
  c: [number, number];
  /** Полуразмеры (по x, по z). */
  half: [number, number];
  /** С какой стороны от Blue Pill (для платы) или от платы (для внешних устройств) стоит блок. */
  side: Side;
  /** Явные смещения клемм вдоль края блока: по идентификатору цепи. */
  outAt?: Record<string, number>;
}

const BOARD_W = 22, BOARD_D = 14;       // условные сантиметры
const TABLE_Y = -0.6;
const stripL = (i: number): Slot => ({ c: [-8.85, -5.95 + 1.7 * i], half: [2.05, 0.75], side: 'L' });
const stripR = (i: number): Slot => ({ c: [8.85, -5.75 + 2.3 * i], half: [2.05, 1.0], side: 'R' });
const extL = (z: number, hz = 0.75): Slot => ({ c: [-16, z], half: [1.4, hz], side: 'L' });
const extR = (z: number, hz = 1.0): Slot => ({ c: [16, z], half: [1.4, hz], side: 'R' });

/** Положение каждого блока. Входы — слева, силовые выходы — справа, питание — сверху, связь — снизу. */
export const LAYOUT: Record<BlockId, Slot> = {
  mcu: { c: [0, 0], half: [3.9, 1.5], side: 'T' },
  pwr: { c: [0, -5.75], half: [5.2, 1.05], side: 'T', outAt: { V5S: -4.6, BAT: -3.3, GND: -2.7, V12: 4.6 } },
  bt: { c: [0, 5.75], half: [2.4, 1.05], side: 'B' },
  in_vbat: stripL(0), in_tps: stripL(1), in_map: stripL(2), in_cht: stripL(3), in_iat: stripL(4), in_crank: stripL(5), in_sw: stripL(6), in_o2: stripL(7),
  out_coil1: stripR(0), out_coil2: stripR(1), out_inj: stripR(2), out_pump: stripR(3), out_iac: stripR(4), out_heater: stripR(5),
  x_batt: { c: [-3, -11.9], half: [2.4, 1.5], side: 'T' },
  x_tps: extL(-4.25), x_map: extL(-2.55), x_cht: extL(-0.85), x_iat: extL(0.85), x_hall: extL(2.55),
  x_service: extL(3.72, 0.42), x_kill: extL(4.86, 0.6),
  x_o2: { c: [-8.6, 12.1], half: [1.1, 1.5], side: 'B' },
  x_coil1: extR(-5.75), x_coil2: extR(-3.45), x_inj: extR(-1.15), x_pump: extR(1.15), x_iac: extR(3.45),
  x_pc: { c: [1.2, 12.4], half: [2.4, 1.7], side: 'B' },
};

// Blue Pill: шаг контактов и расположение гребёнок (нумерация от micro-USB, см. SCHEMATICS_RU.md).
const PIN_PITCH = 0.36, ROW_Z = 1.2, PIN_TOP = 0.8;
const JL = ['VBAT', 'PC13', 'PC14', 'PC15', 'PA0', 'PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6', 'PA7', 'PB0', 'PB1', 'PB10', 'PB11', 'NRST', '3V3b', 'GND', 'GNDb'];
const JR = ['3V3', 'GNDa', '5V', 'PB9', 'PB8', 'PB7', 'PB6', 'PB5', 'PB4', 'PB3', 'PA15', 'PA12', 'PA11', 'PA10', 'PA9', 'PA8', 'PB15', 'PB14', 'PB13', 'PB12'];
const pinX = (i: number) => -3.42 + PIN_PITCH * i;
function pinPos(name: string): { x: number; row: -1 | 1 } {
  let i = JL.indexOf(name);
  if (i >= 0) return { x: pinX(i), row: -1 };   // левая гребёнка — дальняя от зрителя (z < 0)
  i = JR.indexOf(name);
  return { x: pinX(Math.max(0, i)), row: 1 };
}

/** Короткие подписи блоков для 3D-вида (полные названия — в карточке блока). */
const SHORT: Record<BlockId, string> = {
  mcu: 'Blue Pill', pwr: 'Питание', bt: 'Bluetooth HC-06', in_tps: 'Вход TPS', in_map: 'Вход MAP', in_cht: 'Вход CHT', in_iat: 'Вход IAT', in_vbat: 'Бортсеть',
  in_o2: 'Вход лямбды', in_crank: 'Вход ДПКВ', in_sw: 'SERVICE, STOP', out_coil1: 'Ключ катушки 1', out_coil2: 'Ключ катушки 2', out_inj: 'Ключ форсунки',
  out_pump: 'Ключ насоса', out_heater: 'Нагрев лямбды', out_iac: 'Драйвер РХХ', x_batt: 'Аккумулятор', x_tps: 'Дроссель', x_map: 'MAP', x_cht: 'CHT', x_iat: 'IAT',
  x_o2: 'Лямбда-зонд', x_hall: 'Датчик Холла', x_service: 'SERVICE', x_kill: 'Чека STOP', x_coil1: 'Катушка 1', x_coil2: 'Катушка 2', x_inj: 'Форсунка',
  x_pump: 'Реле и насос', x_iac: 'РХХ', x_pc: 'Программа',
};
const isBoard = (id: BlockId) => !id.startsWith('x_');

// ───────────────────────── прокладка проводов ─────────────────────────

type Ring = 'in' | 'out';
interface Term { p: Vec3; out: Vec3; side: Side; tip: Vec3 }
interface WireDef { net: NetDef; key: string; ring: Ring; a: Term; b: Term; power: boolean }
export interface WirePath { net: string; pts: Vec3[]; radius: number }
interface Seg { ring: Ring; net: string; x0: number; z0: number; x1: number; z1: number }

const RING = {
  in: { L: 4.3, R: 4.3, T: 1.8, B: 1.8, pitch: 0.17, y: 0.075, lead: 0, fillet: 0.11, hopW: 0.2, hopH: 0.17 },
  out: { L: 12.25, R: 12.25, T: 8.25, B: 8.25, pitch: 0.3, y: TABLE_Y + 0.1, lead: 0.9, fillet: 0.25, hopW: 0.36, hopH: 0.34 },
} as const;

export interface Wiring {
  wires: WirePath[];
  /** Точка для красного щупа по каждой цепи. */
  probe: Record<string, Vec3>;
  /** Клемма GND платы — для чёрного щупа. */
  ground: Vec3;
  terms: { block: BlockId; ring: Ring; net: string; t: Term }[];
  /** Для самопроверки: наложения параллельных участков разных цепей и число занятых полос. */
  overlaps: string[];
  lanes: Record<string, number>;
}

/** Чистая функция: вся геометрия цепей по таблицам NETS и LAYOUT. */
export function computeWiring(): Wiring {
  // 1. список соединений «блок — блок»
  interface Pair { net: NetDef; key: string; a: BlockId; b: BlockId; sub: number }
  const pairs: Pair[] = [];
  for (const net of NETS) {
    if (net.path.length < 2) continue;
    const subs = net.id === 'IAC_IN' || net.id === 'IAC_OUT' ? 4 : 1;
    const star = net.kind === 'power';
    for (let i = 1; i < net.path.length; i++)
      for (let s = 0; s < subs; s++)
        pairs.push({ net, key: net.id + (subs > 1 ? '#' + s : ''), a: star ? net.path[0] : net.path[i - 1], b: net.path[i], sub: s });
  }
  // 2. клеммы блоков: какие цепи выходят на каждую сторону блока
  const need = new Map<string, string[]>();           // "блок|кольцо" → ключи цепей по порядку
  const partner = new Map<string, BlockId>();         // "блок|кольцо|ключ" → с кем соединён
  for (const p of pairs) {
    const ring: Ring = isBoard(p.a) && isBoard(p.b) ? 'in' : 'out';
    for (const [me, other] of [[p.a, p.b], [p.b, p.a]] as const) {
      if (me === 'mcu') continue;
      const k = me + '|' + ring, list = need.get(k) ?? [];
      if (!list.includes(p.key)) list.push(p.key);
      need.set(k, list);
      if (!partner.has(k + '|' + p.key)) partner.set(k + '|' + p.key, other);
    }
  }
  const terms = new Map<string, Term>();
  const mk = (slot: Slot, face: 'inner' | 'outer' | 'device', off: number, y: number): Term => {
    const [cx, cz] = slot.c, [hx, hz] = slot.half;
    // inner — сторона, обращённая к Blue Pill; outer — к краю платы; device — сторона устройства, обращённая к плате
    const toCentre = face !== 'outer';
    let p: Vec3, out: Vec3;
    if (slot.side === 'L') { out = [toCentre ? 1 : -1, 0, 0]; p = [cx + out[0] * hx, y, cz + off]; }
    else if (slot.side === 'R') { out = [toCentre ? -1 : 1, 0, 0]; p = [cx + out[0] * hx, y, cz + off]; }
    else if (slot.side === 'T') { out = [0, 0, toCentre ? 1 : -1]; p = [cx + off, y, cz + out[2] * hz]; }
    else { out = [0, 0, toCentre ? -1 : 1]; p = [cx + off, y, cz + out[2] * hz]; }
    const back = face === 'inner' ? 0 : face === 'outer' ? 0.2 : 0.12;
    return { p, out, side: slot.side, tip: [p[0] - out[0] * back, y + (face === 'inner' ? 0.04 : face === 'outer' ? 0.17 : 0.12), p[2] - out[2] * back] };
  };
  const tangent = (t: Term) => (t.side === 'L' || t.side === 'R' ? t.p[2] : t.p[0]);
  // сначала клеммы блоков платы, затем устройства (они выравниваются по клеммам платы)
  const keys = [...need.keys()].sort((a, b) => Number(a.startsWith('x_')) - Number(b.startsWith('x_')));
  for (const k of keys) {
    const [blockId, ring] = k.split('|') as [BlockId, Ring], slot = LAYOUT[blockId], list = need.get(k)!;
    const centre = slot.side === 'L' || slot.side === 'R' ? slot.c[1] : slot.c[0];
    if (isBoard(blockId)) {
      const pitch = ring === 'in' ? 0.3 : 0.45;
      list.forEach((key, j) => {
        const id = key.split('#')[0], sub = Number(key.split('#')[1] ?? 0);
        const off = ring === 'out' && slot.outAt && id in slot.outAt ? slot.outAt[id] + sub * pitch : (j - (list.length - 1) / 2) * pitch;
        terms.set(k + '|' + key, mk(slot, ring === 'in' ? 'inner' : 'outer', off, ring === 'in' ? RING.in.y : 0.3));
      });
    } else {
      const used: number[] = [], free: string[] = [];
      for (const key of list) {
        const other = partner.get(k + '|' + key)!, ot = terms.get(other + '|out|' + key);
        if (ot && LAYOUT[other].side === slot.side && isBoard(other)) {
          const off = tangent(ot) - centre;
          terms.set(k + '|' + key, mk(slot, 'device', off, TABLE_Y + 0.32));
          used.push(off);
        } else free.push(key);
      }
      free.forEach((key, j) => {
        const off = used.length ? Math.max(...used) + 0.45 * (j + 1) : (j - (free.length - 1) / 2) * 0.45;
        terms.set(k + '|' + key, mk(slot, 'device', off, TABLE_Y + 0.32));
      });
    }
  }
  const pinTerm = (name: string): Term => {
    const { x, row } = pinPos(name);
    return { p: [x, RING.in.y, row * (ROW_Z + 0.32)], out: [0, 0, row], side: row < 0 ? 'T' : 'B', tip: [x, PIN_TOP, row * ROW_Z] };
  };
  const pinName = (net: NetDef, sub: number): string => {
    if (net.id === 'V5') return '5V';
    if (net.id === 'V33') return '3V3';
    if (net.id === 'GND') return 'GND';
    if (net.id === 'IAC_IN') return ['PB6', 'PB7', 'PB8', 'PB9'][sub];
    return net.mcuPin ?? 'PA0';
  };

  // 3. соединения с клеммами
  const defs: WireDef[] = pairs.map((p) => {
    const ring: Ring = isBoard(p.a) && isBoard(p.b) ? 'in' : 'out';
    const term = (id: BlockId) => (id === 'mcu' ? pinTerm(pinName(p.net, p.sub)) : terms.get(id + '|' + ring + '|' + p.key)!);
    return { net: p.net, key: p.key, ring, a: term(p.a), b: term(p.b), power: p.net.kind === 'power' || p.net.kind === 'ground' };
  });
  // питание прокладываем первым: остальные провода перешагивают через него
  defs.sort((a, b) => Number(b.power) - Number(a.power));

  // 4. полосы в каналах и маршрут
  const laneCount: Record<string, number> = {}, laneOf = new Map<string, number>();
  const lane = (ring: Ring, side: Side, key: string): number => {
    const id = ring + side, k = id + '|' + key;
    let n = laneOf.get(k);
    if (n === undefined) { n = laneCount[id] = (laneCount[id] ?? -1) + 1; laneOf.set(k, n); }
    const v = RING[ring][side] + RING[ring].pitch * n;
    return side === 'L' || side === 'T' ? -v : v;
  };
  const segs: Seg[] = [], wires: WirePath[] = [], overlaps: string[] = [];
  const vertical = (s: Side) => s === 'L' || s === 'R';
  const bump = (ring: Ring, side: Side, key: string) => { const id = ring + side; laneOf.set(id + '|' + key, (laneCount[id] = (laneCount[id] ?? -1) + 1)); };
  for (const w of defs) for (let attempt = 0; attempt < 8; attempt++) {
    const R = RING[w.ring], a = w.a, b = w.b, clash: string[] = [], used: Side[] = [];
    const A: [number, number] = [a.p[0] + a.out[0] * R.lead, a.p[2] + a.out[2] * R.lead], B: [number, number] = [b.p[0] + b.out[0] * R.lead, b.p[2] + b.out[2] * R.lead];
    let pts: [number, number][];
    const L = (s: Side) => { used.push(s); return lane(w.ring, s, w.key); };
    if (a.side === b.side) {
      const t = vertical(a.side) ? 1 : 0;
      if (Math.abs(A[t] - B[t]) < 0.03) pts = [A, B];
      else { const l = L(a.side); pts = vertical(a.side) ? [A, [l, A[1]], [l, B[1]], B] : [A, [A[0], l], [B[0], l], B]; }
    } else if (vertical(a.side) !== vertical(b.side)) {
      const v = vertical(a.side) ? A : B, h = vertical(a.side) ? B : A, lx = L(vertical(a.side) ? a.side : b.side), lz = L(vertical(a.side) ? b.side : a.side);
      const mid: [number, number][] = [v, [lx, v[1]], [lx, lz], [h[0], lz], h];
      pts = vertical(a.side) ? mid : mid.reverse();
    } else if (vertical(a.side)) {
      const viaT = Math.abs(A[1] + 4) + Math.abs(B[1] + 4) <= Math.abs(A[1] - 4) + Math.abs(B[1] - 4), lz = L(viaT ? 'T' : 'B'), la = L(a.side), lb = L(b.side);
      pts = [A, [la, A[1]], [la, lz], [lb, lz], [lb, B[1]], B];
    } else {
      const viaL = A[0] + B[0] <= 0, lx = L(viaL ? 'L' : 'R'), la = L(a.side), lb = L(b.side);
      pts = [A, [A[0], la], [lx, la], [lx, lb], [B[0], lb], B];
    }
    pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.01);
    const radius = (w.ring === 'in' ? 0.06 : 0.1) * (w.power ? 1.45 : 1);
    const y = R.y + (w.power ? 0.03 : 0);
    const out: Vec3[] = [];
    const lead = (t: Term, flat: [number, number], rev: boolean) => {
      const part: Vec3[] = [];
      if (R.lead > 0) for (let i = 0; i <= 6; i++) {
        const u = i / 6, e = u * u * (3 - 2 * u), d = R.lead * (0.15 + 0.8 * u);
        part.push([t.p[0] + t.out[0] * d, t.p[1] + (y - t.p[1]) * e, t.p[2] + t.out[2] * d]);
      }
      part.unshift([t.p[0], t.p[1], t.p[2]]);
      if (R.lead === 0) part.length = 0;
      void flat;
      out.push(...(rev ? part.reverse() : part));
    };
    lead(a, A, false);
    const mine: Seg[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1], len = Math.hypot(q[0] - p[0], q[1] - p[1]), d: [number, number] = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      const prevLen = i > 0 ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, nextLen = i + 2 < pts.length ? Math.hypot(pts[i + 2][0] - q[0], pts[i + 2][1] - q[1]) : 0;
      const f0 = i > 0 ? Math.min(R.fillet, len / 2, prevLen / 2) : 0, f1 = i + 2 < pts.length ? Math.min(R.fillet, len / 2, nextLen / 2) : 0;
      const at = (s: number, dy = 0): Vec3 => [p[0] + d[0] * s, y + dy, p[1] + d[1] * s];
      // пересечения с уже проложенными проводами других цепей — «мостики»
      const horiz = Math.abs(d[1]) < 0.5, hops: number[] = [];
      for (const s of segs) {
        if (s.ring !== w.ring || s.net === w.net.id) continue;
        const sh = Math.abs(s.z1 - s.z0) < 1e-6 && Math.abs(s.x1 - s.x0) > 1e-6;
        if (sh === horiz) {
          // параллельные: проверка на наложение
          const c0 = horiz ? p[1] : p[0], c1 = horiz ? s.z0 : s.x0;
          if (Math.abs(c0 - c1) < 0.1) {
            const a0 = Math.min(horiz ? p[0] : p[1], horiz ? q[0] : q[1]), a1 = Math.max(horiz ? p[0] : p[1], horiz ? q[0] : q[1]);
            const b0 = Math.min(horiz ? s.x0 : s.z0, horiz ? s.x1 : s.z1), b1 = Math.max(horiz ? s.x0 : s.z0, horiz ? s.x1 : s.z1);
            if (Math.min(a1, b1) - Math.max(a0, b0) > 0.05) clash.push((horiz ? 'h' : 'v') + (i > 0 && i + 2 < pts.length ? '' : '!') + `${w.key} × ${s.net} (${w.ring}) @ ${horiz ? 'z' : 'x'}=${c0.toFixed(2)} [${Math.max(a0, b0).toFixed(2)}…${Math.min(a1, b1).toFixed(2)}]`);
          }
          continue;
        }
        const cross = horiz ? s.x0 : s.z0, along = horiz ? (cross - p[0]) * d[0] : (cross - p[1]) * d[1];
        const mineC = horiz ? p[1] : p[0], lo = Math.min(horiz ? s.z0 : s.x0, horiz ? s.z1 : s.x1), hi = Math.max(horiz ? s.z0 : s.x0, horiz ? s.z1 : s.x1);
        if (along > 0.02 && along < len - 0.02 && mineC > lo - 0.05 && mineC < hi + 0.05) hops.push(along);
      }
      hops.sort((x, z) => x - z);
      if (i === 0 && R.lead === 0) out.push(at(0));
      else if (i === 0) out.push(at(0));
      else out.push(at(f0));
      const lo = f0 + 0.02, hi = len - f1 - 0.02;
      for (let h = 0; h < hops.length;) {
        let e = h;
        while (e + 1 < hops.length && hops[e + 1] - hops[e] < R.hopW * 2.2) e++;
        const s0 = Math.max(lo, hops[h] - R.hopW), s1 = Math.min(hi, hops[e] + R.hopW);
        if (s1 - s0 > 0.05) {
          const k = Math.min(R.hopW * 0.55, (s1 - s0) / 3);
          out.push(at(s0), at(s0 + k * 0.5, R.hopH * 0.6), at(s0 + k, R.hopH), at(s1 - k, R.hopH), at(s1 - k * 0.5, R.hopH * 0.6), at(s1));
        }
        h = e + 1;
      }
      if (i + 2 < pts.length) {
        out.push(at(len - f1));
        const n = pts[i + 2], l2 = Math.hypot(n[0] - q[0], n[1] - q[1]), d2: [number, number] = [(n[0] - q[0]) / l2, (n[1] - q[1]) / l2];
        const ox = q[0] - d[0] * f1 + d2[0] * f1, oz = q[1] - d[1] * f1 + d2[1] * f1;
        for (const ang of [0.5, 1, 1.5]) {
          const c = Math.cos((ang * Math.PI) / 4), s = Math.sin((ang * Math.PI) / 4);
          out.push([ox + (d[0] * s - d2[0] * c) * f1, y, oz + (d[1] * s - d2[1] * c) * f1]);
        }
      } else out.push(at(len));
      mine.push({ ring: w.ring, net: w.net.id, x0: p[0], z0: p[1], x1: q[0], z1: q[1] });
    }
    lead(b, B, true);
    // наложение на чужой провод: взять следующую свободную полосу и проложить заново
    const movable = clash.filter((c) => !c.includes('!'));
    if (movable.length && attempt < 7) {
      for (const s of new Set(used)) if (movable.some((c) => c[0] === (vertical(s) ? 'v' : 'h'))) bump(w.ring, s, w.key);
      continue;
    }
    overlaps.push(...clash);
    segs.push(...mine);
    // убрать совпадающие подряд точки
    const clean = out.filter((p, i) => i === 0 || V.len(V.sub(p, out[i - 1])) > 1e-4);
    wires.push({ net: w.net.id, pts: clean, radius });
    break;
  }

  // 5. цепи внутри одного блока (затворы IGBT)
  const probe: Record<string, Vec3> = {};
  for (const net of NETS) {
    if (net.path.length === 1) {
      const s = LAYOUT[net.path[0]], m = stripMatrix(net.path[0]);
      const p0 = M.point(m, [0.55, 0.09, -0.45]), p1 = M.point(m, [0.1, 0.09, -0.45]), p2 = M.point(m, [-0.17, 0.09, -0.25]), p3 = M.point(m, [-0.17, 0.09, 0.1]);
      void s;
      wires.push({ net: net.id, pts: [p0, p1, p2, p3], radius: 0.06 });
      probe[net.id] = [p3[0], 0.14, p3[2]];
    }
  }
  // 6. точки измерения
  const termOf = (block: BlockId, ring: Ring, key: string) => terms.get(block + '|' + ring + '|' + key);
  for (const net of NETS) {
    if (probe[net.id]) continue;
    const key = net.id === 'IAC_OUT' ? net.id + '#0' : net.id;
    if (net.id === 'GND') { probe[net.id] = termOf('x_batt', 'out', 'GND')!.tip; continue; }
    if (net.path.includes('mcu')) { probe[net.id] = pinTerm(pinName(net, 0)).tip; continue; }
    const b = net.path.find(isBoard) ?? net.path[0];
    const t = termOf(b, 'out', key) ?? termOf(b, 'in', key);
    probe[net.id] = t ? t.tip : [0, 0.3, 0];
  }
  const list = [...terms.entries()].map(([k, t]) => { const [block, ring, key] = k.split('|'); return { block: block as BlockId, ring: ring as Ring, net: key, t }; });
  return { wires, probe, ground: termOf('pwr', 'out', 'GND')!.tip, terms: list, overlaps, lanes: laneCount };
}

/** Матрица «местные координаты блока → сцена»: местная ось +x смотрит на Blue Pill (для устройств — на плату). */
function stripMatrix(id: BlockId): Mat4 {
  const s = LAYOUT[id], rot = s.side === 'L' ? 0 : s.side === 'R' ? Math.PI : s.side === 'T' ? -Math.PI / 2 : Math.PI / 2;
  return M.trs([s.c[0], isBoard(id) ? 0 : TABLE_Y, s.c[1]], [0, rot, 0]);
}

// ───────────────────────── детали ─────────────────────────

/** Цвет задаётся «как на экране»; шейдер работает в линейном пространстве, поэтому переводим. */
const lin = (c: readonly number[]): Vec3 => [Math.pow(c[0], 2.2) * 0.8, Math.pow(c[1], 2.2) * 0.8, Math.pow(c[2], 2.2) * 0.8];
const C = (r: number, g: number, b: number): Vec3 => lin([r, g, b]);
const PAL: Record<string, Material> = {
  proto: { color: C(0.16, 0.42, 0.3), rough: 0.75 },
  protoPad: { color: C(0.75, 0.62, 0.3), metal: 0.8, rough: 0.4 },
  table: { color: C(0.16, 0.18, 0.21), rough: 1 },
  bluePcb: { color: C(0.12, 0.34, 0.8), rough: 0.45 },
  greenPcb: { color: C(0.1, 0.55, 0.3), rough: 0.5 },
  black: { color: C(0.13, 0.13, 0.14), rough: 0.5 },
  dark: { color: C(0.25, 0.26, 0.29), rough: 0.6 },
  grey: { color: C(0.42, 0.44, 0.47), rough: 0.6 },
  steel: MAT.steel(), alu: MAT.machinedAlu(), gold: MAT.gold(), brass: MAT.brass(), copper: MAT.copper(),
  resBody: { color: C(0.82, 0.68, 0.45), rough: 0.5 },
  band: { color: C(0.45, 0.16, 0.08), rough: 0.5 },
  ochre: { color: C(0.85, 0.55, 0.12), rough: 0.4 },
  navy: { color: C(0.15, 0.2, 0.5), rough: 0.35 },
  white: { color: C(0.88, 0.88, 0.86), rough: 0.5 },
  red: { color: C(0.8, 0.1, 0.08), rough: 0.4 },
  green: { color: C(0.15, 0.6, 0.25), rough: 0.5 },
  yellow: { color: C(0.92, 0.75, 0.1), rough: 0.5 },
  blue: { color: C(0.12, 0.35, 0.85), rough: 0.4 },
  orange: { color: C(0.95, 0.45, 0.08), rough: 0.45 },
  screen: { color: C(0.1, 0.3, 0.45), emissive: C(0.05, 0.2, 0.3), rough: 0.2 },
  lcd: { color: C(0.55, 0.62, 0.5), rough: 0.3 },
};

/** Копилка геометрии по материалам: один узел на материал в каждом блоке. */
class Kit {
  private parts = new Map<string, Geometry[]>();
  constructor(public m: Mat4 = M.identity()) {}
  add(mat: string, g: Geometry, pos: Vec3 = [0, 0, 0], rot: Vec3 = [0, 0, 0], scale: Vec3 | number = 1) {
    const list = this.parts.get(mat) ?? [];
    list.push(transform(g, M.mul(this.m, M.trs(pos, rot, scale))));
    this.parts.set(mat, list);
  }
  /** Добавить геометрию, уже заданную в координатах сцены. */
  world(mat: string, g: Geometry) {
    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
  }
  emit(parent: Node3) {
    for (const [mat, list] of this.parts) parent.add(new Node3(mat, merge(...list), PAL[mat]));
  }
}

const cylX = (r: number, len: number, seg = 12) => placed(cylinder(r, r, len, seg), [0, 0, 0], [0, 0, Math.PI / 2]);
const G = {
  resBody: cylX(0.105, 0.46), resLead: cylX(0.022, 0.92, 6),
  resBands: merge(placed(cylX(0.11, 0.05), [-0.14, 0, 0]), placed(cylX(0.11, 0.05), [-0.04, 0, 0]), placed(cylX(0.11, 0.05), [0.1, 0, 0])),
  dioBody: cylX(0.09, 0.36), dioBand: placed(cylX(0.095, 0.07), [0.11, 0, 0]),
  capC: sphere(0.15, 10),
  leg: box(0.03, 0.22, 0.03),
};
const P = {
  res(k: Kit, u: number, v: number, ry = 0) {
    k.add('resBody', G.resBody, [u, 0.15, v], [0, ry, 0]); k.add('band', G.resBands, [u, 0.15, v], [0, ry, 0]); k.add('steel', G.resLead, [u, 0.15, v], [0, ry, 0]);
  },
  diode(k: Kit, u: number, v: number, ry = 0) {
    k.add('black', G.dioBody, [u, 0.14, v], [0, ry, 0]); k.add('white', G.dioBand, [u, 0.14, v], [0, ry, 0]); k.add('steel', G.resLead, [u, 0.14, v], [0, ry, 0]);
  },
  capC(k: Kit, u: number, v: number, ry = 0) { k.add('ochre', G.capC, [u, 0.24, v], [0, ry, 0], [1, 1.1, 0.5]); k.add('steel', box(0.2, 0.12, 0.02), [u, 0.06, v], [0, ry, 0]); },
  capE(k: Kit, u: number, v: number, r: number, h: number) {
    k.add('navy', cylinder(r, r, h, 20), [u, h / 2, v]); k.add('alu', cylinder(r * 0.86, r * 0.86, 0.02, 20), [u, h + 0.005, v]); k.add('white', box(0.03, h * 0.9, r * 0.9), [u + r - 0.005, h / 2, v]);
  },
  sot23(k: Kit, u: number, v: number, ry = 0) {
    k.add('black', box(0.28, 0.11, 0.16), [u, 0.08, v], [0, ry, 0]);
    k.add('steel', merge(placed(box(0.05, 0.03, 0.34), [-0.09, 0, 0]), placed(box(0.05, 0.03, 0.34), [0.09, 0, 0])), [u, 0.03, v], [0, ry, 0]);
  },
  to92(k: Kit, u: number, v: number, ry = 0) {
    const o: [number, number][] = [];
    for (let i = 0; i <= 8; i++) { const a = Math.PI - (i / 8) * Math.PI; o.push([Math.cos(a) * 0.15, Math.sin(a) * 0.15 - 0.04]); }
    k.add('black', extrude(o.reverse(), 0.3), [u, 0.2, v], [0, ry, 0]);
    k.add('steel', merge(placed(G.leg, [-0.09, 0, 0]), G.leg, placed(G.leg, [0.09, 0, 0])), [u, 0.11, v], [0, ry, 0]);
  },
  to220(k: Kit, u: number, v: number, ry = 0) {
    k.add('black', box(0.55, 0.48, 0.22), [u, 0.5, v], [0, ry, 0]);
    k.add('steel', merge(placed(box(0.55, 0.85, 0.06), [0, 0.7, -0.13]), placed(box(0.05, 0.28, 0.03), [-0.15, 0.13, 0]), placed(box(0.05, 0.28, 0.03), [0, 0.13, 0]), placed(box(0.05, 0.28, 0.03), [0.15, 0.13, 0])), [u, 0, v], [0, ry, 0]);
    k.add('dark', cylX(0.1, 0.07, 14), [u, 0.92, v], [0, ry + Math.PI / 2, 0]);
  },
  to263(k: Kit, u: number, v: number, ry = 0) {
    k.add('copper', box(1.0, 0.02, 1.0), [u, 0.012, v], [0, ry, 0]);
    k.add('steel', merge(placed(box(0.6, 0.07, 0.75), [0, 0.055, -0.08]), placed(box(0.07, 0.04, 0.3), [-0.15, 0.04, 0.42]), placed(box(0.07, 0.04, 0.3), [0.15, 0.04, 0.42])), [u, 0, v], [0, ry, 0]);
    k.add('black', box(0.58, 0.24, 0.5), [u, 0.2, v + 0], [0, ry, 0]);
  },
  so20(k: Kit, u: number, v: number, ry = 0) {
    k.add('black', box(1.15, 0.18, 0.56), [u, 0.15, v], [0, ry, 0]);
    const legs: Geometry[] = [];
    for (let i = 0; i < 10; i++) for (const s of [-1, 1]) legs.push(placed(box(0.045, 0.1, 0.16), [-0.5 + i * 0.111, 0, s * 0.34]));
    k.add('steel', merge(...legs), [u, 0.07, v], [0, ry, 0]);
    k.add('white', cylinder(0.035, 0.035, 0.01, 10), [u, 0.245, v], [0, ry, 0]);
  },
  fuse(k: Kit, u: number, v: number, mat: string, ry = 0) {
    k.add('black', box(0.75, 0.28, 0.36), [u, 0.14, v], [0, ry, 0]); k.add(mat, box(0.55, 0.36, 0.15), [u, 0.44, v], [0, ry, 0]);
  },
  terminal(k: Kit, p: Vec3, out: Vec3) {
    const ry = Math.abs(out[0]) > 0.5 ? Math.PI / 2 : 0;
    k.world('green', placed(box(0.42, 0.42, 0.5), [p[0] - out[0] * 0.25, 0.21, p[2] - out[2] * 0.25], [0, ry, 0]));
    k.world('steel', placed(cylinder(0.11, 0.11, 0.06, 12), [p[0] - out[0] * 0.2, 0.43, p[2] - out[2] * 0.2]));
  },
};

type PartRow = [kind: 'res' | 'diode' | 'capC' | 'capE' | 'sot23' | 'to92' | 'to220' | 'to263' | 'so20', u: number, v: number, ry?: number];
/** Детали функциональных блоков в местных координатах (u — к Blue Pill, v — поперёк). */
const BLOCK_PARTS: Partial<Record<BlockId, PartRow[]>> = {
  in_tps: [['res', -0.75, -0.3], ['res', -0.75, 0.3], ['res', 0.35, -0.3], ['capC', 0.35, 0.3], ['sot23', 1.25, 0]],
  in_map: [['res', -0.75, -0.3], ['res', -0.75, 0.3], ['res', 0.35, -0.3], ['capC', 0.35, 0.3], ['sot23', 1.25, 0]],
  in_cht: [['res', -0.75, -0.3], ['res', -0.75, 0.3], ['res', 0.35, -0.3], ['capC', 1.2, 0.1]],
  in_iat: [['res', -0.75, -0.3], ['res', -0.75, 0.3], ['res', 0.35, -0.3], ['capC', 1.2, 0.1]],
  in_vbat: [['res', -0.75, -0.2], ['res', 0.35, -0.2], ['capC', 0.35, 0.35], ['sot23', 1.25, 0]],
  in_o2: [['res', -0.5, 0], ['capC', 0.45, 0.25], ['sot23', 1.25, 0]],
  in_crank: [['res', -0.75, -0.3], ['res', -0.75, 0.3], ['capC', 0.35, 0.3], ['sot23', 1.25, 0]],
  in_sw: [['res', -0.75, -0.35], ['res', 0.3, -0.35], ['capC', 1.2, -0.35], ['res', -0.75, 0.35], ['res', 0.3, 0.35], ['capC', 1.2, 0.35]],
  out_coil1: [['sot23', 1.45, -0.45], ['sot23', 0.75, -0.45], ['res', 1.1, 0.1], ['res', 1.1, 0.55], ['res', 0.1, 0.7], ['to263', -0.75, 0.25, Math.PI / 2]],
  out_coil2: [['sot23', 1.45, -0.45], ['sot23', 0.75, -0.45], ['res', 1.1, 0.1], ['res', 1.1, 0.55], ['res', 0.1, 0.7], ['to263', -0.75, 0.25, Math.PI / 2]],
  out_inj: [['res', 1.1, -0.35], ['res', 1.1, 0.35], ['to220', -0.1, 0, Math.PI / 2], ['diode', -0.95, 0.5]],
  out_heater: [['res', 1.1, -0.35], ['res', 1.1, 0.35], ['to220', -0.1, 0, Math.PI / 2], ['diode', -0.95, 0.5]],
  out_pump: [['res', 1.1, -0.35], ['res', 1.1, 0.35], ['to92', 0.05, 0, Math.PI / 2], ['diode', -0.85, 0.4]],
  out_iac: [['so20', 0.1, 0, Math.PI / 2], ['capC', 1.2, 0.5], ['res', 1.2, -0.5], ['capE', -0.9, -0.5]],
};

function drawBluePill(k: Kit) {
  const pins: Geometry[] = [];
  for (let i = 0; i < 20; i++) for (const r of [-1, 1]) pins.push(placed(box(0.06, 0.34, 0.06), [pinX(i), 0.63, r * ROW_Z]));
  k.add('gold', merge(...pins));
  for (const r of [-1, 1]) k.add('black', box(7.3, 0.44, 0.26), [0, 0.22, r * ROW_Z]);               // панельки
  const pads: Geometry[] = [];
  for (let i = 0; i < 20; i++) for (const r of [-1, 1]) pads.push(placed(cylinder(0.07, 0.07, 0.02, 8), [pinX(i), 0.02, r * (ROW_Z + 0.32)]));
  k.add('protoPad', merge(...pads));
  k.add('bluePcb', box(7.8, 0.09, 3.0), [0, 0.5, 0]);
  k.add('black', box(0.95, 0.12, 0.95), [0.5, 0.6, 0], [0, Math.PI / 4, 0]);                             // STM32
  k.add('black', box(0.4, 0.12, 0.3), [-2.2, 0.6, 0.55]);                                                // стабилизатор
  k.add('steel', merge(placed(box(0.75, 0.3, 0.8), [-3.6, 0.7, 0]), placed(extrude(roundedRect(0.55, 0.25, 0.1), 0.16), [-0.85, 0.55, 0]), placed(cylinder(0.07, 0.07, 0.3, 10), [-1.5, 0.6, -0.5], [0, 0, Math.PI / 2])));
  k.add('white', box(0.36, 0.14, 0.36), [1.75, 0.62, 0]);                                                // кнопка сброса
  k.add('dark', cylinder(0.09, 0.09, 0.1, 12), [1.75, 0.72, 0]);
  const boot: Geometry[] = [];
  for (let i = 0; i < 3; i++) for (const r of [-1, 1]) boot.push(placed(box(0.05, 0.3, 0.05), [-1.95 + i * 0.26, 0.7, -0.15 + r * 0.14 - 0.2]));
  k.add('gold', merge(...boot));
  k.add('yellow', merge(placed(box(0.5, 0.2, 0.14), [-1.82, 0.75, -0.49]), placed(box(0.5, 0.2, 0.14), [-1.82, 0.75, -0.21])));  // перемычки BOOT
  const swd: Geometry[] = [];
  for (let i = 0; i < 4; i++) swd.push(placed(box(0.5, 0.05, 0.05), [3.95, 0.6, -0.39 + i * 0.26]));
  k.add('gold', merge(...swd));
  k.add('red', box(0.12, 0.06, 0.08), [2.6, 0.57, 0.5]);
  k.add('green', box(0.12, 0.06, 0.08), [2.6, 0.57, -0.5]);
}

function drawPower(k: Kit) {
  const z = LAYOUT.pwr.c[1];
  P.fuse(k, -3.3, z - 0.1, 'grey');                                   // F1 2 А
  P.diode(k, -2.2, z + 0.15);                                         // D1 SR560
  k.add('black', box(0.5, 0.2, 0.42), [-2.2, 0.12, z + 0.7]);         // D2 TVS
  k.add('steel', box(0.7, 0.04, 0.2), [-2.2, 0.04, z + 0.7]);
  P.capE(k, -1.2, z + 0.3, 0.36, 0.85);                               // C1
  P.capE(k, -4.4, z + 0.45, 0.22, 0.5);                               // C2
  // модуль LM2596
  k.add('bluePcb', box(4.3, 0.08, 1.95), [1.9, 0.2, z + 0.05]);
  k.add('copper', torus(0.36, 0.17, 24, 10), [2.9, 0.42, z + 0.1]);   // дроссель-тороид
  k.add('dark', cylinder(0.2, 0.2, 0.3, 14), [2.9, 0.4, z + 0.1]);
  k.add('black', box(0.7, 0.2, 0.65), [1.55, 0.34, z + 0.25]);        // LM2596S
  k.add('steel', box(0.7, 0.06, 0.35), [1.55, 0.27, z - 0.3]);
  k.add('alu', merge(placed(cylinder(0.3, 0.3, 0.55, 18), [0.35, 0.52, z + 0.2]), placed(cylinder(0.3, 0.3, 0.55, 18), [3.6, 0.52, z + 0.5])));
  k.add('black', merge(placed(cylinder(0.305, 0.305, 0.12, 18), [0.35, 0.3, z + 0.2]), placed(cylinder(0.305, 0.305, 0.12, 18), [3.6, 0.3, z + 0.5])));
  k.add('blue', box(0.5, 0.25, 0.22), [1.6, 0.37, z - 0.72]);         // подстроечник
  k.add('brass', cylinder(0.06, 0.06, 0.08, 10), [1.42, 0.53, z - 0.72]);
  // L1 фильтр датчиков
  k.add('black', extrude(roundedRect(0.8, 0.8, 0.14), 0.4), [-4.5, 0, z - 0.45]);
  k.add('dark', cylinder(0.28, 0.28, 0.02, 16), [-4.5, 0.41, z - 0.45]);
}

function drawBt(k: Kit) {
  const z = LAYOUT.bt.c[1];
  k.add('greenPcb', box(3.7, 0.08, 1.5), [0.2, 0.4, z + 0.1]);
  k.add('bluePcb', box(2.5, 0.08, 1.25), [0.75, 0.48, z + 0.1]);
  k.add('black', merge(placed(box(0.6, 0.1, 0.6), [0.6, 0.56, z + 0.1]), placed(box(0.3, 0.1, 0.5), [-0.1, 0.56, z + 0.1]), placed(box(0.3, 0.4, 1.4), [-1.45, 0.2, z + 0.1])));
  const ant: Geometry[] = [];
  for (let i = 0; i < 5; i++) ant.push(placed(box(0.06, 0.012, 0.9), [1.45 + i * 0.12, 0.53, z + 0.1]));
  k.add('gold', merge(...ant));
  k.add('red', box(0.1, 0.05, 0.07), [0, 0.47, z + 0.7]);
  P.res(k, -1.3, z - 0.85); P.res(k, -0.2, z - 0.85);
  P.capE(k, 1.8, z - 0.75, 0.2, 0.45);
}

/** Внешние устройства; местная ось +x — к плате, y = 0 — стол. */
const DEVICES: Partial<Record<BlockId, (k: Kit) => void>> = {
  x_batt(k) {
    k.add('black', box(2.6, 2.0, 4.4), [-0.2, 1.0, 0]);
    k.add('dark', box(2.7, 0.25, 4.5), [-0.2, 2.0, 0]);
    k.add('red', cylinder(0.26, 0.26, 0.08, 16), [0.55, 2.16, -1.4]);
    k.add('grey', merge(placed(cylinder(0.2, 0.17, 0.35, 16), [0.55, 2.3, -1.4]), placed(cylinder(0.2, 0.17, 0.35, 16), [0.55, 2.3, 1.4])));
    k.add('white', box(0.02, 0.9, 2.6), [1.11, 1.0, 0]);
  },
  x_tps(k) {
    k.add('black', merge(placed(cylinder(0.62, 0.62, 0.5, 24), [-0.3, 0.25, 0]), placed(box(0.9, 0.38, 0.6), [0.55, 0.25, 0])));
    k.add('steel', cylinder(0.12, 0.12, 0.5, 12), [-0.3, 0.6, 0]);
    k.add('brass', box(0.7, 0.08, 0.16), [-0.45, 0.8, 0.12], [0, 0.6, 0]);
  },
  x_map(k) {
    k.add('greenPcb', box(1.9, 0.08, 1.2), [0, 0.12, 0]);
    k.add('dark', box(0.9, 0.4, 0.8), [-0.2, 0.36, 0]);
    k.add('black', cylinder(0.14, 0.11, 0.55, 12), [-0.2, 0.8, 0]);
    k.add('steel', box(0.5, 0.04, 0.9), [0.5, 0.2, 0]);
  },
  x_cht(k) { thermistor(k); },
  x_iat(k) { thermistor(k); },
  x_o2(k) {
    const body = lathe([[0, 0], [0.16, 0], [0.2, 0.5], [0.2, 0.6], [0.3, 0.6], [0.3, 0.85], [0.36, 0.85], [0.36, 1.2], [0.24, 1.25], [0.24, 2.2], [0.14, 2.3], [0, 2.3]], 18);
    k.add('steel', body, [-1.1, 0.4, 0], [0, 0, -Math.PI / 2]);
    k.add('dark', cylX(0.21, 0.35, 12), [-0.85, 0.4, 0]);
    k.add('black', cylX(0.1, 0.5, 8), [0.85, 0.36, 0]);
  },
  x_hall(k) {
    // фрагмент зубчатого венца 36-1 и датчик напротив зуба
    const R0 = 3.0, arc = 0.95;
    k.add('grey', lathe([[R0 - 0.5, 0], [R0, 0], [R0, 0.35], [R0 - 0.5, 0.35], [R0 - 0.5, 0]], 20, arc), [-R0 - 0.75, 0.2, 0], [0, arc / 2, 0]);
    const teeth: Geometry[] = [];
    for (let i = -2; i <= 2; i++) { if (i === 1) continue; const a = (i * Math.PI) / 18; teeth.push(placed(box(0.22, 0.35, 0.26), [Math.cos(a) * (R0 + 0.1), 0, Math.sin(a) * (R0 + 0.1)], [0, -a, 0])); }
    k.add('steel', merge(...teeth), [-R0 - 0.75, 0.375, 0]);
    k.add('black', box(0.5, 0.42, 0.42), [0.05, 0.38, 0]);
    k.add('dark', box(1.1, 0.3, 0.7), [0.75, 0.2, 0]);
  },
  x_service(k) {
    k.add('greenPcb', box(1.5, 0.08, 0.7), [0.4, 0.1, 0]);
    k.add('gold', merge(placed(box(0.05, 0.4, 0.05), [0.2, 0.3, -0.13]), placed(box(0.05, 0.4, 0.05), [0.2, 0.3, 0.13])));
    k.add('yellow', box(0.2, 0.26, 0.5), [0.2, 0.33, 0]);
  },
  x_kill(k) {
    k.add('dark', cylinder(0.5, 0.5, 0.45, 20), [0.3, 0.225, 0]);
    k.add('red', merge(placed(cylinder(0.34, 0.34, 0.25, 20), [0.3, 0.55, 0]), placed(cylinder(0.44, 0.38, 0.14, 20), [0.3, 0.74, 0])));
    k.add('yellow', torus(0.42, 0.05, 20, 6), [0.3, 0.46, 0]);
    k.add('black', tube(smoothPath([[0.3, 0.5, 0.4], [-0.3, 0.2, 0.5], [-0.9, 0.08, 0.2], [-1.3, 0.08, -0.3]], 6), 0.045, 6), [0, 0, 0]);
  },
  x_coil1(k) { coil(k); },
  x_coil2(k) { coil(k); },
  x_inj(k) {
    const body = lathe([[0, 0], [0.1, 0], [0.12, 0.3], [0.22, 0.35], [0.22, 0.9], [0.3, 0.95], [0.3, 1.5], [0.2, 1.55], [0.2, 2.0], [0.15, 2.05], [0, 2.05]], 18);
    k.add('steel', body, [-1.2, 0.42, 0], [0, 0, -Math.PI / 2]);
    k.add('black', box(0.55, 0.5, 0.5), [-0.1, 0.75, 0]);
    k.add('blue', cylX(0.24, 0.12, 14), [-0.75, 0.42, 0]);
    k.add('orange', cylX(0.24, 0.12, 14), [0.7, 0.42, 0]);
  },
  x_pump(k) {
    k.add('black', box(0.9, 0.9, 0.9), [0.7, 0.5, -0.4]);                 // реле K1
    k.add('steel', merge(placed(box(0.2, 0.06, 0.04), [1.2, 0.2, -0.6]), placed(box(0.2, 0.06, 0.04), [1.2, 0.2, -0.2]), placed(cylX(0.36, 2.0, 20), [-0.5, 0.4, 0.5])));
    k.add('dark', merge(placed(cylX(0.38, 0.3, 20), [0.55, 0.4, 0.5]), placed(cylX(0.12, 0.4, 10), [-1.65, 0.4, 0.5])));
  },
  x_iac(k) {
    k.add('black', cylX(0.55, 1.1, 22), [0.3, 0.6, 0]);
    k.add('steel', merge(placed(cylX(0.3, 0.5, 16), [-0.45, 0.6, 0]), transform(cylinder(0.26, 0.04, 0.6, 16), M.trs([-1.0, 0.6, 0], [0, 0, Math.PI / 2]))));
    k.add('dark', box(0.4, 0.5, 0.7), [1.0, 0.6, 0]);
  },
  x_pc(k) {
    k.add('grey', box(2.4, 0.14, 3.6), [-0.6, 0.07, -0.3]);
    k.add('dark', box(1.2, 0.02, 3.0), [-0.2, 0.15, -0.3]);
    k.add('grey', box(0.12, 2.3, 3.6), [0.95, 1.2, -0.3], [0, 0, -0.28]);
    k.add('screen', box(0.02, 2.0, 3.3), [0.87, 1.2, -0.3], [0, 0, -0.28]);
    k.add('black', box(1.5, 0.1, 0.75), [0.2, 0.05, 2.0]);                // телефон
    k.add('screen', box(1.35, 0.02, 0.65), [0.2, 0.11, 2.0]);
  },
};
function thermistor(k: Kit) {
  k.add('steel', merge(placed(cylX(0.13, 1.3, 14), [-0.55, 0.16, 0]), placed(sphere(0.13, 12), [-1.2, 0.16, 0])));
  k.add('black', cylX(0.08, 1.2, 8), [0.7, 0.14, 0]);
}
function coil(k: Kit) {
  k.add('black', box(1.5, 1.2, 1.3), [0.1, 0.7, 0]);
  k.add('steel', merge(placed(box(1.9, 0.5, 0.5), [0.1, 0.7, 0]), placed(box(0.3, 0.1, 1.7), [0.1, 0.05, 0])));
  k.add('dark', lathe([[0, 0], [0.3, 0], [0.24, 0.7], [0.16, 0.75], [0.16, 0.95], [0, 0.95]], 16), [-0.25, 1.3, 0]);
  k.add('brass', cylinder(0.08, 0.08, 0.12, 10), [-0.25, 2.28, 0]);
}

// ───────────────────────── сцена ─────────────────────────

export interface BoardSceneOpts {
  onNet: (id: string) => void;
  onBlock: (id: BlockId) => void;
  onHover: (label: string | null, x: number, y: number) => void;
}
export interface BoardScene {
  select(net: string | null, fly?: boolean): void;
  view(name: 'top' | 'iso' | 'board'): void;
  /** Точки для HTML-подписей блоков. */
  labels: { id: BlockId; title: string; pos: Vec3 }[];
  /** Вызывается после каждого кадра (обновление подписей). */
  afterFrame: (() => void) | null;
}

/** Ракурсы: half — полуразмеры области (по ширине и глубине), которая должна поместиться в кадр. */
const VIEWS = {
  top: { target: [-0.6, 0, 0.3] as Vec3, yaw: 0, pitch: 1.45, half: [18.4, 14.6] },
  iso: { target: [-0.6, 0, 0.9] as Vec3, yaw: 0.14, pitch: 1.02, half: [19, 13.6] },
  board: { target: [0, 0, 0.2] as Vec3, yaw: 0, pitch: 1.08, half: [12, 8] },
};

export function buildBoardScene(viewer: Viewer, opts: BoardSceneOpts): BoardScene {
  const root = viewer.root, wiring = computeWiring();
  const camFor = (name: keyof typeof VIEWS) => {
    const v = VIEWS[name], tan = Math.tan(viewer.cam.fov / 2), aspect = Math.max(0.3, viewer.canvas.clientWidth / Math.max(1, viewer.canvas.clientHeight));
    return { target: [...v.target] as Vec3, yaw: v.yaw, pitch: v.pitch, dist: Math.max(v.half[0] / (tan * aspect), v.half[1] / tan) };
  };
  Object.assign(viewer.cam, { minDist: 5, maxDist: 140 }, camFor('iso'));

  // стол и плата
  const base = new Kit();
  base.add('table', box(41, 0.3, 31), [0, TABLE_Y - 0.15, 0]);
  base.add('proto', box(BOARD_W, 0.12, BOARD_D), [0, -0.06, 0]);
  const posts: Geometry[] = [], holes: Geometry[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    posts.push(placed(cylinder(0.2, 0.2, -TABLE_Y - 0.1, 10), [sx * (BOARD_W / 2 - 0.4), TABLE_Y / 2 - 0.05, sz * (BOARD_D / 2 - 0.4)]));
    holes.push(placed(cylinder(0.2, 0.2, 0.03, 12), [sx * (BOARD_W / 2 - 0.4), 0.01, sz * (BOARD_D / 2 - 0.4)]));
  }
  base.add('brass', merge(...posts)); base.add('steel', merge(...holes));
  // мультиметр
  const METER: Vec3 = [13.6, TABLE_Y, -11.2];
  base.add('yellow', extrude(roundedRect(2.4, 4.0, 0.3), 0.6), METER);
  base.add('dark', box(2.0, 0.04, 3.5), [METER[0], TABLE_Y + 0.62, METER[2]]);
  base.add('lcd', box(1.5, 0.03, 0.8), [METER[0], TABLE_Y + 0.65, METER[2] - 1.1]);
  base.add('black', cylinder(0.55, 0.55, 0.16, 24), [METER[0], TABLE_Y + 0.7, METER[2] + 0.3]);
  base.add('white', box(0.08, 0.05, 0.5), [METER[0], TABLE_Y + 0.8, METER[2] + 0.12]);
  base.add('red', cylinder(0.12, 0.12, 0.1, 12), [METER[0] + 0.5, TABLE_Y + 0.66, METER[2] + 1.45]);
  base.add('black', cylinder(0.12, 0.12, 0.1, 12), [METER[0] - 0.5, TABLE_Y + 0.66, METER[2] + 1.45]);
  const baseNode = root.add(new Node3('base'));
  base.emit(baseNode);

  // блоки
  const labels: BoardScene['labels'] = [];
  const blockNodes = new Map<BlockId, Node3>();
  for (const b of BLOCKS) {
    const slot = LAYOUT[b.id], node = root.add(new Node3('block:' + b.id));
    node.pickable = true; node.label = b.title; node.data = { block: b.id };
    blockNodes.set(b.id, node);
    const k = new Kit(b.where === 'board' && (b.id === 'mcu' || b.id === 'pwr' || b.id === 'bt') ? M.identity() : stripMatrix(b.id));
    let top = 1.1;
    if (b.id === 'mcu') drawBluePill(k);
    else if (b.id === 'pwr') drawPower(k);
    else if (b.id === 'bt') drawBt(k);
    else if (b.where === 'board') {
      for (const [kind, u, v, ry] of BLOCK_PARTS[b.id] ?? []) {
        if (kind === 'capE') P.capE(k, u, v, 0.26, 0.6);
        else P[kind](k, u, v, ry ?? 0);
      }
      // площадка блока: светлая рамка-шелкография
      k.add('white', merge(placed(box(slot.half[0] * 2 - 0.5, 0.012, 0.03), [0.1, 0.006, -slot.half[1] + 0.06]), placed(box(slot.half[0] * 2 - 0.5, 0.012, 0.03), [0.1, 0.006, slot.half[1] - 0.06])));
    } else {
      DEVICES[b.id]?.(k);
      top = b.id === 'x_batt' ? 2.9 : b.id === 'x_pc' ? 2.9 : b.id.startsWith('x_coil') ? 2.6 : 1.4;
    }
    // клеммы и площадки этого блока
    for (const t of wiring.terms) {
      if (t.block !== b.id) continue;
      if (b.where === 'board' && t.ring === 'out') P.terminal(k, t.t.p, t.t.out);
      else if (b.where === 'board') k.world('protoPad', placed(cylinder(0.08, 0.08, 0.02, 8), [t.t.p[0], 0.02, t.t.p[2]]));
      else k.world('brass', placed(box(0.3, 0.22, 0.3), [t.t.p[0] - t.t.out[0] * 0.12, t.t.p[1], t.t.p[2] - t.t.out[2] * 0.12]));
    }
    k.emit(node);
    labels.push({ id: b.id, title: SHORT[b.id], pos: [slot.c[0], (b.where === 'board' ? 0 : TABLE_Y) + top, slot.c[1]] });
  }

  // провода: видимый, ореол выбранного и «толстая» копия только для выбора щелчком
  interface NetNodes { def: NetDef; wire: Node3; halo: Node3; proxy: Node3; paths: { pts: Vec3[]; cum: number[]; len: number }[]; centre: Vec3; extent: number }
  const nets = new Map<string, NetNodes>();
  const wiresRoot = root.add(new Node3('wires'));
  for (const def of NETS) {
    const mine = wiring.wires.filter((w) => w.net === def.id);
    if (!mine.length) continue;
    const thin = merge(...mine.map((w) => tube(w.pts, w.radius, 8)));
    const fat = merge(...mine.map((w) => tube(w.pts, w.radius * 2.3 + 0.03, 6)));
    const col = lin(def.color);
    const wire = wiresRoot.add(new Node3('net:' + def.id, thin, { color: col, rough: 0.45, opacity: 1 }));
    const halo = wiresRoot.add(new Node3('halo:' + def.id, fat, { color: V.add(V.mul(def.color as readonly number[] as Vec3, 0.8), [0.2, 0.2, 0.2]), emissive: [0, 0, 0], unlit: true, opacity: 0.4, noClip: true }));
    halo.visible = false;
    const proxy = wiresRoot.add(new Node3('pick:' + def.id, fat, { color: col }));
    proxy.visible = false; proxy.pickable = true; proxy.data = { net: def.id }; proxy.label = `Цепь ${def.name} — ${def.title}`;
    let lo: Vec3 = [1e9, 1e9, 1e9], hi: Vec3 = [-1e9, -1e9, -1e9];
    const paths = mine.map((w) => {
      const cum = [0];
      for (let i = 1; i < w.pts.length; i++) cum.push(cum[i - 1] + V.len(V.sub(w.pts[i], w.pts[i - 1])));
      for (const p of w.pts) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])]; }
      return { pts: w.pts, cum, len: cum[cum.length - 1] };
    });
    nets.set(def.id, { def, wire, halo, proxy, paths, centre: V.mul(V.add(lo, hi), 0.5), extent: Math.max(hi[0] - lo[0], (hi[2] - lo[2]) * 1.5) });
  }
  // выбор щелчком идёт по толстым копиям проводов (тонкий провод трудно поймать мышью)
  const origPick = viewer.pickAt.bind(viewer);
  viewer.pickAt = (x: number, y: number) => {
    for (const n of nets.values()) { n.proxy.visible = true; n.wire.visible = false; }
    const haloVis = [...nets.values()].map((n) => n.halo.visible);
    for (const n of nets.values()) n.halo.visible = false;
    const pulsesVis = pulses.visible, probesVis = probes.visible;
    pulses.visible = false; probes.visible = false;
    const hit = origPick(x, y);
    let i = 0;
    for (const n of nets.values()) { n.proxy.visible = false; n.wire.visible = true; n.halo.visible = haloVis[i++]; }
    pulses.visible = pulsesVis; probes.visible = probesVis;
    return hit;
  };

  // бегущие импульсы
  const pulses = root.add(new Node3('pulses'));
  const ball = sphere(0.16, 10), pulseNodes: Node3[] = [];
  for (let i = 0; i < 18; i++) { const n = pulses.add(new Node3('pulse', ball, MAT.glow([1, 1, 1]))); n.visible = false; pulseNodes.push(n); }

  // щупы мультиметра
  const probes = root.add(new Node3('probes'));
  probes.visible = false;
  const probeGeom = (): [Geometry, Geometry] => [
    merge(placed(cylinder(0.2, 0.25, 2.1, 16), [0, 2.0, 0]), placed(cylinder(0.38, 0.38, 0.1, 16), [0, 0.97, 0]), placed(cylinder(0.09, 0.2, 0.3, 12), [0, 0.82, 0])),
    merge(placed(cylinder(0.015, 0.05, 0.7, 8), [0, 0.35, 0])),
  ];
  const mkProbe = (c0: Vec3) => {
    const col = lin(c0);
    const g = probes.add(new Node3('probe')), [h, tip] = probeGeom();
    g.add(new Node3('handle', h, { color: col, rough: 0.4 }));
    g.add(new Node3('tip', tip, MAT.steel()));
    const lead = probes.add(new Node3('lead', null, { color: V.mul(col, 0.8), rough: 0.6 }));
    return { g, lead };
  };
  const red = mkProbe([0.85, 0.08, 0.06]), black = mkProbe([0.06, 0.06, 0.07]);
  const placeProbe = (pr: { g: Node3; lead: Node3 }, tip: Vec3, jack: Vec3, lean: Vec3) => {
    pr.g.local = M.trs(tip, lean);
    const end = M.point(pr.g.local, [0, 3.05, 0]), dir = V.norm(V.sub(end, tip));
    const mid: Vec3 = [(end[0] + jack[0]) / 2, Math.max(end[1], 3) + 1.0, Math.min((end[2] + jack[2]) / 2, -6)];
    pr.lead.geom = tube(smoothPath([end, V.add(end, V.mul(dir, 1.0)), mid, [jack[0], jack[1] + 1.6, jack[2] + 0.9], jack], 10), 0.085, 6);
    viewer.invalidate(pr.lead);
  };
  const jackR: Vec3 = [METER[0] + 0.5, TABLE_Y + 0.7, METER[2] + 1.45], jackB: Vec3 = [METER[0] - 0.5, TABLE_Y + 0.7, METER[2] + 1.45];

  // состояние
  let selected: string | null = null, hovered: Node3 | null = null, active = false, checkT = 0;
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const applyLook = () => {
    for (const [id, n] of nets) {
      const sel = id === selected;
      n.wire.mat.opacity = selected && !sel ? 0.25 : 1;
      n.wire.highlight = sel ? 1 : hovered === n.proxy ? 0.6 : 0;
      n.wire.mat.emissive = sel ? V.mul(lin(n.def.color), 0.9) : [0, 0, 0];
      n.halo.visible = sel;
    }
    for (const n of blockNodes.values()) n.highlight = hovered === n ? 0.45 : 0;
  };
  const isActive = (id: string): boolean => {
    const st = getState(), def = nets.get(id)?.def;
    if (!def || !st.live || !st.telemetry) return false;
    if (!['pwm', 'serial', 'logic', 'hv'].includes(def.kind)) return false;
    const t = st.telemetry;
    if (id === 'IAC_IN' || id === 'IAC_OUT') return t.iacPos !== t.iacTarget || t.actuatorTest === 5 || t.actuatorTest === 6;
    const w = probeNet(id, t, st.params.dwell_us).wave;
    if (!w) return false;
    let lo = Infinity, hi = -Infinity;
    for (const p of w.points) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    return hi - lo > 0.5;
  };

  viewer.onHover = (hit, ev) => {
    if (hit !== hovered) { hovered = hit; applyLook(); }
    viewer.canvas.style.cursor = hit ? 'pointer' : '';
    const r = viewer.canvas.getBoundingClientRect();
    opts.onHover(hit ? hit.label : null, ev.clientX - r.left, ev.clientY - r.top);
  };
  viewer.onPick = (hit) => {
    if (!hit) return;
    if (typeof hit.data.net === 'string') opts.onNet(hit.data.net);
    else if (typeof hit.data.block === 'string') opts.onBlock(hit.data.block as BlockId);
  };
  const scene: BoardScene = {
    labels, afterFrame: null,
    select(net, fly = true) {
      selected = net && nets.has(net) ? net : null;
      applyLook();
      checkT = 0;
      const n = selected ? nets.get(selected)! : null;
      probes.visible = !!n;
      if (n) {
        const tip = wiring.probe[n.def.id];
        placeProbe(red, tip, jackR, [-0.3, 0, -0.5]);
        placeProbe(black, wiring.ground, jackB, [-0.45, 0, -0.35]);
        const col = n.def.color as readonly number[] as Vec3, bright = V.add(V.mul(col, 0.7), [0.35, 0.35, 0.35]);
        for (const p of pulseNodes) p.mat = MAT.glow(bright);
        if (fly) {
          const c: Vec3 = [(n.centre[0] * 2 + tip[0]) / 3, 0.3, (n.centre[2] * 2 + tip[2]) / 3];
          viewer.flyTo({ target: c, dist: Math.min(camFor('iso').dist, Math.max(24, n.extent * 1.5 + 12)), pitch: Math.max(0.75, Math.min(1.15, viewer.cam.pitch)) }, reduceMotion ? 0.01 : 0.7);
        }
      } else for (const p of pulseNodes) p.visible = false;
    },
    view(name) { viewer.flyTo(camFor(name), reduceMotion ? 0.01 : 0.6); },
  };

  viewer.onFrame = (dt, t) => {
    const n = selected ? nets.get(selected) : null;
    if (n) {
      checkT -= dt;
      if (checkT <= 0) { checkT = 0.3; active = isActive(n.def.id); }
      // выбранная цепь: импульсы, если сигнал переменный и сейчас идёт; иначе ровное свечение
      n.halo.mat.opacity = active && !reduceMotion ? 0.28 : 0.42;
      const show = active && !reduceMotion;
      let k = 0;
      if (show) {
        const speed = 5, gap = 3.2;
        for (const path of n.paths) {
          const count = Math.max(1, Math.min(6, Math.floor(path.len / gap)));
          for (let i = 0; i < count && k < pulseNodes.length; i++) {
            const s = (t * speed + (i * path.len) / count) % path.len;
            let j = 1;
            while (j < path.cum.length - 1 && path.cum[j] < s) j++;
            const f = (s - path.cum[j - 1]) / Math.max(1e-6, path.cum[j] - path.cum[j - 1]), p = V.lerp(path.pts[j - 1], path.pts[j], f);
            const node = pulseNodes[k++];
            node.visible = true; node.local = M.translation(p[0], p[1], p[2]);
          }
        }
      }
      for (; k < pulseNodes.length; k++) pulseNodes[k].visible = false;
    }
    scene.afterFrame?.();
  };
  return scene;
}
