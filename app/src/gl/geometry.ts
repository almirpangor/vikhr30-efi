// Генераторы геометрии. Все размеры в произвольных единицах сцены, ось Y вверх.
import { M, V, type Mat4, type Vec3 } from './math';

export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

class Builder {
  p: number[] = [];
  n: number[] = [];
  i: number[] = [];
  vert(p: Vec3, n: Vec3): number {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    return this.p.length / 3 - 1;
  }
  /** Плоский четырёхугольник (обход против часовой, если смотреть снаружи). */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
    const n = V.norm(V.cross(V.sub(b, a), V.sub(d, a)));
    const i0 = this.vert(a, n), i1 = this.vert(b, n), i2 = this.vert(c, n), i3 = this.vert(d, n);
    this.i.push(i0, i1, i2, i0, i2, i3);
  }
  tri(a: Vec3, b: Vec3, c: Vec3) {
    const n = V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
    this.i.push(this.vert(a, n), this.vert(b, n), this.vert(c, n));
  }
  done(): Geometry {
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), indices: new Uint32Array(this.i) };
  }
}

/** Параллелепипед с центром в начале координат. */
export function box(w: number, h: number, d: number): Geometry {
  const b = new Builder(), x = w / 2, y = h / 2, z = d / 2;
  b.quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]);
  b.quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]);
  b.quad([x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]);
  b.quad([-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]);
  b.quad([-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]);
  b.quad([-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]);
  return b.done();
}

/**
 * Тело вращения вокруг оси Y. profile — точки [радиус, высота] снизу вверх
 * (или в любом порядке вдоль образующей). Грани сглажены вдоль окружности,
 * вдоль образующей — плоские (чёткие кромки), что хорошо для точёных деталей.
 */
export function lathe(profile: [number, number][], segments = 32, arc = Math.PI * 2): Geometry {
  const b = new Builder();
  for (let k = 0; k + 1 < profile.length; k++) {
    const [r0, y0] = profile[k], [r1, y1] = profile[k + 1];
    if (r0 === r1 && y0 === y1) continue;
    // нормаль образующей в плоскости (r, y)
    let nr = y1 - y0, ny = -(r1 - r0);
    const l = Math.hypot(nr, ny) || 1;
    nr /= l; ny /= l;
    const base = b.p.length / 3;
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * arc, c = Math.cos(a), sn = Math.sin(a);
      b.vert([r0 * c, y0, r0 * sn], [nr * c, ny, nr * sn]);
      b.vert([r1 * c, y1, r1 * sn], [nr * c, ny, nr * sn]);
    }
    for (let s = 0; s < segments; s++) {
      const i0 = base + s * 2;
      b.i.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
    }
  }
  return b.done();
}

/** Цилиндр/конус вдоль оси Y с крышками, центр в начале координат. */
export function cylinder(rBottom: number, rTop: number, h: number, segments = 32): Geometry {
  return lathe([[0, -h / 2], [rBottom, -h / 2], [rTop, h / 2], [0, h / 2]], segments);
}

/** Полый цилиндр (гильза, втулка). */
export function tubeY(rOuter: number, rInner: number, h: number, segments = 32): Geometry {
  return lathe([[rInner, -h / 2], [rOuter, -h / 2], [rOuter, h / 2], [rInner, h / 2], [rInner, -h / 2]], segments);
}

export function sphere(r: number, segments = 24): Geometry {
  const b = new Builder(), rings = Math.max(6, segments / 2 | 0);
  for (let y = 0; y <= rings; y++)
    for (let x = 0; x <= segments; x++) {
      const t = (y / rings) * Math.PI, a = (x / segments) * Math.PI * 2;
      const n: Vec3 = [Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a)];
      b.vert(V.mul(n, r), n);
    }
  for (let y = 0; y < rings; y++)
    for (let x = 0; x < segments; x++) {
      const i0 = y * (segments + 1) + x, i1 = i0 + segments + 1;
      b.i.push(i0, i0 + 1, i1 + 1, i0, i1 + 1, i1);
    }
  return b.done();
}

