# -*- coding: utf-8 -*-
"""Заливка GND настоящим полигоном: растр 0,05 мм → вырезы по зазорам, термобарьеры, удаление узких перемычек и островков →
контуры с отверстиями → один замкнутый контур с вертикальными разрезами (cut-in), пригодный для G36/G37 и KiCad filled_polygon."""
import math
import numpy as np
import board as B, geom as G

P = 0.05
NXP = int(round(B.W / P)); NYP = int(round(B.H / P))
POUR_CLR = 0.45
POUR_CLR_HV = 2.65
TH_GAP, TH_SPOKE = 0.40, 0.60          # термобарьер выводных площадок
TH_GAP_SMD, TH_SPOKE_SMD = 0.30, 0.40
OPEN_R = 3                             # 0,15 мм: убрать перемычки уже 0,3 мм
KEEPOUT = [(0.0, 7.5, 8.5, 26.5)]      # без заливки у гнезда HC-06 (антенна модуля) — оба слоя

def _disk(r):
    return [(dy, dx) for dy in range(-r, r + 1) for dx in range(-r, r + 1) if dy * dy + dx * dx <= r * r + 1]

def _shift_and(m, offs, op_and=True):
    r = max(max(abs(a), abs(b)) for a, b in offs)
    pad = np.pad(m, r, constant_values=not op_and and False)
    out = np.ones_like(m) if op_and else np.zeros_like(m)
    ny, nx = m.shape
    for dy, dx in offs:
        v = pad[r + dy:r + dy + ny, r + dx:r + dx + nx]
        if op_and: out &= v
        else: out |= v
    return out

def raster(b, layer, shapes):
    """Растр заливки слоя до удаления островков."""
    xs = (np.arange(NXP) + 0.5) * P; ys = (np.arange(NYP) + 0.5) * P
    X, Y = np.meshgrid(xs, ys)
    forb = np.minimum(np.minimum(X, b.W - X), np.minimum(Y, b.H - Y)) < B.EDGE + 0.05
    x0, y0 = P / 2, P / 2
    for (x, y, d) in b.npth:
        zone = (B.MOUNT_ZONE / 2 + 0.2) if d >= 3.0 else d / 2 + 0.5
        G.mark(forb, G.Shape(layer, None, [(x, y)], zone), 0.0, x0, y0, P)
    for (kx0, ky0, kx1, ky1) in KEEPOUT:
        forb[int(ky0 / P):int(ky1 / P), int(kx0 / P):int(kx1 / P)] = True
    for s in shapes:
        if s.layer != layer or s.net == 'GND': continue
        G.mark(forb, s, (POUR_CLR_HV if s.net in B.HV_NETS else POUR_CLR) + P / 2, x0, y0, P)
    # отверстия чужих и неподключённых площадок на другом слое учтены их площадками; термобарьеры своих площадок:
    for c in b.comps:
        for p in c['pads']:
            if p['net'] != 'GND' or p['layers'] == 'T0': continue
            if p['layers'] == 'T' and layer != 'T': continue
            if (p['ref'], p['name']) in b.solid or p['ref'] in ('U3', 'Q1', 'Q2'): continue
            gap, sw = (TH_GAP, TH_SPOKE) if p['drill'] else (TH_GAP_SMD, TH_SPOKE_SMD)
            s = [q for q in B.shapes_of_pad(p) if q.layer == layer][0]
            j0 = max(0, int((s.bb[0] - gap) / P) - 1); j1 = min(NXP - 1, int((s.bb[2] + gap) / P) + 1)
            i0 = max(0, int((s.bb[1] - gap) / P) - 1); i1 = min(NYP - 1, int((s.bb[3] + gap) / P) + 1)
            Xw, Yw = X[i0:i1 + 1, j0:j1 + 1], Y[i0:i1 + 1, j0:j1 + 1]
            d = G.dist_grid(s, Xw, Yw)
            ann = (d > 0) & (d <= gap)
            spoke = (np.abs(Xw - p['x']) <= sw / 2) | (np.abs(Yw - p['y']) <= sw / 2)
            forb[i0:i1 + 1, j0:j1 + 1] |= ann & ~spoke
    m = ~forb
    disk = _disk(OPEN_R)
    er = _shift_and(m, disk, True)
    return _shift_and(er, disk, False) & m

