# -*- coding: utf-8 -*-
"""Геометрия меди: каждая фигура — выпуклый многоугольник (1 точка, отрезок или ≥3 точек), «раздутый» на радиус r.
круг = точка + r; дорожка/овал = отрезок + r; прямоугольник = 4 точки, r = 0."""
import math
import numpy as np

class Shape:
    __slots__ = ('layer', 'net', 'pts', 'r', 'kind', 'ref', 'bb')
    def __init__(self, layer, net, pts, r, kind='', ref=''):
        self.layer, self.net, self.pts, self.r, self.kind, self.ref = layer, net, [(float(x), float(y)) for x, y in pts], float(r), kind, ref
        xs = [p[0] for p in self.pts]; ys = [p[1] for p in self.pts]
        self.bb = (min(xs) - r, min(ys) - r, max(xs) + r, max(ys) + r)

def circle(layer, net, x, y, d, kind='', ref=''): return Shape(layer, net, [(x, y)], d / 2, kind, ref)
def seg(layer, net, x1, y1, x2, y2, w, kind='', ref=''):
    if abs(x1 - x2) < 1e-9 and abs(y1 - y2) < 1e-9: return Shape(layer, net, [(x1, y1)], w / 2, kind, ref)
    return Shape(layer, net, [(x1, y1), (x2, y2)], w / 2, kind, ref)
def rect(layer, net, cx, cy, w, h, kind='', ref=''):
    return Shape(layer, net, [(cx - w / 2, cy - h / 2), (cx + w / 2, cy - h / 2), (cx + w / 2, cy + h / 2), (cx - w / 2, cy + h / 2)], 0.0, kind, ref)

def _seg_dist_grid(X, Y, a, b):
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = np.clip(((X - ax) * dx + (Y - ay) * dy) / L2, 0.0, 1.0)
    return np.hypot(X - (ax + t * dx), Y - (ay + t * dy))

def dist_grid(s, X, Y):
    """Расстояние от точек (X, Y) до границы фигуры; внутри ≤ 0."""
    n = len(s.pts)
    if n == 1: return np.hypot(X - s.pts[0][0], Y - s.pts[0][1]) - s.r
    if n == 2: return _seg_dist_grid(X, Y, s.pts[0], s.pts[1]) - s.r
    d = None; inside = None
    # ориентация
    area = sum(s.pts[i][0] * s.pts[(i + 1) % n][1] - s.pts[(i + 1) % n][0] * s.pts[i][1] for i in range(n))
    sg = 1.0 if area > 0 else -1.0
    for i in range(n):
        a, b = s.pts[i], s.pts[(i + 1) % n]
        di = _seg_dist_grid(X, Y, a, b)
        d = di if d is None else np.minimum(d, di)
        cr = ((b[0] - a[0]) * (Y - a[1]) - (b[1] - a[1]) * (X - a[0])) * sg
        ins = cr >= 0
        inside = ins if inside is None else (inside & ins)
    return np.where(inside, -d, d) - s.r

def mark(mask, s, grow, x0, y0, step, val=True):
    """Отметить в растре mask ячейки, центры которых ближе grow к фигуре. Центр ячейки (i,j) = x0 + j*step, y0 + i*step."""
    g = grow
    j0 = max(0, int(math.floor((s.bb[0] - g - x0) / step))); j1 = min(mask.shape[1] - 1, int(math.ceil((s.bb[2] + g - x0) / step)))
    i0 = max(0, int(math.floor((s.bb[1] - g - y0) / step))); i1 = min(mask.shape[0] - 1, int(math.ceil((s.bb[3] + g - y0) / step)))
    if j1 < j0 or i1 < i0: return None
    xs = x0 + np.arange(j0, j1 + 1) * step; ys = y0 + np.arange(i0, i1 + 1) * step
    X, Y = np.meshgrid(xs, ys)
    m = dist_grid(s, X, Y) <= g
    if val is True: mask[i0:i1 + 1, j0:j1 + 1] |= m
    else: mask[i0:i1 + 1, j0:j1 + 1][m] = val
    return (i0, i1, j0, j1, m)

# ── точные расстояния между фигурами (для проверки правил)
def _pt_seg(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    if L2 == 0: return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)

def _seg_seg(a, b, c, d):
    def orient(p, q, r): return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    if (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0) and o1 * o2 != 0 and o3 * o4 != 0: return 0.0
    return min(_pt_seg(a, c, d), _pt_seg(b, c, d), _pt_seg(c, a, b), _pt_seg(d, a, b))

def _inside(p, poly):
    n = len(poly)
    if n < 3: return False
    sgn = 0
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        if abs(cr) < 1e-12: continue
        s = 1 if cr > 0 else -1
        if sgn == 0: sgn = s
        elif s != sgn: return False
    return True

def _edges(pts):
    n = len(pts)
    if n == 1: return [(pts[0], pts[0])]
    if n == 2: return [(pts[0], pts[1])]
    return [(pts[i], pts[(i + 1) % n]) for i in range(n)]

def core_dist(p1, p2):
    if _inside(p1[0], p2) or _inside(p2[0], p1): return 0.0
    best = 1e9
    for a, b in _edges(p1):
        for c, d in _edges(p2):
            v = _seg_seg(a, b, c, d) if (a != b and c != d) else (_pt_seg(a, c, d) if a == b else _pt_seg(c, a, b))
            if v < best: best = v
            if best == 0.0: return 0.0
    return best

def shape_dist(s1, s2):
    """Зазор между двумя фигурами (≤ 0 — касаются/перекрываются)."""
    if s1.bb[0] - s2.bb[2] > 50 or s2.bb[0] - s1.bb[2] > 50: return 1e9
    return core_dist(s1.pts, s2.pts) - s1.r - s2.r

def bb_gap(s1, s2):
    dx = max(s1.bb[0] - s2.bb[2], s2.bb[0] - s1.bb[2], 0.0); dy = max(s1.bb[1] - s2.bb[3], s2.bb[1] - s1.bb[3], 0.0)
    return math.hypot(dx, dy)