export function torus(R: number, r: number, segments = 32, sides = 12): Geometry {
  const b = new Builder();
  for (let i = 0; i <= segments; i++)
    for (let j = 0; j <= sides; j++) {
      const a = (i / segments) * Math.PI * 2, t = (j / sides) * Math.PI * 2;
      const n: Vec3 = [Math.cos(t) * Math.cos(a), Math.sin(t), Math.cos(t) * Math.sin(a)];
      b.vert([(R + r * Math.cos(t)) * Math.cos(a), r * Math.sin(t), (R + r * Math.cos(t)) * Math.sin(a)], n);
    }
  for (let i = 0; i < segments; i++)
    for (let j = 0; j < sides; j++) {
      const i0 = i * (sides + 1) + j, i1 = i0 + sides + 1;
      b.i.push(i0, i1, i1 + 1, i0, i1 + 1, i0 + 1);
    }
  return b.done();
}

/** Сглаженная кривая Катмулла — Рома через заданные точки. */
export function smoothPath(points: Vec3[], perSegment = 8): Vec3[] {
  if (points.length < 3) return points.slice();
  const out: Vec3[] = [];
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment, t2 = t * t, t3 = t2 * t;
      const c = (k: 0 | 1 | 2) =>
        0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push([c(0), c(1), c(2)]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Труба (провод, шланг) вдоль ломаной. */
export function tube(path: Vec3[], radius: number, sides = 10, caps = true): Geometry {
  const b = new Builder(), n = path.length;
  if (n < 2) return b.done();
  let up: Vec3 = [0, 1, 0];
  const rings: number[] = [];
  let prevSide: Vec3 | null = null;
  for (let i = 0; i < n; i++) {
    const t = V.norm(V.sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
    let side: Vec3;
    if (prevSide) {
      // переносим предыдущий базис, чтобы труба не перекручивалась
      side = V.norm(V.sub(prevSide, V.mul(t, V.dot(prevSide, t))));
    } else {
      if (Math.abs(V.dot(t, up)) > 0.95) up = [1, 0, 0];
      side = V.norm(V.cross(t, up));
    }
    prevSide = side;
    const bin = V.cross(t, side);
    rings.push(b.p.length / 3);
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const nn = V.add(V.mul(side, Math.cos(a)), V.mul(bin, Math.sin(a)));
      b.vert(V.add(path[i], V.mul(nn, radius)), nn);
    }
  }
  for (let i = 0; i + 1 < n; i++)
    for (let s = 0; s < sides; s++) {
      const i0 = rings[i] + s, i1 = rings[i + 1] + s;
      b.i.push(i0, i0 + 1, i1 + 1, i0, i1 + 1, i1);
    }
  if (caps) {
    for (const end of [0, n - 1]) {
      const dir = V.norm(V.sub(path[end === 0 ? 0 : n - 1], path[end === 0 ? 1 : n - 2]));
      const c = b.vert(path[end], dir), ring: number[] = [];
      for (let s = 0; s <= sides; s++) {
        const k = rings[end] + s;
        ring.push(b.vert([b.p[k * 3], b.p[k * 3 + 1], b.p[k * 3 + 2]], dir));
      }
      for (let s = 0; s < sides; s++) end === 0 ? b.i.push(c, ring[s], ring[s + 1]) : b.i.push(c, ring[s + 1], ring[s]);
    }
  }
  return b.done();
}

/**
 * Выдавливание плоского ВЫПУКЛОГО контура (точки [x, z]) на высоту h вдоль Y; основание на y = 0.
 * Направление обхода контура может быть любым: нормали всегда получаются наружу.
 * (Раньше roundedRect() и hexPrism() давали обход, при котором нормали смотрели внутрь; при обычном
 * освещении шейдер это скрывал, а в разрезе такие детали целиком красились как «срез».)
 */
export function extrude(outline: [number, number][], h: number): Geometry {
  const b = new Builder(), n = outline.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const [x0, z0] = outline[i], [x1, z1] = outline[(i + 1) % n]; area += x0 * z1 - x1 * z0; }
  if ((area < 0) !== (h < 0)) outline = outline.slice().reverse();
  for (let i = 0; i < n; i++) {
    const [x0, z0] = outline[i], [x1, z1] = outline[(i + 1) % n];
    b.quad([x0, 0, z0], [x0, h, z0], [x1, h, z1], [x1, 0, z1]);
  }
  for (let i = 1; i + 1 < n; i++) {
    b.tri([outline[0][0], h, outline[0][1]], [outline[i + 1][0], h, outline[i + 1][1]], [outline[i][0], h, outline[i][1]]);
    b.tri([outline[0][0], 0, outline[0][1]], [outline[i][0], 0, outline[i][1]], [outline[i + 1][0], 0, outline[i + 1][1]]);
  }
  return b.done();
}

/** Прямоугольник со скруглёнными углами как выпуклый контур для extrude(). */
export function roundedRect(w: number, d: number, r: number, cornerSeg = 5): [number, number][] {
  const pts: [number, number][] = [], x = w / 2 - r, z = d / 2 - r;
  const corners: [number, number, number][] = [[x, -z, -Math.PI / 2], [x, z, 0], [-x, z, Math.PI / 2], [-x, -z, Math.PI]];
  for (const [cx, cz, a0] of corners)
    for (let s = 0; s <= cornerSeg; s++) {
      const a = a0 + (s / cornerSeg) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  return pts.reverse();
}

/** Применить матрицу к геометрии (возвращает новую). */
export function transform(g: Geometry, m: Mat4): Geometry {
  const p = new Float32Array(g.positions.length), nn = new Float32Array(g.normals.length);
  const nm = M.invert(m); // для нормалей нужна транспонированная обратная
  for (let i = 0; i < p.length; i += 3) {
    const q = M.point(m, [g.positions[i], g.positions[i + 1], g.positions[i + 2]]);
    p[i] = q[0]; p[i + 1] = q[1]; p[i + 2] = q[2];
    const x = g.normals[i], y = g.normals[i + 1], z = g.normals[i + 2];
    const t = V.norm([nm[0] * x + nm[1] * y + nm[2] * z, nm[4] * x + nm[5] * y + nm[6] * z, nm[8] * x + nm[9] * y + nm[10] * z]);
    nn[i] = t[0]; nn[i + 1] = t[1]; nn[i + 2] = t[2];
  }
  return { positions: p, normals: nn, indices: g.indices.slice() };
}

/** Склеить несколько геометрий в одну (один вызов отрисовки). */
export function merge(...gs: Geometry[]): Geometry {
  let vp = 0, vi = 0;
  for (const g of gs) { vp += g.positions.length; vi += g.indices.length; }
  const p = new Float32Array(vp), n = new Float32Array(vp), idx = new Uint32Array(vi);
  let op = 0, oi = 0;
  for (const g of gs) {
    p.set(g.positions, op); n.set(g.normals, op);
    const base = op / 3;
    for (let k = 0; k < g.indices.length; k++) idx[oi + k] = g.indices[k] + base;
    op += g.positions.length; oi += g.indices.length;
  }
  return { positions: p, normals: n, indices: idx };
}

/** Удобная форма: геометрия, сдвинутая/повёрнутая на месте. */
export function placed(g: Geometry, pos: Vec3, rot: Vec3 = [0, 0, 0], scale: Vec3 | number = 1): Geometry {
  return transform(g, M.trs(pos, rot, scale));
}

/** Шестигранник (головка болта/гайка) высотой h, размер «под ключ» s. */
export function hexPrism(s: number, h: number): Geometry {
  const r = s / Math.sqrt(3), pts: [number, number][] = [];
  for (let i = 5; i >= 0; i--) pts.push([Math.cos((i * Math.PI) / 3) * r, Math.sin((i * Math.PI) / 3) * r]);
  return extrude(pts, h);
}
