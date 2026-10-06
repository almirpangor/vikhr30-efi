# -*- coding: utf-8 -*-
"""Сеточный трассировщик A* на двух слоях. Результат — route.json (дорожки и переходные)."""
import heapq, json, math, sys, time, os
import numpy as np
import board as B, geom as G

STEP = 0.25
NX = int(round(B.W / STEP)) + 1; NY = int(round(B.H / STEP)) + 1
N = NX * NY
LAYERS = 'TB'
COST_ORTH, COST_DIAG = 10, 14
LAYER_MUL = (1.0, 2.2)      # нижний слой дороже: бережём полигон земли
VIA_COST = 220

class State:
    def __init__(self, b):
        self.b = b
        self.netid = {}
        self.widths = sorted(set(B.WIDTH.values()) | {B.SIG_W})
        self.own = {(L, w): np.zeros((NY, NX), np.int16) for L in LAYERS for w in self.widths}
        self.vown = np.zeros((NY, NX), np.int16)                 # владельцы для переходных (оба слоя вместе)
        self.vblock = np.zeros((NY, NX), bool)                   # запрет переходных: отверстия, SMD-площадки, край
        self.edge = {w: np.zeros((NY, NX), bool) for w in self.widths}
        xs = np.arange(NX) * STEP; ys = np.arange(NY) * STEP
        X, Y = np.meshgrid(xs, ys)
        dedge = np.minimum(np.minimum(X, b.W - X), np.minimum(Y, b.H - Y))
        for w in self.widths: self.edge[w] |= dedge < B.EDGE + w / 2 + 0.05
        self.vblock |= dedge < B.EDGE + B.VIA[0] / 2 + 0.05
        for (x, y, d) in b.npth:
            zone = (B.MOUNT_ZONE / 2 if d >= 3.0 else d / 2 + 0.3)
            hs = G.Shape('T', None, [(x, y)], zone)
            for w in self.widths: G.mark(self.edge[w], hs, w / 2 + 0.25, 0, 0, STEP)
            G.mark(self.vblock, hs, B.VIA[0] / 2 + 0.25, 0, 0, STEP)
        for s in B.shapes(b): self.add_shape(s)
        for (x, y, d, pl) in B.holes(b):
            if pl: self.add_hole(x, y, d)
        for c in b.comps:
            for p in c['pads']:
                if not p['drill']:
                    G.mark(self.vblock, G.rect('T', None, p['x'], p['y'], p['w'], p['h']), B.VIA[0] / 2 + 0.15, 0, 0, STEP)
    def nid(self, net):
        if net is None: return -1
        if net not in self.netid: self.netid[net] = len(self.netid) + 1
        return self.netid[net]
    def _own(self, arr, s, grow, k):
        j0 = max(0, int(math.floor((s.bb[0] - grow) / STEP))); j1 = min(NX - 1, int(math.ceil((s.bb[2] + grow) / STEP)))
        i0 = max(0, int(math.floor((s.bb[1] - grow) / STEP))); i1 = min(NY - 1, int(math.ceil((s.bb[3] + grow) / STEP)))
        if j1 < j0 or i1 < i0: return
        X, Y = np.meshgrid(np.arange(j0, j1 + 1) * STEP, np.arange(i0, i1 + 1) * STEP)
        m = G.dist_grid(s, X, Y) <= grow
        sub = arr[i0:i1 + 1, j0:j1 + 1]
        if k == -1: sub[m] = -2
        else:
            conflict = m & (sub != 0) & (sub != k)
            sub[m & (sub == 0)] = k
            sub[conflict] = -2
    def add_shape(self, s):
        k = self.nid(s.net)
        clr = B.clr_of(s.net, None, route=True)
        for w in self.widths: self._own(self.own[(s.layer, w)], s, w / 2 + clr, k)
        self._own(self.vown, s, B.VIA[0] / 2 + clr, k)
    def add_hole(self, x, y, d):
        G.mark(self.vblock, G.Shape('T', None, [(x, y)], d / 2), B.VIA[1] / 2 + 0.5 + 0.05, 0, 0, STEP)
    def blocked(self, net, w):
        k = self.nid(net)
        out = []
        for L in LAYERS:
            o = self.own[(L, w)]
            out.append(((o != 0) & (o != k)) | self.edge[w])
        vb = ((self.vown != 0) & (self.vown != k)) | self.vblock
        return out, vb

def cells_of_shape(s, erode):
    """Узлы сетки внутри фигуры (с отступом erode внутрь)."""
    j0 = max(0, int(math.floor(s.bb[0] / STEP))); j1 = min(NX - 1, int(math.ceil(s.bb[2] / STEP)))
    i0 = max(0, int(math.floor(s.bb[1] / STEP))); i1 = min(NY - 1, int(math.ceil(s.bb[3] / STEP)))
    X, Y = np.meshgrid(np.arange(j0, j1 + 1) * STEP, np.arange(i0, i1 + 1) * STEP)
    m = G.dist_grid(s, X, Y) <= -erode
    ii, jj = np.nonzero(m)
    return [(int(i + i0) * NX + int(j + j0)) for i, j in zip(ii, jj)]

