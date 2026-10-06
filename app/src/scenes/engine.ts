// 3D-модель силовой головки «Вихрь-30»: двухтактный, 2 цилиндра в ряд, коленвал вертикальный (ось Y),
// цилиндры лежат горизонтально (ось X) один над другим. Единица сцены ≈ 1 см.
import { M, type Mat4, type Vec3 } from '../gl/math';
import {
  box, cylinder, tubeY, lathe, sphere, torus, tube, smoothPath, extrude, roundedRect, hexPrism, merge, transform,
  type Geometry,
} from '../gl/geometry';
import { Node3, MAT, type Material, type Viewer } from '../gl/viewer';
import type { Telemetry } from '../core/types';

// ---------- размеры кривошипно-шатунного механизма ----------
export const CRANK_R = 3.0;        // радиус кривошипа (ход 60 мм)
export const ROD_L = 12.0;         // длина шатуна
export const BORE_R = 3.6;         // радиус цилиндра (72 мм)
export const CYL_Y: [number, number] = [4.8, -4.8]; // оси цилиндров: 1 — верхний, 2 — нижний
export const PIN_TO_CROWN = 3.32;  // от оси пальца до вершины днища поршня
export const PIN_TO_SKIRT = 3.0;   // от оси пальца до низа юбки
export const LINER_X0 = 6.3;       // начало гильзы (со стороны картера)
export const DECK_X = 18.6;        // плоскость разъёма блок/головка
export const WEB_R = 5.5;          // наибольший радиус щеки коленвала

export type ValueKey = 'rpm' | 'tps' | 'map' | 'cht' | 'iat' | 'o2' | 'pw' | 'adv' | 'iac' | 'heater';
export type ViewMode = 'solid' | 'ghost' | 'section';
export interface PartInfo { desc: string; net?: string; value?: ValueKey }
export interface Anchor { id: ValueKey; title: string; pos: Vec3; /** Наружная нормаль: с обратной стороны деталь закрыта корпусом. */ normal: Vec3 }

/** Положение механизма для угла коленвала theta (рад), цилиндр cyl = 0 или 1 (сдвиг 180°). */
export function kinematics(theta: number, cyl: 0 | 1) {
  const a = theta + cyl * Math.PI;
  const pinX = CRANK_R * Math.cos(a), pinZ = -CRANK_R * Math.sin(a);
  // x = r·cosθ + sqrt(L² − r²·sin²θ)
  const pistonX = CRANK_R * Math.cos(a) + Math.sqrt(ROD_L * ROD_L - CRANK_R * CRANK_R * Math.sin(a) ** 2);
  const rodAngle = Math.atan2(pinZ, pistonX - pinX); // поворот шатуна вокруг Y (локальная ось X шатуна смотрит на палец)
  return { pinX, pinZ, pistonX, rodAngle };
}

/** Видимая частота вращения (об/с) и множитель замедления для данных оборотов. */
export function slowdown(rpm: number): { visHz: number; factor: number } {
  const real = Math.max(0, rpm) / 60;
  if (real <= 0) return { visHz: 0, factor: 1 };
  const cap = 0.5 + Math.min(1, rpm / 6000); // 0,5…1,5 об/с — чем выше обороты, тем заметно быстрее
  const visHz = Math.min(real, cap);
  return { visHz, factor: real / visHz };
}

// ---------- помощники геометрии ----------
type Ax = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
const H = Math.PI / 2;
const AXM: Record<Ax, Mat4> = {
  '+y': M.identity(), '-y': M.rotZ(Math.PI), '+x': M.rotZ(-H), '-x': M.rotZ(H), '+z': M.rotX(H), '-z': M.rotX(-H),
};
const at = (g: Geometry, x: number, y: number, z: number) => transform(g, M.translation(x, y, z));
/** Геометрию, построенную вдоль +Y от начала координат, направить вдоль оси ax и поставить в pos. */
const along = (g: Geometry, ax: Ax, pos: Vec3 = [0, 0, 0]) => transform(g, M.mul(M.translation(pos[0], pos[1], pos[2]), AXM[ax]));
/** Цилиндр от точки pos длиной len вдоль оси ax. */
const cyl = (ax: Ax, pos: Vec3, r: number, len: number, seg = 20, r2 = r) => along(at(cylinder(r, r2, len, seg), 0, len / 2, 0), ax, pos);
/** Кольцо (втулка) от pos длиной len вдоль ax. */
const ring = (ax: Ax, pos: Vec3, ro: number, ri: number, len: number, seg = 32) => along(at(tubeY(ro, ri, len, seg), 0, len / 2, 0), ax, pos);
/** Болт: шайба + шестигранная головка, «растёт» из pos вдоль ax. */
const bolt = (ax: Ax, pos: Vec3, s = 0.8, h = 0.42) =>
  along(merge(at(cylinder(s * 0.74, s * 0.74, 0.09, 12), 0, 0.045, 0), at(hexPrism(s, h), 0, 0.09, 0)), ax, pos);
const bx = (w: number, h: number, d: number, x: number, y: number, z: number) => at(box(w, h, d), x, y, z);
const rod = (a: Vec3, b: Vec3, r: number, sides = 10) => tube([a, b], r, sides, true);
const hose = (pts: Vec3[], r: number, sides = 10) => tube(smoothPath(pts, 8), r, sides, true);

/** Призма по выпуклому контуру (x, z) высотой h вдоль Y; обход исправляется сам. */
function prism(pts: [number, number][], h: number): Geometry {
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length]; area += x0 * z1 - x1 * z0; }
  return extrude(area > 0 ? pts.slice().reverse() : pts, h);
}

/** Прямоугольная пластина в плоскости x = 0 (y0..y1 × z0..z1) с круглым отверстием радиуса r в начале координат. */
function holedPlate(y0: number, y1: number, z0: number, z1: number, r: number, nx: 1 | -1, seg = 48): Geometry {
  const T = Math.PI * 2, angs: number[] = [];
  for (let i = 0; i < seg; i++) angs.push((i / seg) * T);
  for (const [cy, cz] of [[y1, z1], [y0, z1], [y0, z0], [y1, z0]]) angs.push((Math.atan2(cz, cy) + T) % T);
  angs.sort((a, b) => a - b);
  angs.push(angs[0] + T);
  const p: number[] = [], n: number[] = [], idx: number[] = [];
  for (const a of angs) {
    const c = Math.cos(a), s = Math.sin(a);
    let t = Infinity;
    if (c > 1e-9) t = Math.min(t, y1 / c); else if (c < -1e-9) t = Math.min(t, y0 / c);
    if (s > 1e-9) t = Math.min(t, z1 / s); else if (s < -1e-9) t = Math.min(t, z0 / s);
    p.push(0, r * c, r * s, 0, t * c, t * s);
    n.push(nx, 0, 0, nx, 0, 0);
  }
  for (let k = 0; k + 1 < angs.length; k++) { const i0 = k * 2; idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2); }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/** Тёмное «окно» на внутренней стенке гильзы: дуга цилиндра вдоль X. Угол: 0° — низ (−Y), 90° — +Z, 180° — верх, 270° — −Z. */
function portPatch(yc: number, x0: number, x1: number, centerDeg: number, widthDeg: number): Geometry {
  const w = (widthDeg * Math.PI) / 180, c = (centerDeg * Math.PI) / 180;
  const g = lathe([[BORE_R - 0.012, x1], [BORE_R - 0.012, x0]], 10, w); // нормаль внутрь цилиндра
  return transform(g, M.chain(M.translation(0, yc, 0), M.rotZ(-H), M.rotY(-(c - w / 2))));
}

const mat = (color: Vec3, metal: number, rough: number): Material => ({ color, metal, rough });
const BLACK_PLASTIC = (): Material => MAT.plastic([0.045, 0.047, 0.052]);
const CAST_IRON = (): Material => mat([0.3, 0.31, 0.33], 0.9, 0.42);

/** Цвет тепловой карты: 20 °C — синий, 60 — зелёно-жёлтый, 90 — оранжевый, 110 — красный. */
export function heatColor(tC: number): Vec3 {
  const stops: [number, Vec3][] = [[15, [0.1, 0.25, 0.85]], [40, [0.08, 0.6, 0.75]], [60, [0.2, 0.75, 0.3]], [78, [0.9, 0.78, 0.12]], [92, [1, 0.42, 0.08]], [110, [0.95, 0.08, 0.06]]];
  if (tC <= stops[0][0]) return stops[0][1];
  for (let i = 0; i + 1 < stops.length; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    if (tC <= t1) { const k = (tC - t0) / (t1 - t0); return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]; }
  }
  return stops[stops.length - 1][1];
}