def label(m):
    """Связные области (4-связность) по сериям. Возвращает (labels int32 с 0 = пусто, число областей)."""
    d = np.diff(np.pad(m, ((0, 0), (1, 1))).astype(np.int8), axis=1)
    sr, sc = np.nonzero(d == 1); er, ec = np.nonzero(d == -1)
    n = len(sr)
    par = list(range(n))
    def find(a):
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    row_start = np.searchsorted(sr, np.arange(m.shape[0] + 1))
    scl, ecl = sc.tolist(), ec.tolist()
    for r in range(1, m.shape[0]):
        a, a1 = int(row_start[r]), int(row_start[r + 1]); bq, b1 = int(row_start[r - 1]), int(row_start[r])
        while a < a1 and bq < b1:
            if scl[a] < ecl[bq] and scl[bq] < ecl[a]:
                ra, rb = find(a), find(bq)
                if ra != rb: par[ra] = rb
            if ecl[a] < ecl[bq]: a += 1
            else: bq += 1
    roots = {}
    lab = np.zeros(m.shape, np.int32)
    srl = sr.tolist()
    for i in range(n):
        r = find(i)
        k = roots.setdefault(r, len(roots) + 1)
        lab[srl[i], scl[i]:ecl[i]] = k
    return lab, len(roots)

# ── векторизация
def _loops(m):
    ny, nx = m.shape
    mp = np.pad(m, 1).astype(np.int8)
    segs = {}   # start -> list of (end, dir)
    def add(a, b, d): segs.setdefault(a, []).append((b, d))
    sh = mp[1:, 1:-1] - mp[:-1, 1:-1]          # (ny+1, nx): граница на решётке y=k
    for sign in (1, -1):
        d = np.diff(np.pad((sh == sign), ((0, 0), (1, 1))).astype(np.int8), axis=1)
        r0, c0 = np.nonzero(d == 1); r1, c1 = np.nonzero(d == -1)
        for k, x0, x1 in zip(r0.tolist(), c0.tolist(), c1.tolist()):
            if sign == 1: add((x1, k), (x0, k), (-1, 0))      # заливка снизу → идём по −x
            else: add((x0, k), (x1, k), (1, 0))
    sv = mp[1:-1, 1:] - mp[1:-1, :-1]          # (ny, nx+1): граница на решётке x=k
    for sign in (1, -1):
        d = np.diff(np.pad((sv == sign), ((1, 1), (0, 0))).astype(np.int8), axis=0)
        r0, c0 = np.nonzero(d.T == 1); r1, c1 = np.nonzero(d.T == -1)   # по столбцам
        for k, y0, y1 in zip(r0.tolist(), c0.tolist(), c1.tolist()):
            if sign == 1: add((k, y0), (k, y1), (0, 1))       # заливка справа → +y
            else: add((k, y1), (k, y0), (0, -1))
    loops = []
    while segs:
        start = next(iter(segs))
        pts = []; cur = start; ind = None; first = None
        while True:
            outs = segs[cur]
            if len(outs) == 1: e = outs.pop(); del segs[cur]
            else:
                want = (ind[1], -ind[0]) if ind else outs[0][1]
                k = next((i for i, o in enumerate(outs) if o[1] == want), 0)
                e = outs.pop(k)
                if not outs: del segs[cur]
            pts.append((cur, e[1]))
            if first is None: first = e[1]
            cur, ind = e[0], e[1]
            if cur == start:
                # замкнулись; в «шахматной» вершине закрываемся только своим поворотом
                if cur not in segs or (ind[1], -ind[0]) == first: break
        loops.append(pts)
    return loops

def _dp(pts, tol):
    """Дуглас–Пекер для ломаной (концы сохраняются)."""
    n = len(pts)
    if n <= 2: return list(pts)
    arr = np.asarray(pts, float)
    keep = np.zeros(n, bool); keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2: continue
        p = arr[a + 1:b]; A, Bq = arr[a], arr[b]
        dx, dy = Bq - A; L = math.hypot(dx, dy)
        if L == 0: d = np.hypot(p[:, 0] - A[0], p[:, 1] - A[1])
        else: d = np.abs((p[:, 0] - A[0]) * dy - (p[:, 1] - A[1]) * dx) / L
        k = int(np.argmax(d))
        if d[k] > tol:
            keep[a + 1 + k] = True
            stack.append((a, a + 1 + k)); stack.append((a + 1 + k, b))
    return [pts[i] for i in range(n) if keep[i]]