def net_groups(b, net, extra_shapes=()):
    """Группы уже соединённой меди цепи: [(набор узлов по слоям, описание)]."""
    items = []   # (shapes, label, center)
    for c in b.comps:
        for p in c['pads']:
            if p['net'] != net: continue
            sh = [s for s in B.shapes_of_pad(p)]
            items.append((sh, f"{p['ref']}.{p['name']}", (p['x'], p['y']), 'pad'))
    for t in b.tracks:
        if t[1] == net: items.append(([G.seg(t[0], net, t[2], t[3], t[4], t[5], t[6])], 'track', ((t[2] + t[4]) / 2, (t[3] + t[5]) / 2), 'track'))
    for v in b.vias:
        if v[4] == net: items.append(([G.circle(L, net, v[0], v[1], v[2]) for L in LAYERS], 'via', (v[0], v[1]), 'via'))
    for p in b.polys:
        if p[1] == net: items.append(([G.Shape(p[0], net, [(p[2], p[3]), (p[4], p[3]), (p[4], p[5]), (p[2], p[5])], 0.0)], 'poly', ((p[2] + p[4]) / 2, (p[3] + p[5]) / 2), 'poly'))
    for s in extra_shapes: items.append(([s], 'extra', s.pts[0], 'extra'))
    par = list(range(len(items)))
    def find(a):
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if find(i) == find(j): continue
            hit = False
            for s1 in items[i][0]:
                for s2 in items[j][0]:
                    if s1.layer == s2.layer and G.bb_gap(s1, s2) <= 0 and G.shape_dist(s1, s2) <= (1e-9 if (s1.r == 0 and s2.r == 0) else -0.05): hit = True; break
                if hit: break
            if hit: par[find(i)] = find(j)
    groups = {}
    for i, it in enumerate(items): groups.setdefault(find(i), []).append(it)
    return list(groups.values())

def group_cells(group):
    cells = [set(), set()]
    for shapes, label, ctr, kind in group:
        for s in shapes:
            er = 0.12 if min(s.bb[2] - s.bb[0], s.bb[3] - s.bb[1]) < 1.0 else 0.2
            cells[LAYERS.index(s.layer)].update(cells_of_shape(s, er))
    return cells