interface PartOpts {
  info?: PartInfo; ex?: Vec3; hull?: boolean; heat?: 'cht' | 'iat'; noClip?: boolean; pick?: boolean; local?: Mat4; net?: string; value?: ValueKey; desc?: string;
}

export interface EngineScene {
  root: Node3;
  update(dt: number, t: Telemetry | null, live: boolean): void;
  setMode(m: ViewMode): void;
  setExplode(e: number): void;
  setHeat(on: boolean): void;
  setIacMax(steps: number): void;
  highlight(hover: Node3 | null, selected: Node3 | null): void;
  readonly anchors: Anchor[];
  /** Текущее состояние анимации (для отладки и проверки). */
  readonly state: { theta: number; visHz: number; factor: number; running: boolean; sparks: number; skipped: number; spraying: boolean; nodes: number; spark: number[]; burn: number[] };
}

export function createEngineScene(viewer: Pick<Viewer, 'root' | 'clip'>): EngineScene {
  const eng = viewer.root.add(new Node3('engine'));
  const exNodes: Node3[] = [], hullNodes: Node3[] = [], heatNodes: Node3[] = [], all: Node3[] = [];

  function part(parent: Node3, name: string, label: string, geom: Geometry | null, m: Material, o: PartOpts = {}): Node3 {
    const n = parent.add(new Node3(name, geom, m));
    n.label = label;
    n.pickable = o.pick ?? !!label;
    if (o.local) n.local = o.local;
    if (o.noClip) m.noClip = true;
    n.data.base = n.local;
    if (o.ex) { n.data.ex = o.ex; exNodes.push(n); }
    if (o.hull) hullNodes.push(n);
    if (o.heat) { n.data.heat = o.heat; heatNodes.push(n); }
    if (o.desc) n.data.info = { desc: o.desc, net: o.net, value: o.value } satisfies PartInfo;
    if (o.net) n.data.net = o.net;
    n.data.mat0 = { ...m };
    all.push(n);
    return n;
  }
  const group = (parent: Node3, name: string, ex?: Vec3, local?: Mat4) => part(parent, name, '', null, { color: [1, 1, 1] }, { ex, local, pick: false });

  // ====================== КАРТЕР ======================
  {
    const gap = 0.62; // проём в сторону цилиндров, рад
    const wall = transform(lathe([[6.2, -10.4], [6.9, -10.4], [6.9, 9.6], [6.2, 9.6], [6.2, -10.4]], 44, Math.PI * 2 - 2 * gap), M.rotY(-gap));
    const ribs: Geometry[] = [];
    for (const deg of [112, 142, 218, 248]) {
      const a = (deg * Math.PI) / 180;
      ribs.push(transform(bx(0.9, 19.2, 0.45, 7.2, -0.4, 0), M.rotY(-a)));
    }
    const g = merge(
      wall,
      ring('+y', [0, 8.4, 0], 6.9, 2.5, 1.2, 44), ring('+y', [0, -10.4, 0], 6.9, 2.5, 2.0, 44), ring('+y', [0, -0.5, 0], 6.5, 2.5, 1.0, 44),
      ring('+y', [0, 9.6, 0], 2.9, 1.7, 1.2, 28), // верхняя бобышка подшипника
      // горловина к блоку
      bx(2.1, 0.6, 11, 5.25, 9.3, 0), bx(2.1, 1.4, 11, 5.25, -9.7, 0), bx(2.1, 20, 0.6, 5.25, -0.4, 5.2), bx(2.1, 20, 0.6, 5.25, -0.4, -5.2),
      // фланец к блоку
      bx(0.4, 0.6, 12.4, 6.1, 9.9, 0), bx(0.4, 20.6, 0.7, 6.1, -0.1, 5.85), bx(0.4, 20.6, 0.7, 6.1, -0.1, -5.85),
      // привалочная площадка впуска и фланцы разъёма половин картера
      bx(0.9, 16.4, 8.4, -7.05, 0, 0),
      bx(0.8, 20, 1.0, 0, -0.4, 7.25), bx(0.8, 20, 1.0, 0, -0.4, -7.25),
      ...ribs,
    );
    part(eng, 'crankcase', 'Картер', g, mat([0.4, 0.42, 0.45], 0.6, 0.62), {
      hull: true, desc: 'Литой алюминиевый картер из двух половин. Внутри — две отдельные кривошипные камеры: в двухтактном моторе каждая работает как насос, засасывая смесь через лепестковый клапан и вытесняя её в цилиндр по продувочным каналам.',
    });
    const bolts: Geometry[] = [];
    for (const z of [7.25, -7.25]) for (const y of [-8.6, -5, -1.4, 2.2, 5.8, 8.6]) { bolts.push(bolt('+x', [0.4, y, z], 0.75), bolt('-x', [-0.4, y, z], 0.75)); }
    for (const z of [5.85, -5.85]) for (const y of [-8.4, -4.2, 0, 4.2, 8.4]) bolts.push(bolt('-x', [5.9, y, z], 0.62, 0.38));
    part(eng, 'caseBolts', 'Болты и шпильки картера', merge(...bolts), MAT.steel(), { desc: 'Стягивают половины картера и крепят к нему блок цилиндров.' });
    part(eng, 'mainBearings', 'Коренные подшипники', merge(ring('+y', [0, 8.45, 0], 2.56, 1.56, 1.0), ring('+y', [0, -0.45, 0], 2.56, 1.56, 0.9), ring('+y', [0, -9.9, 0], 2.56, 1.56, 1.2)),
      MAT.darkSteel(), { desc: 'Три опоры коленчатого вала: верхняя, средняя (в перегородке между камерами) и нижняя.' });
  }

  // ====================== КОЛЕНВАЛ ======================
  const gCrank = group(eng, 'gCrank');
  const crankRot = group(gCrank, 'crankRot');
  {
    const outline: [number, number][] = [];
    for (let i = 0; i <= 20; i++) { const a = ((95 + (170 * i) / 20) * Math.PI) / 180; outline.push([WEB_R * Math.cos(a), WEB_R * Math.sin(a)]); }
    for (let i = 0; i <= 12; i++) { const a = ((-85 + (170 * i) / 12) * Math.PI) / 180; outline.push([3 + 2.2 * Math.cos(a), 2.2 * Math.sin(a)]); }
    const cheek = prism(outline, 1.0);
    const flip = M.rotY(Math.PI);
    const g = merge(
      at(cheek, 0, 2.6, 0), at(cheek, 0, 6.0, 0), cyl('+y', [3, 3.5, 0], 1.25, 2.6, 24),
      transform(at(cheek, 0, -3.6, 0), flip), transform(at(cheek, 0, -7.0, 0), flip), cyl('+y', [-3, -6.1, 0], 1.25, 2.6, 24),
      cyl('+y', [0, -3.1, 0], 1.5, 6.2, 28), cyl('+y', [0, 6.5, 0], 1.5, 4.9, 28), cyl('+y', [0, 11.4, 0], 1.5, 5.9, 24, 1.05),
      cyl('+y', [0, -12.9, 0], 1.5, 6.4, 28), cyl('+y', [0, -13.9, 0], 1.0, 1.0, 20),
    );
    part(crankRot, 'crank', 'Коленчатый вал', g, mat([0.3, 0.33, 0.4], 1, 0.34), {
      noClip: true, value: 'rpm',
      desc: 'Стоит вертикально. Два кривошипа развёрнуты на 180°, поэтому поршни ходят в противофазе. Щёки с противовесами уравновешивают шатуны и заполняют объём кривошипных камер. Нижний конец передаёт вращение на вертикальный вал дейдвуда.',
    });
  }

  // ====================== ШАТУНЫ И ПОРШНИ ======================
  const gRecip = group(eng, 'gRecip', [9, 0, 0]);
  const rods: Node3[] = [], pistons: Node3[] = [];
  {
    const rodGeom = merge(
      at(tubeY(1.95, 1.27, 2.0, 28), 0, 0, 0), at(tubeY(1.3, 0.76, 2.0, 24), ROD_L, 0, 0),
      bx(8.95, 0.45, 1.5, 6.3, 0, 0), bx(8.95, 1.3, 0.32, 6.3, 0, 0.75), bx(8.95, 1.3, 0.32, 6.3, 0, -0.75),
    );
    const body = merge(
      lathe([[3.1, -PIN_TO_SKIRT], [3.54, -PIN_TO_SKIRT], [3.54, 1.5], [3.42, 1.5], [3.42, 1.8], [3.54, 1.8], [3.54, 2.15], [3.42, 2.15], [3.42, 2.45], [3.54, 2.45], [3.54, 3.0], [3.3, 3.2], [0, PIN_TO_CROWN]], 40),
      lathe([[0, 2.3], [3.1, 2.3], [3.1, -PIN_TO_SKIRT]], 40),
    );
    const pistonGeom = transform(body, AXM['+x']);
    const ringsGeom = merge(ring('+x', [1.52, 0, 0], 3.57, 3.4, 0.26, 40), ring('+x', [2.17, 0, 0], 3.57, 3.4, 0.26, 40));
    const pinGeom = cyl('+y', [0, -2.8, 0], 0.75, 5.6, 20);
    for (const i of [0, 1] as const) {
      const n = i + 1;
      rods.push(part(gRecip, 'rod' + n, 'Шатун ' + n, rodGeom, mat([0.66, 0.5, 0.3], 1, 0.4), {
        noClip: true, desc: 'Связывает поршень с шатунной шейкой коленвала и превращает возвратно-поступательное движение во вращение. В модели движется по точной формуле кривошипно-шатунного механизма.',
      }));
      const p = group(gRecip, 'pist' + n);
      pistons.push(p);
      part(p, 'piston' + n, 'Поршень ' + n, pistonGeom, MAT.machinedAlu(), {
        desc: n === 1 ? 'Поршень верхнего цилиндра. Его юбка открывает и закрывает выпускное и продувочные окна — клапанов в двухтактном моторе нет.' : 'Поршень нижнего цилиндра, движется в противофазе с верхним.',
      });
      part(p, 'rings' + n, 'Поршневые кольца ' + n, ringsGeom, MAT.darkSteel(), { desc: 'Два компрессионных кольца уплотняют поршень в гильзе.' });
      part(p, 'wpin' + n, 'Поршневой палец ' + n, pinGeom, MAT.steel(), { noClip: true, desc: 'Ось, на которой верхняя головка шатуна качается в поршне.' });
    }
  }

  // ====================== БЛОК ЦИЛИНДРОВ ======================
  const BX: Vec3 = [22, 0, 0];
  {
    const cx = (LINER_X0 + DECK_X) / 2, len = DECK_X - LINER_X0;
    const shell = merge(
      bx(len, 0.6, 11, cx, 9.3, 0), bx(len, 1.4, 11, cx, -9.7, 0), bx(len, 20, 0.6, cx, -0.4, 5.2), bx(len, 20, 0.6, cx, -0.4, -5.2),
      // фланцы: к картеру и под головку
      bx(0.6, 0.6, 12.4, 6.6, 9.9, 0), bx(0.6, 20.6, 0.7, 6.6, -0.1, 5.85), bx(0.6, 20.6, 0.7, 6.6, -0.1, -5.85),
      bx(0.7, 0.6, 12.4, 18.25, 9.9, 0), bx(0.7, 20.6, 0.7, 18.25, -0.1, 5.85), bx(0.7, 20.6, 0.7, 18.25, -0.1, -5.85),
      // торцевые стенки с отверстиями под гильзы
      at(holedPlate(-4.8, 4.8, -5.2, 5.2, 4.1, -1), LINER_X0 + 0.04, 4.8, 0), at(holedPlate(-5.6, 4.8, -5.2, 5.2, 4.1, -1), LINER_X0 + 0.04, -4.8, 0),
      at(holedPlate(-4.8, 4.8, -5.2, 5.2, 4.1, 1), DECK_X - 0.04, 4.8, 0), at(holedPlate(-5.6, 4.8, -5.2, 5.2, 4.1, 1), DECK_X - 0.04, -4.8, 0),
      // рёбра сверху
      bx(10, 0.5, 0.35, 12.4, 9.85, -3.2), bx(10, 0.5, 0.35, 12.4, 9.85, 0), bx(10, 0.5, 0.35, 12.4, 9.85, 3.2),
    );
    part(eng, 'block', 'Блок цилиндров с рубашкой охлаждения', shell, mat([0.5, 0.52, 0.55], 0.6, 0.58), {
      ex: BX, hull: true, desc: 'Общий блок двух горизонтальных цилиндров. Между гильзами и наружной стенкой — рубашка, по которой забортная вода от помпы идёт к головке.',
    });
    part(eng, 'liners', 'Гильзы цилиндров', merge(ring('+x', [LINER_X0, CYL_Y[0], 0], 4.15, BORE_R, len, 48), ring('+x', [LINER_X0, CYL_Y[1], 0], 4.15, BORE_R, len, 48)), CAST_IRON(), {
      ex: BX, hull: true, desc: 'Чугунные гильзы диаметром 72 мм, ход поршня 60 мм. В стенках — выпускные и продувочные окна.',
    });
    const dark = (): Material => mat([0.015, 0.015, 0.018], 0, 1);
    part(eng, 'exPorts', 'Выпускные окна', merge(portPatch(CYL_Y[0], 12.5, 14.7, 270, 66), portPatch(CYL_Y[1], 12.5, 14.7, 270, 66)), dark(), {
      ex: BX, desc: 'Открываются кромкой поршня при движении к нижней мёртвой точке: отработавшие газы уходят в выпускной коллектор.',
    });
    const tp: Geometry[] = [];
    for (const yc of CYL_Y) for (const a of [0, 90, 180]) tp.push(portPatch(yc, 12.5, 13.7, a, 44));
    part(eng, 'trPorts', 'Продувочные окна', merge(...tp), dark(), {
      ex: BX, desc: 'Через них свежая смесь, сжатая под поршнем в кривошипной камере, перетекает в цилиндр и выталкивает остатки газов.',
    });

    // выпуск (сторона −Z)
    const EXH: Vec3 = [22, 0, -9];
    part(eng, 'exhMan', 'Выпускной коллектор', transform(extrude(roundedRect(5.8, 14.4, 1.3), 1.9), M.chain(M.translation(13.8, 2, -5.5), M.rotX(-H))), mat([0.4, 0.36, 0.33], 0.6, 0.65), {
      ex: EXH, hull: true, desc: 'Собирает газы из выпускных окон обоих цилиндров и направляет их вниз.',
    });
    const eb: Geometry[] = [];
    for (const y of [-3.6, 2, 7.6]) for (const x of [11.6, 16]) eb.push(bolt('-z', [x, y, -7.4], 0.7));
    part(eng, 'exhBolts', 'Болты выпускного коллектора', merge(...eb), MAT.steel(), { ex: EXH, desc: 'Крепят коллектор к блоку через прокладку.' });
    part(eng, 'exhPipe', 'Выпускной патрубок', merge(cyl('-y', [13.8, -4.6, -6.75], 1.45, 5.8, 28), ring('+y', [13.8, -10.4, -6.75], 2.1, 1.4, 0.4, 24), cyl('-z', [13.8, -7.6, -8.0], 0.8, 0.55, 16)),
      mat([0.36, 0.33, 0.3], 0.9, 0.6), { ex: [22, -3, -9], hull: true, desc: 'Уводит отработавшие газы вниз, в дейдвуд, где они смешиваются с водой и выходят под воду. В патрубок ввёрнут лямбда-зонд.' });
    const lam = lathe([[0, -0.5], [0.5, -0.5], [0.5, 0.5], [0.85, 0.5], [0.85, 1.1], [0.6, 1.1], [0.6, 2.5], [0.42, 2.7], [0.42, 3.3], [0, 3.3]], 6 * 3);
    part(eng, 'lambda', 'Лямбда-зонд', along(lam, '-z', [13.8, -7.6, -8.55]), mat([0.62, 0.6, 0.55], 1, 0.35), {
      ex: [22, -3, -15], net: 'PA7', value: 'o2', desc: 'Узкополосный датчик кислорода в выпуске. После прогрева выдаёт около 0,1 В на бедной смеси и 0,9 В на богатой. В двухтактном моторе показания ориентировочные из-за масла и продувки.',
    });
    part(eng, 'lambdaHarness', 'Жгут лямбда-зонда (сигнал и нагреватель)',
      merge(hose([[13.8, -7.6, -11.8], [13.2, -7.2, -12.6], [11.6, -5.4, -11.2], [10.4, -3.2, -8.2], [10.2, -2.2, -6.4]], 0.2, 8), bx(1.0, 1.3, 0.8, 10.2, -1.7, -5.9)),
      BLACK_PLASTIC(), { ex: [22, -3, -15], net: 'HEAT', value: 'heater', desc: 'Четыре провода: сигнал, масса сигнала и два провода нагревателя. Блок управляет нагревателем ключом по минусу.' });

    // крышки продувочных каналов и катушки (сторона +Z)
    const cov: Geometry[] = [], cb: Geometry[] = [];
    for (const yc of CYL_Y) {
      cov.push(transform(extrude(roundedRect(6.4, 6.4, 1.0), 0.6), M.chain(M.translation(13.2, yc, 5.5), M.rotX(H))));
      for (const dx of [-2.6, 2.6]) for (const dy of [-2.6, 2.6]) cb.push(bolt('+z', [13.2 + dx, yc + dy, 6.1], 0.6, 0.35));
    }
    part(eng, 'trCovers', 'Крышки продувочных каналов', merge(...cov), mat([0.58, 0.59, 0.61], 0.7, 0.5), { ex: [22, 0, 5], hull: true, desc: 'Закрывают литые каналы, по которым смесь идёт из кривошипных камер к продувочным окнам.' });
    part(eng, 'trBolts', 'Болты крышек', merge(...cb), MAT.steel(), { ex: [22, 0, 6.5], desc: 'Крепёж крышек продувочных каналов.' });
  }

  // ====================== ЗАЖИГАНИЕ: катушки, провода, наконечники ======================
  const IGN: Vec3 = [22, 0, 13];
  const plugCeramics: Node3[] = [], sparkCore: Node3[] = [], sparkHalo: Node3[] = [];
  for (const i of [0, 1] as const) {
    const n = i + 1, yc = CYL_Y[i];
    const coil = part(eng, 'coil' + n, 'Катушка зажигания ' + n,
      merge(bx(3.4, 3.0, 2.3, 13.2, yc, 7.45), cyl('+x', [14.9, yc, 7.7], 0.62, 1.5, 16), cyl('+x', [16.2, yc, 7.7], 0.75, 0.25, 16), bx(0.7, 1.3, 1.0, 11.2, yc, 7.6)),
      BLACK_PLASTIC(), {
        ex: IGN, net: 'COIL' + n, value: 'adv',
        desc: `Отдельная катушка цилиндра ${n}. Блок замыкает её первичную обмотку на массу для накопления энергии и размыкает в момент искры — по своей катушке на цилиндр, без распределителя.`,
      });
    part(coil, 'coilCore' + n, '', merge(bx(4.0, 0.9, 0.2, 13.2, yc, 6.2), bx(0.7, 3.4, 0.7, 13.2, yc, 8.4), bolt('+z', [11.5, yc, 6.3], 0.5, 0.3), bolt('+z', [14.9, yc, 6.3], 0.5, 0.3)), MAT.darkSteel(), { pick: false });
    part(eng, 'hv' + n, 'Высоковольтный провод ' + n,
      hose([[16.4, yc, 7.7], [18.6, yc, 7.95], [22.2, yc, 7.7], [26.0, yc, 5.6], [27.3, yc, 2.4], [26.9, yc, 0.4], [25.8, yc, 0]], 0.26, 10),
      mat([0.55, 0.06, 0.05], 0, 0.5), { ex: IGN, net: 'COIL' + n, desc: 'Подаёт высокое напряжение от катушки к свече. Нужен провод с распределённым сопротивлением или помехоподавляющий наконечник, иначе помехи сбивают датчик коленвала.' });
    part(eng, 'boot' + n, 'Наконечник свечи ' + n, merge(cyl('+x', [23.7, yc, 0], 0.8, 2.3, 18), cyl('+x', [23.4, yc, 0], 0.95, 0.4, 18)), MAT.rubber(), {
      ex: IGN, noClip: true, desc: 'Резиновый наконечник с помехоподавляющим резистором.',
    });

    // свеча
    const plug = part(eng, 'plug' + n, 'Свеча зажигания ' + n,
      merge(cyl('+x', [20.5, yc, 0], 0.7, 1.5, 18), along(at(hexPrism(1.6, 0.7), 0, 0, 0), '+x', [22.0, yc, 0]), cyl('+x', [24.6, yc, 0], 0.25, 0.45, 12), cyl('+x', [20.15, yc, 0], 0.13, 0.4, 8), bx(0.08, 0.5, 0.2, 20.1, yc + 0.33, 0)),
      mat([0.7, 0.7, 0.72], 1, 0.3), { ex: [44, 0, 0], noClip: true, value: 'adv', net: 'COIL' + n, desc: `Свеча цилиндра ${n}. Искра проскакивает за несколько градусов до верхней мёртвой точки — этот угол опережения (УОЗ) блок берёт из таблицы зажигания.` });
    plugCeramics.push(part(plug, 'plugCer' + n, '',
      along(lathe([[0, 0], [0.55, 0], [0.55, 0.3], [0.48, 0.38], [0.55, 0.46], [0.48, 0.54], [0.55, 0.62], [0.48, 0.7], [0.55, 0.78], [0.45, 1.3], [0.36, 1.95], [0, 1.95]], 18), '+x', [22.7, yc, 0]),
      MAT.ceramic(), { pick: false, noClip: true }));
    sparkCore.push(part(plug, 'spark' + n, '', sphere(0.3, 12), MAT.glow([0.75, 0.88, 1]), { pick: false, local: M.translation(20.08, yc + 0.12, 0) }));
    const halo = part(plug, 'sparkHalo' + n, '', sphere(1, 14), { color: [0.45, 0.65, 1], unlit: true, opacity: 0.3 }, { pick: false, local: M.translation(20.08, yc + 0.12, 0) });
    sparkHalo.push(halo);
  }

  // ====================== ГОЛОВКА ======================
  const HX: Vec3 = [36, 0, 0];
  const domes: Node3[] = [], burnGlow: Node3[] = [];
  {
    const x0 = DECK_X + 0.15, x1 = 21.5, cx = (x0 + x1) / 2, w = x1 - x0;
    const ribs: Geometry[] = [];
    for (const y of [-9.4, -7.4, -2.2, -0.9, 0.9, 2.2, 7.4, 8.9]) ribs.push(bx(0.45, 0.32, 10.4, x1 + 0.2, y, 0));
    const g = merge(
      bx(w, 0.35, 11, cx, 9.425, 0), bx(w, 0.35, 11, cx, -10.225, 0), bx(w, 20, 0.35, cx, -0.4, 5.325), bx(w, 20, 0.35, cx, -0.4, -5.325),
      bx(0.35, 20, 11, x1 - 0.175, -0.4, 0),
      at(holedPlate(-4.8, 4.8, -5.5, 5.5, BORE_R, -1), x0 + 0.02, 4.8, 0), at(holedPlate(-5.6, 4.8, -5.5, 5.5, BORE_R, -1), x0 + 0.02, -4.8, 0),
      ring('+x', [x1, CYL_Y[0], 0], 1.5, 0.72, 0.5, 24), ring('+x', [x1, CYL_Y[1], 0], 1.5, 0.72, 0.5, 24),
      cyl('+x', [x1, 0, -2.4], 0.75, 0.3, 16),
      ...ribs,
    );
    part(eng, 'head', 'Головка цилиндров', g, mat([0.36, 0.38, 0.41], 0.6, 0.55), {
      ex: HX, hull: true, heat: 'cht', value: 'cht',
      desc: 'Общая головка двух цилиндров с водяной рубашкой и двумя свечами. Самое горячее место мотора: по её температуре блок судит о прогреве и перегреве.',
    });
    for (const i of [0, 1] as const) {
      const d = part(eng, 'dome' + (i + 1), 'Камера сгорания ' + (i + 1),
        along(lathe([[0.7, 1.85], [1.3, 1.8], [2.3, 1.5], [3.0, 1.05], [3.45, 0.5], [BORE_R, 0]], 40), '+x', [x0, CYL_Y[i], 0]),
        mat([0.2, 0.185, 0.17], 0.3, 0.8), { ex: HX, hull: true, desc: 'Полусферическая камера в головке. После искры смесь сгорает здесь и давит на поршень.' });
      domes.push(d);
      burnGlow.push(part(eng, 'burn' + (i + 1), '', sphere(1, 20), { color: [1, 0.55, 0.15], unlit: true, opacity: 0 }, { pick: false }));
    }
    part(eng, 'gasket', 'Прокладка головки', merge(bx(0.15, 0.7, 11.2, 18.675, 9.35, 0), bx(0.15, 1.5, 11.2, 18.675, -9.75, 0), bx(0.15, 20.2, 0.7, 18.675, -0.4, 5.25), bx(0.15, 20.2, 0.7, 18.675, -0.4, -5.25), bx(0.15, 1.2, 9.8, 18.675, 0, 0)),
      MAT.copper(), { ex: [32, 0, 0], desc: 'Уплотняет стык блока и головки: держит давление газов и не даёт воде попасть в цилиндр.' });
    const hb: Geometry[] = [];
    for (const [y, z] of [[8.7, 4.6], [8.7, -4.6], [0, 4.6], [0, -4.6], [-9.5, 4.6], [-9.5, -4.6], [8.7, 0], [-9.5, 0]] as [number, number][]) hb.push(bolt('+x', [x1, y, z], 1.1, 0.55));
    part(eng, 'headBolts', 'Болты головки', merge(...hb), MAT.steel(), { ex: [41, 0, 0], desc: 'Затягиваются крест-накрест от середины к краям в два-три приёма.' });
    part(eng, 'cht', 'Термистор головки (CHT)', merge(along(at(hexPrism(1.0, 0.5), 0, 0, 0), '+x', [x1 + 0.3, 0, -2.4]), cyl('+x', [x1 + 0.8, 0, -2.4], 0.42, 0.5, 14)), MAT.brass(), {
      ex: [41, 0, -2], net: 'PA4', value: 'cht', desc: 'NTC-термистор 10 кОм, ввёрнут в головку между свечами. По нему блок обогащает смесь на холодном моторе и включает защиту от перегрева выше 85 °C.',
    }).add(new Node3('chtConn', merge(cyl('+x', [x1 + 1.3, 0, -2.4], 0.55, 1.0, 14)), BLACK_PLASTIC()));
    part(eng, 'thermostat', 'Корпус термостата', merge(along(lathe([[0, 0], [1.5, 0], [1.5, 0.3], [1.15, 0.5], [1.0, 1.1], [0.5, 1.4], [0, 1.4]], 24), '+y', [20.1, 9.6, 3.0]), cyl('+z', [20.1, 10.3, 3.6], 0.42, 1.2, 14), bolt('+y', [20.1, 9.9, 1.75], 0.5, 0.3), bolt('+y', [20.1, 9.9, 4.25], 0.5, 0.3)),
      MAT.machinedAlu(), { ex: [36, 5, 0], heat: 'cht', desc: 'Выход нагретой воды из головки. Термостат держит рабочую температуру, не давая мотору переохлаждаться.' });
  }

  // ====================== ВОДА ======================
  const inletPath: Vec3[] = [[8.4, -10.4, 7.3], [8.4, -8.9, 7.3], [8.4, -7.8, 6.9], [8.4, -7.5, 5.9], [8.4, -7.5, 5.4]];
  const outletPath: Vec3[] = [[20.1, 10.3, 4.6], [20.1, 10.35, 6.0], [20.1, 9.3, 6.75], [20.1, 6, 6.8], [20.1, -6, 6.8], [20.1, -10.4, 6.8]];
  const waterIn = part(eng, 'waterIn', 'Патрубок подвода воды',
    merge(hose(inletPath, 0.5), ring('+y', [8.4, -10.4, 7.3], 0.75, 0.45, 0.5, 14), ring('+y', [8.4, -9.4, 7.3], 0.62, 0.48, 0.3, 14)),
    MAT.rubber(), { ex: [22, -2, 6], desc: 'Забортная вода от помпы в дейдвуде поднимается сюда и входит в рубашку блока.' });
  const waterOut = part(eng, 'waterOut', 'Патрубок отвода воды',
    merge(hose(outletPath, 0.5), ring('+z', [20.1, 10.3, 4.3], 0.62, 0.48, 0.3, 14), ring('+y', [20.1, -10.4, 6.8], 0.75, 0.45, 0.5, 14), bx(0.5, 0.5, 0.9, 20.1, 4, 5.95), bx(0.5, 0.5, 0.9, 20.1, -5, 5.95)),
    MAT.rubber(), { ex: [36, 0, 7], desc: 'Нагретая вода из головки уходит вниз, в дейдвуд, и сбрасывается за борт вместе с выхлопом. Бегущие метки показывают поток при работающем моторе.' });
  const waterMarks: { node: Node3; path: Vec3[]; len: number[]; total: number; off: number }[] = [];
  for (const [parent, raw, count] of [[waterIn, inletPath, 3], [waterOut, outletPath, 7]] as [Node3, Vec3[], number][]) {
    const path = smoothPath(raw, 8), len = [0];
    for (let i = 1; i < path.length; i++) len.push(len[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
    for (let k = 0; k < count; k++) {
      const node = part(parent, 'wm', '', sphere(0.62, 10), { color: [0.25, 0.75, 1], unlit: true, opacity: 0.85 }, { pick: false });
      node.visible = false;
      waterMarks.push({ node, path, len, total: len[len.length - 1], off: k / count });
    }
  }

  // ====================== МАХОВИК, СТАТОР, ДПКВ ======================
  const gFly = group(eng, 'gFly', [0, 12, 0]);
  const flyRot = group(gFly, 'flyRot');
  {
    const fly = lathe([[8.4, 11.4], [9.6, 11.4], [9.6, 14.3], [9.3, 14.6], [2.6, 14.6], [2.6, 15.2], [1.1, 15.2], [1.1, 12.6], [2.4, 12.6], [2.4, 13.7], [8.4, 13.7], [8.4, 11.4]], 72);
    part(flyRot, 'flywheel', 'Маховик', fly, mat([0.15, 0.16, 0.18], 0.8, 0.5), {
      value: 'rpm', desc: 'Сидит на верхнем конусе коленвала. Сглаживает вращение, несёт магниты генератора и зубчатый венец для датчика положения коленвала.',
    });
    const teeth: Geometry[] = [ring('+y', [0, 11.5, 0], 9.95, 9.45, 1.0, 72)];
    for (let k = 1; k < 36; k++) teeth.push(transform(bx(0.75, 0.9, 0.85, 10.25, 12.0, 0), M.rotY((-k * Math.PI) / 18)));
    part(flyRot, 'ringGear', 'Зубчатый венец 36−1', merge(...teeth), MAT.steel(), {
      net: 'PB5', value: 'rpm', desc: 'Тридцать пять зубьев и один пропуск. По зубьям блок считает угол коленвала с шагом 10°, а по пропуску узнаёт начало оборота.',
    });
    part(flyRot, 'pulley', 'Шкив ручного стартера',
      merge(lathe([[1.1, 15.25], [4.2, 15.25], [4.2, 15.55], [3.3, 15.85], [3.3, 16.25], [4.2, 16.55], [4.2, 16.85], [1.1, 16.85], [1.1, 15.25]], 40), at(hexPrism(2.0, 0.6), 0, 16.85, 0)),
      MAT.machinedAlu(), { ex: [0, 5, 0], desc: 'На него наматывается шнур для ручного запуска. Сверху — гайка крепления маховика.' });
    const coils: Geometry[] = [];
    for (let k = 0; k < 6; k++) coils.push(transform(cyl('+x', [4.5, 12.0, 0], 0.85, 2.1, 14), M.rotY((k * Math.PI) / 3)));
    const stator = part(eng, 'stator', 'Статор генератора', merge(ring('+y', [0, 10.8, 0], 7.6, 2.95, 0.3, 48), ring('+y', [0, 11.1, 0], 4.6, 3.2, 1.5, 36)), mat([0.4, 0.41, 0.43], 0.8, 0.5), {
      ex: [0, 6, 0], desc: 'Неподвижное основание под маховиком с катушками генератора. Заряжает аккумулятор, от которого питаются блок впрыска, насос и катушки.',
    });
    part(stator, 'statorCoils', '', merge(...coils), MAT.copper(), { pick: false });

    const hall = part(eng, 'hall', 'Датчик положения коленвала',
      merge(cyl('-x', [-10.75, 12, 0], 0.55, 2.6, 16), along(at(hexPrism(1.3, 0.3), 0, 0, 0), '-x', [-11.3, 12, 0]), along(at(hexPrism(1.3, 0.3), 0, 0, 0), '-x', [-12.15, 12, 0]), cyl('-x', [-13.35, 12, 0], 0.7, 1.1, 14)),
      BLACK_PLASTIC(), {
        ex: [-6, 7, 0], noClip: true, net: 'PB5', value: 'rpm',
        desc: 'Датчик Холла SS441A напротив венца 36−1. Каждый зуб даёт импульс на вход PB5; по ним блок вычисляет обороты, момент искры и начало впрыска. Зазор до зубьев — около 1 мм.',
      });
    part(hall, 'hallBracket', '', merge(bx(0.4, 3.4, 2.0, -11.8, 11.3, 0), bx(6.7, 0.35, 2.0, -8.65, 9.78, 0), bolt('+y', [-6.2, 9.95, 0], 0.6, 0.35), bolt('+y', [-4.6, 9.95, 0], 0.6, 0.35)), MAT.steel(), { pick: false, noClip: true });
  }

  // ====================== ВПУСК ======================
  const petals: Node3[] = [];
  {
    part(eng, 'plenum', 'Впускной коллектор', merge(bx(3.3, 15.2, 7.2, -9.15, 0, 0), ring('-x', [-10.8, 0, 0], 3.4, 2.2, 0.8, 36)), mat([0.46, 0.48, 0.5], 0.6, 0.6), {
      ex: [-8, 0, 0], hull: true, heat: 'iat', value: 'map',
      desc: 'Раздаёт топливовоздушную смесь от дроссельного узла на два лепестковых клапана — по одному на каждую кривошипную камеру.',
    });
    const pb: Geometry[] = [];
    for (const y of [-6.9, 6.9]) for (const z of [-3, 3]) pb.push(bolt('-x', [-10.8, y, z], 0.7));
    part(eng, 'plenumBolts', 'Гайки впускного коллектора', merge(...pb), MAT.steel(), { ex: [-11, 0, 0], desc: 'Крепят коллектор с клапанами к картеру.' });
    for (const i of [0, 1] as const) {
      const yc = CYL_Y[i], n = i + 1;
      const wedge = transform(prism([[-10.3, -1.2], [-10.3, 1.2], [-7.9, 0]], 4.8), M.chain(M.translation(0, yc, -2.4), M.rotX(H)));
      const reed = part(eng, 'reed' + n, 'Лепестковый клапан ' + n, merge(wedge, bx(0.3, 3.3, 5.6, -10.45, yc, 0)), mat([0.5, 0.52, 0.55], 0.6, 0.5), {
        ex: [-4, 0, 0], desc: `Обратный клапан кривошипной камеры ${n}. Когда поршень идёт вверх, разрежение под ним отгибает стальные лепестки и впускает смесь; при ходе вниз лепестки прижимаются и не выпускают её обратно.`,
      });
      for (const s of [1, -1]) {
        const p = part(reed, 'petal' + n + (s > 0 ? 'a' : 'b'), '', bx(2.5, 0.05, 4.4, 1.25, 0, 0), mat([0.75, 0.76, 0.78], 1, 0.2), { pick: false });
        p.data.hinge = [-10.3, yc + s * 1.3, 0];
        p.data.sign = s;
        p.data.cyl = i;
        petals.push(p);
      }
    }
  }
  const TB: Vec3 = [-17, 0, 0];
  const INJ_TIP: Vec3 = [-12.3, 1.6, 0], INJ_ANG = (25 * Math.PI) / 180;
  const injLocal = M.mul(M.translation(INJ_TIP[0], INJ_TIP[1], INJ_TIP[2]), M.rotZ(INJ_ANG));
  let throttleRot: Node3, pintle: Node3, injBody: Node3, sprayOuter: Node3, sprayInner: Node3, gThr: Node3, gSpray: Node3;
  {
    const bossM = M.mul(injLocal, M.translation(0, 0.9, 0));
    const body = merge(
      ring('-x', [-11.6, 0, 0], 2.9, 2.2, 5.0, 44), ring('-x', [-11.6, 0, 0], 3.5, 2.2, 0.5, 36),
      cyl('+z', [-14.2, 0, 2.6], 0.75, 0.75, 16), cyl('-z', [-14.2, 0, -2.6], 0.75, 0.75, 16),
      transform(at(tubeY(0.98, 0.62, 0.8, 18), 0, 0.4, 0), bossM),
      ring('-x', [-12.0, -3.3, 0], 0.8, 0.5, 4.2, 18), ring('-y', [-13.4, -3.3, 0], 1.05, 0.42, 1.1, 18),
      rod([-12.6, 2.14, 1.8], [-12.6, 2.72, 2.28], 0.22, 8),
    );
    part(eng, 'throttleBody', 'Дроссельный узел', body, MAT.machinedAlu(), {
      ex: TB, hull: true, heat: 'iat', value: 'tps',
      desc: 'Самодельный узел моновпрыска вместо карбюратора: заслонка, одна форсунка над ней, обводной канал с регулятором холостого хода и датчик положения заслонки на оси.',
    });
    gThr = group(eng, 'gThr', TB);
    throttleRot = group(gThr, 'throttleRot', undefined, M.translation(-14.2, 0, 0));
    part(throttleRot, 'throttle', 'Дроссельная заслонка', along(at(cylinder(2.14, 2.14, 0.12, 40), 0, 0, 0), '+x'), MAT.brass(), {
      noClip: true, value: 'tps', desc: 'Латунная заслонка на оси. Чем больше она открыта, тем больше воздуха идёт в мотор. Её положение (TPS) — главный показатель нагрузки в таблицах топлива и зажигания.',
    });
    part(throttleRot, 'throttleShaft', 'Ось и рычаг заслонки', merge(rod([0, 0, -4.5], [0, 0, 3.4], 0.28, 12), bx(0.3, 2.8, 0.25, 0, 0.9, -4.1), rod([0, 2.0, -4.6], [0, 2.0, -3.7], 0.18, 8)), MAT.steel(), {
      noClip: true, desc: 'К рычагу подходит трос газа от румпеля; пружина возвращает заслонку в закрытое положение.',
    });
    part(eng, 'tps', 'Датчик положения дросселя (TPS)', merge(cyl('+z', [-14.2, 0, 3.35], 1.3, 1.2, 24), bx(1.3, 1.0, 1.0, -14.2, -1.7, 3.95), bolt('+z', [-13.2, 1.0, 4.55], 0.4, 0.25), bolt('+z', [-15.2, -0.6, 4.55], 0.4, 0.25)),
      BLACK_PLASTIC(), { ex: [-17, 0, 6], net: 'PA0', value: 'tps', desc: 'Потенциометр на оси заслонки: +5 В, масса и сигнал, который растёт с открытием. После установки калибруется в закрытом и полностью открытом положении.' });

    // форсунка
    const gInj = group(eng, 'gInj', [-17, 9, 0], injLocal);
    injBody = part(gInj, 'injector', 'Форсунка',
      merge(cyl('+y', [0, 0, 0], 0.32, 0.7, 14), cyl('+y', [0, 0.7, 0], 0.6, 1.0, 18), cyl('+y', [0, 3.6, 0], 0.55, 1.0, 18), cyl('+y', [0, 1.6, 0], 0.85, 2.0, 20), bx(0.9, 1.1, 1.3, 0, 2.9, 1.2)),
      MAT.plastic([0.08, 0.2, 0.42]), { noClip: true, net: 'INJ', value: 'pw', desc: 'Одна форсунка Bosch 0 280 158 117 на оба цилиндра. Открывается дважды за оборот; длительность импульса (мс) задаёт таблица топлива с поправками на температуру и напряжение.' });
    part(injBody, 'injRings', '', merge(at(torus(0.56, 0.13, 18, 8), 0, 1.25, 0), at(torus(0.52, 0.13, 18, 8), 0, 4.2, 0)), MAT.rubber(), { pick: false, noClip: true });
    gSpray = group(gInj, 'gSpray');
    const cone = (r: number) => lathe([[0.04, 0], [r, -1]], 20);
    sprayOuter = part(gSpray, 'sprayOuter', '', cone(0.34), { color: [0.75, 0.9, 1], unlit: true, noClip: true, opacity: 0.28 }, { pick: false });
    sprayInner = part(gSpray, 'sprayInner', '', cone(0.15), { color: [0.95, 0.98, 1], unlit: true, noClip: true, opacity: 0.5 }, { pick: false });
    gSpray.visible = false;
    part(eng, 'fuelHose', 'Топливный шланг',
      merge(hose([[-14.25, 5.77, 0], [-14.75, 6.85, -0.1], [-14.9, 7.3, -1.4], [-14.3, 6.2, -3.6], [-12.8, 2.5, -4.7], [-11.6, -4, -4.8], [-11.0, -10.4, -4.7]], 0.4, 10), ring('+y', [-11.0, -10.4, -4.7], 0.62, 0.36, 0.5, 14)),
      MAT.rubber(), { ex: [-17, 9, -4], desc: 'Подаёт бензин с маслом от электронасоса под давлением около 3 бар.' });

    // РХХ
    const iac = part(eng, 'iac', 'Регулятор холостого хода', merge(cyl('-y', [-13.4, -4.4, 0], 1.25, 2.8, 24), bx(1.1, 1.2, 1.0, -14.9, -6.2, 0), cyl('-y', [-13.4, -7.2, 0], 0.7, 0.3, 16)), BLACK_PLASTIC(), {
      ex: [-17, -8, 0], noClip: true, net: 'IAC_OUT', value: 'iac',
      desc: 'Шаговый моторчик с конусным штоком в обводном (байпасном) канале мимо заслонки. Втягивая шток, блок добавляет воздух и удерживает обороты холостого хода; число шагов — положение штока.',
    });
    pintle = part(iac, 'pintle', 'Шток РХХ', merge(cyl('+y', [0, -1.6, 0], 0.16, 1.7, 10), lathe([[0, 0.1], [0.4, 0.1], [0.4, 0.3], [0.1, 0.9], [0, 0.9]], 16)), MAT.brass(), {
      noClip: true, net: 'IAC_OUT', value: 'iac', desc: 'Конус перекрывает седло обводного канала. Полностью выдвинут — канал закрыт.',
    });

    part(eng, 'bell', 'Воздухозаборник', along(lathe([[2.2, 0], [2.9, 0], [2.9, 0.5], [3.1, 1.2], [3.85, 1.95], [3.65, 2.1], [2.75, 1.35], [2.2, 0.6], [2.2, 0]], 44), '-x', [-16.6, 0, 0]), MAT.machinedAlu(), {
      ex: [-25, 0, 0], hull: true, heat: 'iat', desc: 'Раструб на входе дроссельного узла: выравнивает поток воздуха из-под капота мотора.',
    });
    const iatM = M.mul(M.translation(-15.8, 0, 0), M.rotX((50 * Math.PI) / 180));
    part(eng, 'iat', 'Датчик температуры воздуха (IAT)', transform(merge(cyl('+y', [0, 2.0, 0], 0.22, 0.9, 10), at(hexPrism(0.95, 0.5), 0, 2.9, 0), cyl('+y', [0, 3.4, 0], 0.4, 0.5, 12)), iatM), MAT.brass(), {
      ex: [-17, 4, 5], net: 'PA5', value: 'iat', desc: 'NTC-термистор 10 кОм в потоке воздуха перед заслонкой. Холодный воздух плотнее — блок добавляет топливо.',
    }).add(new Node3('iatConn', transform(cyl('+y', [0, 3.9, 0], 0.55, 1.0, 14), iatM), BLACK_PLASTIC()));

    part(eng, 'map', 'Датчик давления (MAP)', merge(bx(2.2, 1.0, 1.8, -9.2, 8.25, 2.4), cyl('-x', [-10.3, 8.25, 2.4], 0.2, 0.75, 10), bx(0.8, 0.7, 1.1, -7.9, 8.25, 2.4)), BLACK_PLASTIC(), {
      ex: [-8, 7, 2], net: 'PA1', value: 'map', desc: 'Датчик абсолютного давления MPX4115AP. Соединён шлангом с полостью за заслонкой; при включении зажигания запоминает атмосферное давление для поправки на высоту.',
    }).add(new Node3('mapBracket', merge(bx(2.8, 0.15, 2.4, -9.2, 7.675, 2.4), bolt('+y', [-8.1, 7.75, 3.35], 0.4, 0.25), bolt('+y', [-10.3, 7.75, 1.45], 0.4, 0.25)), MAT.steel()));
    part(eng, 'mapHose', 'Шланг датчика давления', hose([[-11.0, 8.25, 2.4], [-12.1, 8.2, 2.5], [-13.0, 6.9, 2.9], [-13.0, 4.6, 2.9], [-12.7, 3.3, 2.6], [-12.6, 2.72, 2.28]], 0.23, 8), MAT.rubber(), {
      ex: [-12, 7, 3], net: 'PA1', desc: 'Тонкий вакуумный шланг от штуцера за заслонкой к датчику MAP. Должен быть коротким и без трещин.',
    });
  }

  // ====================== ОСНОВАНИЕ ======================
  {
    const pbolt: Geometry[] = [];
    for (const [x, z] of [[-10.3, 6.8], [-10.3, -6.8], [0, 7.5], [0, -7.5], [11.5, 7.5], [11.5, -3.2], [21.8, 7.0], [21.8, -7.0]] as [number, number][]) pbolt.push(bolt('+y', [x, -10.4, z], 0.9, 0.45));
    part(eng, 'adapter', 'Проставка (фланец под дейдвуд)', at(extrude(roundedRect(35, 17, 2.2), 1.2), 5.75, -11.6, 0), mat([0.27, 0.29, 0.32], 0.6, 0.6), {
      ex: [0, -5, 0], desc: 'Нижний фланец силовой головки. Через него она крепится к дейдвуду; здесь проходят вертикальный вал, выхлоп и вода от помпы.',
    }).add(new Node3('adapterBolts', merge(...pbolt), MAT.steel()));
    part(eng, 'leg', 'Дейдвуд (показан условно)', at(extrude(roundedRect(19, 10.5, 3.2), 4.4), 6.5, -16.0, 0), MAT.plastic([0.05, 0.085, 0.14]), {
      ex: [0, -11, 0], desc: 'Промежуточный корпус мотора. Внутри — вертикальный вал к редуктору гребного винта, водяная помпа и канал выхлопа. В модели показано только место стыка.',
    });
  }

  // ---------- состояние анимации ----------
  let theta = 0.6, mode: ViewMode = 'solid', explode = 0, heat = false, iacMax = 180;
  let thrAng = 0, iacK = 0, heatT = 20, heatA = 20, flow = 0, sprayI = 0, sprayHold = 0;
  const cutAlt = [0, 0];
  let hasData = false;
  const sparkI = [0, 0], burn = [0, 0], reedOpen = [0, 0];
  const st = { theta, visHz: 0, factor: 1, running: false, sparks: 0, skipped: 0, spraying: false, nodes: 0, spark: sparkI, burn };
  all.forEach((n) => { if (n.geom) st.nodes++; });
  eng.traverse((n) => { if (n.geom && !all.includes(n)) st.nodes++; });
  const TAU = Math.PI * 2, wrap = (a: number) => ((a % TAU) + TAU) % TAU;

  const anchorDefs: { id: ValueKey; title: string; node: Node3; p: Vec3; n: Vec3 }[] = [
    { id: 'rpm', title: 'Обороты', node: gFly, p: [0, 17.6, 0], n: [0, 0, 0] },
    { id: 'adv', title: 'УОЗ', node: eng.find('plug1')!, p: [24.2, CYL_Y[0] + 1.2, 0], n: [1, 0, 0.2] },
    { id: 'cht', title: 'Головка (CHT)', node: eng.find('cht')!, p: [23.6, 0, -2.4], n: [1, 0, 0.4] },
    { id: 'o2', title: 'Лямбда', node: eng.find('lambda')!, p: [13.8, -7.6, -11.6], n: [0, 0, -1] },
    { id: 'pw', title: 'Впрыск', node: injBody!, p: [0, 5.2, 0], n: [0, 0, 0] },
    { id: 'tps', title: 'Дроссель (TPS)', node: eng.find('tps')!, p: [-14.2, 0, 4.8], n: [0, 0, 1] },
    { id: 'map', title: 'Давление (MAP)', node: eng.find('map')!, p: [-9.2, 9.0, 2.4], n: [-0.4, 0.3, 1] },
    { id: 'iat', title: 'Воздух (IAT)', node: eng.find('iat')!, p: [-15.8, 3.3, 3.9], n: [-0.3, 0.6, 0.7] },
    { id: 'iac', title: 'РХХ', node: eng.find('iac')!, p: [-13.4, -7.6, 0], n: [-0.5, -0.3, 1] },
  ];
  const anchors: Anchor[] = anchorDefs.map((a) => ({ id: a.id, title: a.title, pos: a.p, normal: a.n }));

  function applyExplode() {
    for (const n of exNodes) {
      const ex = n.data.ex as Vec3;
      n.local = M.mul(M.translation(ex[0] * explode, ex[1] * explode, ex[2] * explode), n.data.base as Mat4);
    }
  }
  function applyMode() {
    viewer.clip = mode === 'section' ? [0, 0, 1, 0] : null;
    for (const n of hullNodes) n.mat.opacity = mode === 'ghost' ? 0.18 : 1;
  }
  function applyHeat() {
    for (const n of heatNodes) {
      const m0 = n.data.mat0 as Material;
      if (!heat) { n.mat.color = m0.color; n.mat.metal = m0.metal; n.mat.rough = m0.rough; continue; }
      n.mat.color = hasData ? heatColor(n.data.heat === 'cht' ? heatT : heatA) : [0.33, 0.36, 0.4];
      n.mat.metal = 0.15; n.mat.rough = 0.6;
    }
  }

  function pose() {
    crankRot.local = M.rotY(theta);
    flyRot.local = M.rotY(theta);
    for (const i of [0, 1] as const) {
      const k = kinematics(theta, i);
      rods[i].local = M.mul(M.translation(k.pinX, CYL_Y[i], k.pinZ), M.rotY(k.rodAngle));
      pistons[i].local = M.translation(k.pistonX, CYL_Y[i], 0);
    }
    throttleRot.local = M.mul(M.translation(-14.2, 0, 0), M.rotZ(thrAng));
    pintle.local = M.translation(-13.4, -3.55 - 0.85 * iacK, 0);
    for (const p of petals) {
      const h = p.data.hinge as Vec3, s = p.data.sign as number, o = reedOpen[p.data.cyl as number];
      p.local = M.mul(M.translation(h[0], h[1], h[2]), M.rotZ(s * (-0.464 + o * 0.38)));
    }
  }

  function update(dt: number, t: Telemetry | null, live: boolean) {
    const has = !!(live && t);
    hasData = has;
    const rpm = has ? t!.rpm : 0, running = has && rpm > 0;
    const sd = slowdown(rpm);
    st.running = running; st.visHz = running ? sd.visHz : 0; st.factor = running ? sd.factor : 1;
    const prev = theta;
    if (running) theta = wrap(theta + TAU * sd.visHz * dt);
    st.theta = theta;

    // искра: поршень цилиндра за advance до ВМТ
    const adv = has ? (Math.max(0, t!.advance10) / 10) * (Math.PI / 180) : 0;
    const revCut = has && (t!.flags & (1 << 5)) !== 0, kill = has && t!.kill !== 0, fuelCut = has && t!.fuelCut !== 0;
    for (const i of [0, 1]) {
      sparkI[i] *= Math.exp(-dt / 0.1);
      burn[i] *= Math.exp(-dt / 0.2);
      if (running && theta !== prev) {
        const thr = TAU - adv, d0 = wrap(prev + i * Math.PI - thr), d1 = wrap(theta + i * Math.PI - thr);
        if (d1 < d0) { // прошли момент искры
          let fire = !kill;
          if (fire && revCut) { cutAlt[i] ^= 1; fire = cutAlt[i] === 0; } // мягкая отсечка: искра через раз
          if (fire) { sparkI[i] = 1; if (!fuelCut) burn[i] = 1; st.sparks++; } else st.skipped++;
        }
      }
      if (!running) { sparkI[i] = 0; burn[i] *= Math.exp(-dt / 0.05); }
      const si = sparkI[i], k = kinematics(theta, i as 0 | 1);
      sparkCore[i].visible = si > 0.04;
      sparkHalo[i].visible = si > 0.04;
      const base = M.translation(20.08, CYL_Y[i] + 0.12, 0);
      sparkCore[i].local = M.mul(base, M.scale(0.6 + si * 0.9));
      sparkHalo[i].local = M.mul(base, M.scale(0.4 + si * 0.8));
      sparkHalo[i].mat.opacity = 0.45 * si;
      plugCeramics[i].mat.emissive = [0.25 * si, 0.45 * si, 0.9 * si];
      domes[i].mat.emissive = [0.9 * burn[i], 0.38 * burn[i], 0.06 * burn[i]];
      const crown = k.pistonX + PIN_TO_CROWN - 0.15, top = 19.75, g = burnGlow[i];
      g.visible = burn[i] > 0.03 && explode < 0.02;
      g.local = M.trs([(crown + top) / 2, CYL_Y[i], 0], [0, 0, 0], [(top - crown) / 2 + 0.1, 3.3, 3.3]);
      g.mat.opacity = 0.62 * burn[i];
      g.mat.color = [1, 0.35 + 0.4 * burn[i], 0.08 + 0.3 * burn[i] * burn[i]];
      // лепестки: открыты, пока поршень идёт к ВМТ (разрежение в камере)
      const a = theta + i * Math.PI, vel = -Math.sin(a) * (1 + (CRANK_R * Math.cos(a)) / ROD_L);
      const target = running ? Math.max(0, vel) : 0;
      reedOpen[i] += (target - reedOpen[i]) * Math.min(1, dt * 18);
    }

    // впрыск: два раза за оборот, длительность — доля полуоборота, как в жизни
    const pw = has ? t!.pwUs : 0;
    const duty = Math.min(0.85, (pw * rpm) / 30e6);
    const phase = (theta % Math.PI) / Math.PI;
    const inWindow = running && !fuelCut && !kill && pw > 0 && phase < duty;
    if (inWindow) sprayHold = 0.09; else sprayHold = Math.max(0, sprayHold - dt);
    const on = running && !fuelCut && !kill && pw > 0 && (inWindow || sprayHold > 0);
    sprayI += ((on ? 1 : 0) - sprayI) * Math.min(1, dt * 30);
    st.spraying = sprayI > 0.1;
    const pk = Math.min(1, pw / 4000);
    gSpray.visible = sprayI > 0.05;
    gSpray.local = M.scale((1.9 + 1.9 * pk) * (0.55 + 0.45 * sprayI));
    sprayOuter.mat.opacity = (0.2 + 0.25 * pk) * sprayI;
    sprayInner.mat.opacity = (0.4 + 0.4 * pk) * sprayI;
    injBody.mat.emissive = [0.05 * sprayI, 0.35 * sprayI, 0.5 * sprayI];

    // заслонка, РХХ, температура, вода — плавно
    const ease = Math.min(1, dt * 10);
    const thrT = ((4 + 81 * (has ? Math.min(1000, Math.max(0, t!.tps10)) / 1000 : 0)) * Math.PI) / 180;
    thrAng += (thrT - thrAng) * ease;
    iacK += ((has ? Math.min(1, Math.max(0, t!.iacPos / iacMax)) : 0) - iacK) * ease;
    if (has) { heatT += (t!.cht10 / 10 - heatT) * Math.min(1, dt * 3); heatA += (t!.iat10 / 10 - heatA) * Math.min(1, dt * 3); }
    applyHeat();
    if (running) flow = (flow + dt * (0.12 + 0.3 * Math.sqrt(rpm / 6000))) % 1;
    for (const w of waterMarks) {
      w.node.visible = running;
      if (!running) continue;
      const s = ((flow * (14 / w.total) * 3 + w.off) % 1) * w.total;
      let k = 1;
      while (k < w.len.length - 1 && w.len[k] < s) k++;
      const f = (s - w.len[k - 1]) / Math.max(1e-6, w.len[k] - w.len[k - 1]), a = w.path[k - 1], b = w.path[k];
      w.node.local = M.translation(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
    }
    pose();
    for (let i = 0; i < anchorDefs.length; i++) anchors[i].pos = M.point(anchorDefs[i].node.world, anchorDefs[i].p);
  }

  let hov: Node3 | null = null, sel: Node3 | null = null;
  const scene: EngineScene = {
    root: eng,
    update,
    setMode(m) { mode = m; applyMode(); },
    setExplode(e) { explode = Math.min(1, Math.max(0, e)); applyExplode(); },
    setHeat(on) { heat = on; applyHeat(); },
    setIacMax(s) { if (s > 0) iacMax = s; },
    highlight(hover, selected) {
      if (hov) hov.highlight = 0;
      if (sel) sel.highlight = 0;
      hov = hover; sel = selected;
      if (hov) hov.highlight = 0.55;
      if (sel) sel.highlight = 1;
    },
    anchors,
    state: st,
  };
  pose();
  applyExplode();
  applyMode();
  return scene;
}