def vectorize(m, lab, tol_px=0.8):
    """Растр → список многоугольников (мм), каждый — один замкнутый контур с вертикальными разрезами к отверстиям."""
    loops = _loops(m)
    comps = {}
    for lp in loops:
        (x, y), d = lp[0]
        if d == (-1, 0): pix = (y, x - 1)
        elif d == (1, 0): pix = (y - 1, x)
        elif d == (0, 1): pix = (y, x)
        else: pix = (y - 1, x - 1)
        k = int(lab[pix])
        assert k > 0, (lp[0], pix)
        v = [p for p, _ in lp]
        area = sum(v[i][0] * v[(i + 1) % len(v)][1] - v[(i + 1) % len(v)][0] * v[i][1] for i in range(len(v)))
        comps.setdefault(k, {'outer': None, 'holes': []})
        if area < 0:
            assert comps[k]['outer'] is None
            comps[k]['outer'] = lp
        else: comps[k]['holes'].append(lp)
    polys = []
    for k, c in comps.items():
        X, Y, NXT, FIX = [], [], [], []
        def mk(x, y, fix=False):
            X.append(x); Y.append(y); NXT.append(-1); FIX.append(fix); return len(X) - 1
        edges = []     # горизонтальные рёбра «заливка снизу»: (y, xlo, xhi, start_node)
        def load(lp):
            ids = [mk(p[0], p[1]) for p, _ in lp]
            for i, nid in enumerate(ids):
                NXT[nid] = ids[(i + 1) % len(ids)]
                if lp[i][1] == (-1, 0):
                    xe = lp[(i + 1) % len(lp)][0][0]
                    edges.append((lp[i][0][1], xe, lp[i][0][0], nid))
            return ids
        outer = load(c['outer'])
        holes = []
        for lp in c['holes']:
            ids = load(lp)
            # верхнее левое горизонтальное ребро отверстия (заливка сверху, направление +x)
            best = None
            for i, (p, d) in enumerate(lp):
                if d == (1, 0) and (best is None or (p[1], p[0]) < (lp[best][0][1], lp[best][0][0])): best = i
            holes.append((lp[best][0][1], lp[best][0][0], ids[best]))
        holes.sort()
        if holes:
            ey = np.array([e[0] for e in edges]); ex0 = np.array([e[1] for e in edges]); ex1 = np.array([e[2] for e in edges])
            cuts = {}
            for (hy, hx, u) in holes:
                bx = hx + 0.5
                cand = np.nonzero((ex0 < bx) & (ex1 > bx) & (ey < hy))[0]
                assert len(cand), 'нет ребра над отверстием'
                e = int(cand[np.argmax(ey[cand])])
                yhit, a = edges[e][0], edges[e][3]
                lst = cuts.setdefault(e, [])
                bigger = [cc for cc in lst if cc[0] > bx]
                prev = min(bigger)[1] if bigger else a
                w = NXT[u]
                P1 = mk(bx, yhit, True); P2 = mk(bx, yhit, True); Hin = mk(bx, hy, True); Hout = mk(bx, hy, True)
                NXT[P2] = NXT[prev]; NXT[prev] = P1; NXT[P1] = Hin; NXT[Hin] = w; NXT[u] = Hout; NXT[Hout] = P2
                lst.append((bx, P2))
        seq = []; cur = outer[0]
        while True:
            seq.append(cur); cur = NXT[cur]
            if cur == outer[0]: break
        assert len(seq) == len(X), (len(seq), len(X))
        pts = [(X[i], Y[i]) for i in seq]; fix = [FIX[i] for i in seq]
        # упрощение по участкам между закреплёнными вершинами
        n = len(pts)
        fi = [i for i in range(n) if fix[i]]
        if not fi:
            i0 = min(range(n), key=lambda i: pts[i]); i1 = max(range(n), key=lambda i: pts[i])
            fi = sorted({i0, i1})
        out = []
        for a, b_ in zip(fi, fi[1:] + [fi[0] + n]):
            chain = [pts[i % n] for i in range(a, b_ + 1)]
            out += _dp(chain, tol_px)[:-1]
        if len(out) >= 3: polys.append([(round(x * P, 4), round(y * P, 4)) for x, y in out])
    return polys

def rasterize_polys(polys, shape, step):
    """Растеризация многоугольников (чётно-нечётное правило) — для самопроверки векторизации."""
    from PIL import Image, ImageDraw
    img = Image.new('1', (shape[1], shape[0]), 0)
    dr = ImageDraw.Draw(img)
    for p in polys: dr.polygon([(x / step - 0.5, y / step - 0.5) for x, y in p], fill=1)
    return np.array(img, bool)