def astar(starts, tgt, blk, vb, hx, hy, extra_cost=None):
    """starts: [(L, idx)], tgt[L]: bytearray (1 — цель), blk[L]: bytearray (1 — занято), vb: bytearray запрет переходных."""
    INF = 1 << 60
    gc = [[INF] * N, [INF] * N]
    prev = [[-1] * N, [-1] * N]
    heap = []
    hj, hi = hx / STEP, hy / STEP
    def h(idx):
        dj = abs(idx % NX - hj); di = abs(idx // NX - hi)
        return int(10 * (max(dj, di) + 0.414 * min(dj, di)))
    for L, idx in starts:
        if blk[L][idx]: continue
        gc[L][idx] = 0
        heap.append((h(idx), 0, L, idx))
    heapq.heapify(heap)
    moves = ((1, COST_ORTH), (-1, COST_ORTH), (NX, COST_ORTH), (-NX, COST_ORTH), (NX + 1, COST_DIAG), (NX - 1, COST_DIAG), (-NX + 1, COST_DIAG), (-NX - 1, COST_DIAG))
    pop = heapq.heappop; push = heapq.heappush
    while heap:
        f, g, L, idx = pop(heap)
        gl = gc[L]
        if g > gl[idx]: continue
        if tgt[L][idx]:
            path = []
            cl, ci = L, idx
            while True:
                path.append((cl, ci))
                p = prev[cl][ci]
                if p == -1: break
                if p == -2: cl = 1 - cl
                else: ci = p
            return path[::-1]
        bl = blk[L]; mul = LAYER_MUL[L]; pl = prev[L]
        for d, c in moves:
            n = idx + d
            if bl[n]: continue
            if d in (NX + 1, NX - 1, -NX + 1, -NX - 1):
                # не срезать углы
                if bl[idx + (1 if d in (NX + 1, -NX + 1) else -1)] or bl[idx + (NX if d > 1 else -NX)]: continue
            ng = g + int(c * mul)
            if ng < gl[n]:
                gl[n] = ng; pl[n] = idx
                push(heap, (ng + h(n), ng, L, n))
        if not vb[idx]:
            o = 1 - L
            if not blk[o][idx]:
                ng = g + VIA_COST
                if ng < gc[o][idx]:
                    gc[o][idx] = ng; prev[o][idx] = -2
                    push(heap, (ng + h(idx), ng, o, idx))
    return None

def path_to_copper(path, net, w):
    tracks, vias = [], []
    i = 0
    while i < len(path) - 1:
        L, a = path[i]
        if path[i + 1][0] != L:
            vias.append((a % NX * STEP, a // NX * STEP, B.VIA[0], B.VIA[1], net)); i += 1; continue
        j = i + 1; d = path[j][1] - a
        while j + 1 < len(path) and path[j + 1][0] == L and path[j + 1][1] - path[j][1] == d: j += 1
        b_ = path[j][1]
        tracks.append((LAYERS[L], net, a % NX * STEP, a // NX * STEP, b_ % NX * STEP, b_ // NX * STEP, w))
        i = j
    return tracks, vias

def route_net(st, b, net, w, log, targets_extra=None):
    """Соединить все группы цепи. Возвращает (ok, добавленные дорожки, переходные)."""
    groups = net_groups(b, net)
    blk_np, vb_np = st.blocked(net, w)
    blk = [bytearray(np.ascontiguousarray(m).astype(np.uint8).tobytes()) for m in blk_np]
    for m in blk:      # рамка
        for j in range(NX): m[j] = 1; m[(NY - 1) * NX + j] = 1
        for i in range(NY): m[i * NX] = 1; m[i * NX + NX - 1] = 1
    vb = bytearray(vb_np.astype(np.uint8).tobytes())
    gcells = [group_cells(g) for g in groups]
    gctr = []
    for g in groups:
        pts = [it[2] for it in g]
        gctr.append((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)))
    # начинаем с самой большой группы
    order = sorted(range(len(groups)), key=lambda i: -len(gcells[i][0]) - len(gcells[i][1]))
    tree = [set(gcells[order[0]][0]), set(gcells[order[0]][1])]
    tree_pts = [it[2] for it in groups[order[0]]]
    rest = set(order[1:])
    new_t, new_v = [], []
    while rest:
        # ближайшая к дереву группа
        best = min(rest, key=lambda i: min(math.hypot(gctr[i][0] - p[0], gctr[i][1] - p[1]) for p in tree_pts))
        tgt = [bytearray(N), bytearray(N)]
        owner = {}
        for i in rest:
            for L in (0, 1):
                for c in gcells[i][L]:
                    if not blk[L][c]: tgt[L][c] = 1; owner[(L, c)] = i
        starts = [(L, c) for L in (0, 1) for c in tree[L] if not blk[L][c]]
        if not starts or not owner:
            log.append(f'{net}: нет свободных узлов у группы'); return False, new_t, new_v
        path = astar(starts, tgt, blk, vb, gctr[best][0], gctr[best][1])
        if path is None:
            log.append(f'{net}: не найден путь к {[it[1] for it in groups[best]][:3]}'); return False, new_t, new_v
        hit = owner[path[-1]]
        t, v = path_to_copper(path, net, w)
        new_t += t; new_v += v
        for tr in t:
            s = G.seg(tr[0], net, tr[2], tr[3], tr[4], tr[5], tr[6]); st.add_shape(s)
        for vv in v:
            for L in LAYERS: st.add_shape(G.circle(L, net, vv[0], vv[1], vv[2]))
            st.add_hole(vv[0], vv[1], vv[3])
            c = int(round(vv[1] / STEP)) * NX + int(round(vv[0] / STEP)); tree[0].add(c); tree[1].add(c)
        for L, c in path: tree[L].add(c)
        for L in (0, 1): tree[L] |= gcells[hit][L]
        tree_pts += [it[2] for it in groups[hit]] + [(c % NX * STEP, c // NX * STEP) for L, c in path[::8]]
        rest.discard(hit)
        # переходные запрещают соседние переходные — обновить локальную копию
        vb_np2 = st.blocked(net, w)[1]; vb = bytearray(vb_np2.astype(np.uint8).tobytes())
    return True, new_t, new_v

def hpwl(b, net):
    pts = [(p['x'], p['y']) for c in b.comps for p in c['pads'] if p['net'] == net]
    return (max(p[0] for p in pts) - min(p[0] for p in pts)) + (max(p[1] for p in pts) - min(p[1] for p in pts))

def run(verbose=True):
    nets_all = [n['id'] for n in B.load().netlist['nets'] if n['id'] not in B.HV_NETS and n['id'] != 'GND']
    b0 = B.load()
    power = ['N_D1_A', 'BAT', 'F2', 'V12', 'INJ', 'HEAT', 'V5', 'V5S', 'V33', 'RELAY', 'IAC_A1', 'IAC_A2', 'IAC_B1', 'IAC_B2']
    sig = sorted([n for n in nets_all if n not in power], key=lambda n: hpwl(b0, n))
    order = power + sig
    for attempt in range(12):
        b = B.load(); st = State(b); log = []; failed = None; t0 = time.time()
        for net in order:
            ok, t, v = route_net(st, b, net, B.width_of(net), log)
            b.tracks += t; b.vias += v
            if not ok: failed = net; break
        if failed is None:
            print(f'попытка {attempt + 1}: все цепи разведены за {time.time() - t0:.0f} с; дорожек {len(b.tracks)}, переходных {len(b.vias)}')
            return b, st, order
        print(f'попытка {attempt + 1}: не разведена {failed}: {log[-1]} — переносим вперёд')
        order.remove(failed); order.insert(0, failed)
    raise SystemExit('трассировка не удалась')

if __name__ == '__main__':
    b, st, order = run()
    json.dump(dict(tracks=b.tracks, vias=b.vias, order=order), open(os.path.join(B.HERE, 'route.json'), 'w'))
