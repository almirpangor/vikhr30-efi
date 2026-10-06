// 3D-вид калибровочной карты: столбик на каждую ячейку, цвет — по значению (та же шкала, что в таблице).
import { Node3, type Viewer } from '../gl/viewer';
import { box, merge, placed, sphere, type Geometry } from '../gl/geometry';
import { M, type Vec3 } from '../gl/math';
import { getState } from '../core/store';
import { bracket, lookupMap } from '../core/calc';
import { LOAD_BINS, LOAD_COUNT, RPM_BINS, RPM_COUNT, type MapTable } from '../core/types';

// ---- цветовая шкала «холодный → тёплый» (общая для таблицы и 3D) ----
const HEAT_STOPS: [number, number, number][] = [
  [34, 64, 143], [30, 127, 181], [31, 168, 144], [134, 185, 74], [232, 193, 60], [234, 138, 54], [210, 69, 63],
];
/** Цвет шкалы для t = 0…1, компоненты 0…255. */
export function heatColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x)), f = x - i, a = HEAT_STOPS[i], b = HEAT_STOPS[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}
export const HEAT_CSS = 'linear-gradient(90deg, ' + HEAT_STOPS.map((c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`).join(', ') + ')';
/** Цвет текста, читаемый на заливке шкалы. */
export function heatInk(rgb: [number, number, number]): string {
  const l = (v: number) => Math.pow(v / 255, 2.2);
  return 0.2126 * l(rgb[0]) + 0.7152 * l(rgb[1]) + 0.0722 * l(rgb[2]) > 0.26 ? '#0a0f15' : '#ffffff';
}
export function mapRange(map: MapTable): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const row of map) for (const v of row) { if (v < min) min = v; if (v > max) max = v; }
  return { min, max };
}
/** Положение значения на шкале 0…1 (ровная карта — середина шкалы). */
export const heatT = (v: number, min: number, max: number) => (max > min ? (v - min) / (max - min) : 0.5);

export interface SurfaceRect { r0: number; r1: number; c0: number; c1: number }
export interface SurfaceOptions {
  /** Какую карту показывать. */
  kind: 'fuel' | 'ign';
  /** Число для подписей (в отображаемых единицах). */
  format: (v: number) => string;
  unit: string;
  /** Текущее выделение в таблице. */
  getSelection: () => SurfaceRect;
  /** Щелчок по столбику. extend — с Shift (расширить диапазон). */
  onPick: (row: number, col: number, extend: boolean) => void;
}
export interface SurfaceHandle { resetView(): void; dispose(): void }

const PX = 0.5, PZ = 0.5, H = 2.3, BASE = 0.14;
const X0 = -((RPM_COUNT - 1) / 2) * PX, Z0 = ((LOAD_COUNT - 1) / 2) * PZ; // строка 0 (TPS 0 %) — ближе к зрителю
const cellX = (c: number) => X0 + c * PX, cellZ = (r: number) => Z0 - r * PZ;
const HOME = { yaw: -0.62, pitch: 0.5, target: [0.1, 0.85, 0] as Vec3 };

export function setupSurface(viewer: Viewer, host: HTMLElement, opts: SurfaceOptions): SurfaceHandle {
  const root = viewer.root;
  viewer.cam.yaw = HOME.yaw; viewer.cam.pitch = HOME.pitch; viewer.cam.target = [...HOME.target] as Vec3;
  viewer.cam.minDist = 3; viewer.cam.maxDist = 40;

  // основание и «стенки» с линиями уровней
  const W = RPM_COUNT * PX, D = LOAD_COUNT * PZ, xl = cellX(RPM_COUNT - 1) + PX / 2 + 0.06, zb = cellZ(LOAD_COUNT - 1) - PZ / 2 - 0.06;
  root.add(new Node3('base', placed(box(W + 0.3, 0.06, D + 0.3), [0, -0.03, 0]), { color: [0.05, 0.07, 0.1], rough: 0.8 }));
  const lines: Geometry[] = [];
  const T = 0.014;
  for (let k = 0; k <= 4; k++) {
    const y = BASE + (k / 4) * H;
    lines.push(placed(box(W + 0.12, T, T), [0, y, zb]), placed(box(T, T, D + 0.12), [xl, y, 0]));
  }
  for (let c = 0; c <= RPM_COUNT; c += 1) lines.push(placed(box(T, BASE + H, T), [X0 - PX / 2 + c * PX, (BASE + H) / 2, zb]));
  for (let r = 0; r <= LOAD_COUNT; r += 1) lines.push(placed(box(T, BASE + H, T), [xl, (BASE + H) / 2, Z0 + PZ / 2 - r * PZ]));
  root.add(new Node3('grid', merge(...lines), { color: [0.2, 0.28, 0.36], unlit: true }));

  // столбики
  const unit = box(1, 1, 1);
  const cols: Node3[][] = [];
  for (let r = 0; r < LOAD_COUNT; r++) {
    cols.push([]);
    for (let c = 0; c < RPM_COUNT; c++) {
      const n = new Node3(`cell-${r}-${c}`, unit, { color: [0.5, 0.5, 0.5], rough: 0.5, metal: 0 });
      n.pickable = true;
      n.data = { row: r, col: c };
      root.add(n);
      cols[r].push(n);
    }
  }
  // рабочая точка
  const ball = root.add(new Node3('work-ball', sphere(0.1, 20), { color: [1, 1, 1], emissive: [0.2, 0.2, 0.2], unlit: true }));
  const pin = root.add(new Node3('work-pin', unit, { color: [1, 1, 1], unlit: true }));
  ball.visible = pin.visible = false;

  // подписи осей (HTML поверх сцены)
  const layer = document.createElement('div');
  layer.className = 'maps-l3d-layer';
  host.appendChild(layer);
  const mk = (cls: string, text: string) => { const e = document.createElement('div'); e.className = cls; e.textContent = text; layer.appendChild(e); return e; };
  const place = (e: HTMLElement, p: Vec3) => {
    const s = viewer.project(p);
    e.style.display = s.visible ? '' : 'none';
    e.style.left = s.x.toFixed(1) + 'px'; e.style.top = s.y.toFixed(1) + 'px';
  };
  const zf = Z0 + PZ / 2 + 0.3, xr = X0 - PX / 2 - 0.3;
  const fixed: { el: HTMLElement; p: Vec3 }[] = [];
  for (let c = 0; c < RPM_COUNT; c += 2) fixed.push({ el: mk('maps-l3d', String(RPM_BINS[c])), p: [cellX(c), 0, zf] });
  for (let r = 0; r < LOAD_COUNT; r++) fixed.push({ el: mk('maps-l3d', String(LOAD_BINS[r] / 10)), p: [xr, 0, cellZ(r)] });
  fixed.push({ el: mk('maps-l3d title', 'обороты, об/мин'), p: [0, 0, zf + 0.85] });
  fixed.push({ el: mk('maps-l3d title', 'TPS, %'), p: [xr - 0.85, 0, 0] });
  const levels = [0, 0.5, 1].map((t) => ({ t, el: mk('maps-l3d lvl', '') }));
  const wpLabel = mk('label3d maps-l3d-wp', '');
  const hoverLabel = mk('label3d', '');
  wpLabel.style.display = hoverLabel.style.display = 'none';

  let lastMap: MapTable | null = null, range = { min: 0, max: 1 }, selKey = '';
  let hover: { row: number; col: number } | null = null;
  const heightOf = (v: number) => BASE + heatT(v, range.min, range.max) * H;
  const lin = (v: number) => Math.pow(v / 255, 2.2);

  function rebuild(map: MapTable) {
    lastMap = map;
    range = mapRange(map);
    for (let r = 0; r < LOAD_COUNT; r++) for (let c = 0; c < RPM_COUNT; c++) {
      const v = map[r][c], h = heightOf(v), rgb = heatColor(heatT(v, range.min, range.max)), n = cols[r][c];
      n.local = M.trs([cellX(c), h / 2, cellZ(r)], [0, 0, 0], [PX * 0.9, h, PZ * 0.9]);
      n.mat.color = [lin(rgb[0]), lin(rgb[1]), lin(rgb[2])];
      n.label = `${RPM_BINS[c]} об/мин · TPS ${LOAD_BINS[r] / 10} % · ${opts.format(v)}${opts.unit}`;
    }
    for (const l of levels) l.el.textContent = `${opts.format(range.min + (range.max - range.min) * l.t)}${opts.unit}`;
  }

  // камера: пока пользователь её не трогал — вписываем сцену в окно
  let untouched = true, lastAspect = 0;
  const fitDist = () => {
    const a = viewer.canvas.clientWidth / Math.max(1, viewer.canvas.clientHeight), fy = viewer.cam.fov;
    const fx = 2 * Math.atan(Math.tan(fy / 2) * a);
    return Math.min(viewer.cam.maxDist, (3.75 / Math.sin(Math.min(fx, fy) / 2)) * 1.02);
  };
  const touch = () => { untouched = false; };
  viewer.canvas.addEventListener('pointerdown', touch);
  viewer.canvas.addEventListener('wheel', touch, { passive: true });
  const leave = () => { hover = null; };
  viewer.canvas.addEventListener('pointerleave', leave);

  viewer.onPick = (hit, ev) => {
    if (hit && typeof hit.data.row === 'number') opts.onPick(hit.data.row as number, hit.data.col as number, ev.shiftKey);
  };
  viewer.onHover = (hit) => {
    hover = hit && typeof hit.data.row === 'number' ? { row: hit.data.row as number, col: hit.data.col as number } : null;
  };

  const wp = { x: 0, y: 0, z: 0, on: false };
  viewer.onFrame = (dt) => {
    const s = getState(), map = s[opts.kind];
    if (map !== lastMap) rebuild(map);
    const sel = opts.getSelection(), key = `${sel.r0},${sel.r1},${sel.c0},${sel.c1}`;
    if (key !== selKey) {
      selKey = key;
      for (let r = 0; r < LOAD_COUNT; r++) for (let c = 0; c < RPM_COUNT; c++)
        cols[r][c].highlight = r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1 ? 1 : 0;
    }
    const a = viewer.canvas.clientWidth / Math.max(1, viewer.canvas.clientHeight);
    if (untouched && Math.abs(a - lastAspect) > 0.01) { lastAspect = a; viewer.cam.dist = fitDist(); }

    // рабочая точка: только при живой связи и вращающемся двигателе
    const t = s.telemetry;
    if (s.live && t && t.rpm > 0) {
      const bx = bracket(t.rpm, RPM_BINS), by = bracket(t.tps10, LOAD_BINS);
      const tx = cellX(bx.lo + (bx.hi - bx.lo) * bx.fraction / 1000), tz = cellZ(by.lo + (by.hi - by.lo) * by.fraction / 1000);
      const val = lookupMap(map, t.rpm, t.tps10), ty = heightOf(val);
      const k = wp.on ? Math.min(1, dt * 12) : 1;
      wp.x += (tx - wp.x) * k; wp.y += (ty - wp.y) * k; wp.z += (tz - wp.z) * k; wp.on = true;
      const top = BASE + H + 0.45;
      ball.local = M.translation(wp.x, wp.y + 0.1, wp.z);
      pin.local = M.trs([wp.x, (wp.y + top) / 2, wp.z], [0, 0, 0], [0.022, Math.max(0.01, top - wp.y), 0.022]);
      ball.visible = pin.visible = true;
      wpLabel.textContent = `${opts.format(val)}${opts.unit}`;
      place(wpLabel, [wp.x, top, wp.z]);
    } else {
      wp.on = false;
      ball.visible = pin.visible = false;
      wpLabel.style.display = 'none';
    }

    for (const f of fixed) place(f.el, f.p);
    for (const l of levels) place(l.el, [xl, BASE + l.t * H, Z0 + PZ / 2 + 0.15]);
    if (hover && lastMap) {
      const n = cols[hover.row][hover.col];
      hoverLabel.textContent = n.label;
      place(hoverLabel, [cellX(hover.col), heightOf(lastMap[hover.row][hover.col]) + 0.05, cellZ(hover.row)]);
    } else hoverLabel.style.display = 'none';
  };

  return {
    resetView() {
      untouched = true;
      viewer.flyTo({ yaw: HOME.yaw, pitch: HOME.pitch, target: [...HOME.target] as Vec3, dist: fitDist() }, 0.5);
    },
    dispose() {
      viewer.onFrame = viewer.onPick = viewer.onHover = null;
      viewer.canvas.removeEventListener('pointerdown', touch);
      viewer.canvas.removeEventListener('wheel', touch);
      viewer.canvas.removeEventListener('pointerleave', leave);
      layer.remove();
    },
  };
}
