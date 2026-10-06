# -*- coding: utf-8 -*-
"""Сборка проекта: трассировка → заливка GND → доводка земли → design.json."""
import json, os, sys, time, math
import numpy as np
import board as B, geom as G, route as R, pour as PR

def sample_points(s):
    if len(s.pts) == 1: return [s.pts[0]]
    if len(s.pts) == 2:
        (x1, y1), (x2, y2) = s.pts; n = max(1, int(math.hypot(x2 - x1, y2 - y1) / 0.25))
        return [(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n) for i in range(n + 1)]
    cx = sum(p[0] for p in s.pts) / len(s.pts); cy = sum(p[1] for p in s.pts) / len(s.pts)
    return [(cx, cy)]

def pour_state(b):
    shapes = B.shapes(b)
    m = {}; lab = {}
    for L in 'TB':
        m[L] = PR.raster(b, L, shapes); lab[L], _ = PR.label(m[L])
    return m, lab

def gnd_groups(b, lab):
    """Группы меди GND с учётом заливки. Возвращает (список групп, номер главной, метки заливки главной по слоям)."""
    groups = R.net_groups(b, 'GND')
    par = {}
    def find(a):
        par.setdefault(a, a)
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    for gi, g in enumerate(groups):
        for shapes, label, ctr, kind in g:
            for s in shapes:
                for (x, y) in sample_points(s):
                    i = min(PR.NYP - 1, max(0, int(y / PR.P))); j = min(PR.NXP - 1, max(0, int(x / PR.P)))
                    k = int(lab[s.layer][i, j])
                    if k: par[find(('g', gi))] = find((s.layer, k))
        find(('g', gi))
    main_gi = next(gi for gi, g in enumerate(groups) if any(it[1] == 'X1.2' for it in g))
    root = find(('g', main_gi))
    main_groups = [gi for gi in range(len(groups)) if find(('g', gi)) == root]
    main_labels = {L: sorted(k[1] for k in list(par) if k[0] == L and find(k) == root) for L in 'TB'}
    return groups, set(main_groups), main_labels

def gnd_connect(b, st, log):
    w = B.width_of('GND')
    for it in range(6):
        m, lab = pour_state(b)
        groups, main, mlab = gnd_groups(b, lab)
        rest = [gi for gi in range(len(groups)) if gi not in main]
        print(f'  земля, проход {it + 1}: групп меди GND {len(groups)}, не соединено с главной {len(rest)}')
        if not rest: return m, lab, mlab
        # узлы трассировщика, лежащие в глубине главной заливки
        deep = {}
        disk = PR._disk(9)
        for li, L in enumerate('TB'):
            mm = np.isin(lab[L], mlab[L]) if mlab[L] else np.zeros_like(m[L])
            er = PR._shift_and(mm, disk, True)
            jj = np.minimum(PR.NXP - 1, (np.arange(R.NX) * R.STEP / PR.P).astype(int)); ii = np.minimum(PR.NYP - 1, (np.arange(R.NY) * R.STEP / PR.P).astype(int))
            deep[li] = er[np.ix_(ii, jj)]
        blk_np, vb_np = st.blocked('GND', w)
        main_cells = [set(), set()]
        for gi in main:
            c = R.group_cells(groups[gi])
            for li in (0, 1): main_cells[li] |= c[li]
        for li in (0, 1):
            ii, jj = np.nonzero(deep[li] & ~blk_np[li])
            main_cells[li] |= set((ii * R.NX + jj).tolist())
        # сначала дальние от главной? — по порядку; каждую группу тянем к главной
        done = set()
        for gi in rest:
            if gi in done: continue
            blk_np, vb_np = st.blocked('GND', w)
            blk = [bytearray(np.ascontiguousarray(x).astype(np.uint8).tobytes()) for x in blk_np]
            for mm_ in blk:
                for j in range(R.NX): mm_[j] = 1; mm_[(R.NY - 1) * R.NX + j] = 1
                for i in range(R.NY): mm_[i * R.NX] = 1; mm_[i * R.NX + R.NX - 1] = 1
            vb = bytearray(vb_np.astype(np.uint8).tobytes())
            cells = R.group_cells(groups[gi])
            starts = [(li, c) for li in (0, 1) for c in cells[li] if not blk[li][c]]
            tgt = [bytearray(R.N), bytearray(R.N)]
            for li in (0, 1):
                for c in main_cells[li]:
                    if not blk[li][c]: tgt[li][c] = 1
            ctr = groups[gi][0][2]
            # цель эвристики — сама группа (поиск ближайшей точки главной: эвристика нулевая)
            path = R.astar(starts, tgt, blk, vb, ctr[0], ctr[1]) if starts else None
            names = [x[1] for x in groups[gi]][:4]
            if path is None:
                log.append(f'GND: не удалось подключить {names}'); print('   НЕ подключено:', names); continue
            t, v = R.path_to_copper(path, 'GND', w)
            b.tracks += t; b.vias += v
            for tr in t: st.add_shape(G.seg(tr[0], 'GND', tr[2], tr[3], tr[4], tr[5], tr[6]))
            for vv in v:
                for L in 'TB': st.add_shape(G.circle(L, 'GND', vv[0], vv[1], vv[2]))
                st.add_hole(vv[0], vv[1], vv[3])
            for li, c in path: main_cells[li].add(c)
            for li in (0, 1): main_cells[li] |= cells[li]
            print(f'   подключено {names}: дорожек {len(t)}, переходных {len(v)}')
    raise SystemExit('земля: не все группы соединены')

def main():
    t0 = time.time()
    b, st, order = R.run()
    log = []
    m, lab, mlab = gnd_connect(b, st, log)
    pour = {}
    for L in 'TB':
        keep = np.isin(lab[L], mlab[L])
        lab2, n2 = PR.label(keep)
        polys = PR.vectorize(keep, lab2)
        back = PR.rasterize_polys(polys, keep.shape, PR.P)
        diff = int((back != keep).sum())
        print(f'  заливка {L}: областей {n2}, многоугольников {len(polys)}, вершин {sum(len(p) for p in polys)}, площадь {keep.sum() * PR.P ** 2 / 100:.1f} см², расхождение обратной растеризации {diff} пикс. ({diff / max(1, keep.sum()) * 100:.3f} %); удалено островков {int((m[L] & ~keep).sum() * PR.P ** 2 * 100) / 100} мм²')
        pour[L] = polys
    d = dict(W=b.W, H=b.H, comps=b.comps, tracks=b.tracks, vias=b.vias, polys=b.polys, pour=pour, npth=b.npth, solid=sorted(list(b.solid)), order=order, log=log)
    json.dump(d, open(os.path.join(B.HERE, 'design.json'), 'w'))
    print(f'готово за {time.time() - t0:.0f} с: дорожек {len(b.tracks)}, переходных {len(b.vias)}')

if __name__ == '__main__': main()
