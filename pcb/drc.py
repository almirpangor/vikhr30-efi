# -*- coding: utf-8 -*-
"""Проверки A (правила), B (связность по геометрии), D (посадочные места), E (токи) по design.json."""
import json, math, os, sys
import numpy as np
import board as B, geom as G, fp as FPM

def load(): return json.load(open(os.path.join(B.HERE, 'design.json')))

def all_shapes(d):
    out = []
    for c in d['comps']:
        for p in c['pads']:
            for s in B.shapes_of_pad(p):
                s.net = p['net'] if p['net'] else f"NC:{p['ref']}.{p['name']}"
                s.kind = 'pad0' if p['layers'] == 'T0' else ('pad' if p['drill'] else 'smd'); out.append(s)
    for (L, net, x0, y0, x1, y1) in d['polys']: out.append(G.Shape(L, net, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], 0.0, 'poly', net))
    for (L, net, x1, y1, x2, y2, w) in d['tracks']: out.append(G.seg(L, net, x1, y1, x2, y2, w, 'track', net))
    for (x, y, dia, dr, net) in d['vias']:
        for L in 'TB': out.append(G.circle(L, net, x, y, dia, 'via', net))
    return out

def need(a, b):
    return B.CLR_HV if (a in B.HV_NETS or b in B.HV_NETS) else B.CLR

def pip(px, py, poly):
    """Чётно-нечётный тест точек в многоугольнике (векторно)."""
    P = np.asarray(poly); x1 = P[:, 0]; y1 = P[:, 1]; x2 = np.roll(x1, -1); y2 = np.roll(y1, -1)
    inside = np.zeros(len(px), bool)
    for k in range(0, len(x1), 4000):
        a1, b1, a2, b2 = x1[k:k + 4000], y1[k:k + 4000], x2[k:k + 4000], y2[k:k + 4000]
        cond = (b1[None, :] > py[:, None]) != (b2[None, :] > py[:, None])
        with np.errstate(divide='ignore', invalid='ignore'):
            xi = a1[None, :] + (py[:, None] - b1[None, :]) * (a2 - a1)[None, :] / (b2 - b1)[None, :]
        inside ^= (np.sum(cond & (px[:, None] < xi), axis=1) % 2).astype(bool)
    return inside

def edge_samples(poly, step=0.1):
    P = np.asarray(poly); Q = np.roll(P, -1, axis=0)
    out = []
    L = np.hypot(Q[:, 0] - P[:, 0], Q[:, 1] - P[:, 1])
    for i in range(len(P)):
        n = max(1, int(L[i] / step))
        t = np.arange(n) / n
        out.append(np.stack([P[i, 0] + (Q[i, 0] - P[i, 0]) * t, P[i, 1] + (Q[i, 1] - P[i, 1]) * t], axis=1))
    return np.concatenate(out)

def check_A(d, R):
    sh = all_shapes(d); viol = []
    stats = {}
    # 1. медь–медь
    minc = {'обычные': (9e9, ''), 'ВВ': (9e9, '')}
    for L in 'TB':
        S = [s for s in sh if s.layer == L]
        cell = 6.0; grid = {}
        for i, s in enumerate(S):
            for gx in range(int((s.bb[0] - 2.6) // cell), int((s.bb[2] + 2.6) // cell) + 1):
                for gy in range(int((s.bb[1] - 2.6) // cell), int((s.bb[3] + 2.6) // cell) + 1): grid.setdefault((gx, gy), []).append(i)
        seen = set()
        for lst in grid.values():
            for a in range(len(lst)):
                for b_ in range(a + 1, len(lst)):
                    i, j = lst[a], lst[b_]
                    if (i, j) in seen: continue
                    seen.add((i, j))
                    s1, s2 = S[i], S[j]
                    if s1.net == s2.net: continue
                    nd = need(s1.net, s2.net)
                    if G.bb_gap(s1, s2) > nd + 0.2: continue
                    dist = G.shape_dist(s1, s2)
                    key = 'ВВ' if nd > 1 else 'обычные'
                    if dist < minc[key][0]: minc[key] = (dist, f'{L}: {s1.kind} {s1.ref or s1.net} ({s1.net}) ↔ {s2.kind} {s2.ref or s2.net} ({s2.net})')
                    if dist < nd - 1e-6: viol.append(f'зазор {dist:.3f} < {nd}: слой {L}: {s1.kind} {s1.ref} [{s1.net}] ↔ {s2.kind} {s2.ref} [{s2.net}] около ({s1.pts[0][0]:.2f}, {s1.pts[0][1]:.2f})')
    R.append(f'A1. Зазоры медь–медь разных цепей (точная геометрия, пар фигур проверено по сетке):')
    R.append(f'    минимальный зазор обычных цепей: {minc["обычные"][0]:.3f} мм (норма ≥ {B.CLR}) — {minc["обычные"][1]}')
    R.append(f'    минимальный зазор до ВВ-цепей COIL1−/COIL2−: {minc["ВВ"][0]:.3f} мм (норма ≥ {B.CLR_HV}) — {minc["ВВ"][1]}')
    # 2. заливка — чужая медь
    minp = {'обычные': 9e9, 'ВВ': 9e9}; inside_bad = 0
    for L in 'TB':
        polys = d['pour'][L]
        if not polys: continue
        pts = np.concatenate([edge_samples(p) for p in polys])
        cell = 4.0; keys = (np.floor(pts[:, 0] / cell).astype(int) * 1000 + np.floor(pts[:, 1] / cell).astype(int))
        order = np.argsort(keys); keys_s = keys[order]; pts_s = pts[order]
        uniq, start = np.unique(keys_s, return_index=True); end = np.append(start[1:], len(keys_s)); idx = {int(k): (int(a), int(b_)) for k, a, b_ in zip(uniq, start, end)}
        S = [s for s in sh if s.layer == L and s.net != 'GND']
        cx = np.array([sum(p[0] for p in s.pts) / len(s.pts) for s in S]); cy = np.array([sum(p[1] for p in s.pts) / len(s.pts) for s in S])
        ins = np.zeros(len(S), bool)
        for p in polys: ins ^= pip(cx, cy, p)
        inside_bad += int(ins.sum())
        for k in np.nonzero(ins)[0]: viol.append(f'заливка GND слоя {L} накрывает {S[k].kind} {S[k].ref} [{S[k].net}]')
        for s in S:
            nd = need(s.net, 'GND'); mg = nd + 0.3
            sel = []
            for gx in range(int((s.bb[0] - mg) // cell), int((s.bb[2] + mg) // cell) + 1):
                for gy in range(int((s.bb[1] - mg) // cell), int((s.bb[3] + mg) // cell) + 1):
                    r = idx.get(gx * 1000 + gy)
                    if r: sel.append(pts_s[r[0]:r[1]])
            if not sel: continue
            q = np.concatenate(sel)
            dist = float(G.dist_grid(s, q[:, 0], q[:, 1]).min())
            key = 'ВВ' if nd > 1 else 'обычные'
            minp[key] = min(minp[key], dist)
            if dist < nd - 1e-6: viol.append(f'зазор заливки {dist:.3f} < {nd}: слой {L}: {s.kind} {s.ref} [{s.net}]')
    R.append(f'A2. Зазоры заливки GND до чужой меди (контур заливки, шаг выборки 0,1 мм): обычные цепи мин. {minp["обычные"]:.3f} мм (≥ {B.CLR}); ВВ мин. {minp["ВВ"]:.3f} мм (≥ {B.CLR_HV}); чужих фигур внутри заливки: {inside_bad}')
    # 3. ширины
    wmin = {}
    for (L, net, x1, y1, x2, y2, w) in d['tracks']: wmin[net] = min(wmin.get(net, 9e9), w)
    allmin = min(wmin.values())
    if allmin < 0.3 - 1e-9: viol.append(f'дорожка уже 0,3 мм: {allmin}')
    R.append(f'A3. Ширина дорожек: минимальная на плате {allmin} мм (норма ≥ 0,3; сигнальные 0,4). Минимум по силовым цепям: ' + ', '.join(f'{n} {wmin[n]}' for n in ('V5', 'V5S', 'V33', 'V12', 'N_D1_A', 'BAT', 'F2', 'INJ', 'HEAT', 'COIL1', 'COIL2', 'GND') if n in wmin))
    for n, wreq in (('V5', 0.8), ('V5S', 0.8), ('V33', 0.8)):
        if wmin.get(n, 9) < wreq - 1e-9: viol.append(f'{n}: дорожка {wmin[n]} < {wreq}')
    # 4. пояски
    rmin = (9e9, '')
    for c in d['comps']:
        for p in c['pads']:
            if p['drill']:
                r = (min(p['w'], p['h']) - p['drill']) / 2
                if r < rmin[0]: rmin = (r, f"{p['ref']}.{p['name']}")
                if r < 0.35 - 1e-9: viol.append(f"поясок {r:.3f} < 0,35: {p['ref']}.{p['name']}")
    vr = min((v[2] - v[3]) / 2 for v in d['vias'])
    if vr < 0.2 - 1e-9: viol.append(f'поясок переходного {vr}')
    R.append(f'A4. Гарантийный поясок выводных площадок: мин. {rmin[0]:.3f} мм ({rmin[1]}; норма ≥ 0,35); переходных: {vr:.2f} мм (0,8/0,4 и 1,2/0,6)')
    # 5. отверстие–отверстие
    hs = [(p['x'], p['y'], p['drill'], f"{p['ref']}.{p['name']}") for c in d['comps'] for p in c['pads'] if p['drill']] + [(v[0], v[1], v[3], 'via') for v in d['vias']] + [(x, y, dd, 'NPTH') for x, y, dd in d['npth']]
    hmin = (9e9, '')
    for i in range(len(hs)):
        for j in range(i + 1, len(hs)):
            dd = math.hypot(hs[i][0] - hs[j][0], hs[i][1] - hs[j][1]) - hs[i][2] / 2 - hs[j][2] / 2
            if dd < hmin[0]: hmin = (dd, f'{hs[i][3]} ↔ {hs[j][3]}')
            if dd < 0.5 - 1e-9: viol.append(f'отверстия ближе 0,5: {dd:.3f} {hs[i][3]} ↔ {hs[j][3]} ({hs[i][0]:.2f},{hs[i][1]:.2f})')
    R.append(f'A5. Отверстие–отверстие (край–край): мин. {hmin[0]:.3f} мм ({hmin[1]}; норма ≥ 0,5); всего отверстий {len(hs)}')
    # 6. медь–край, медь–крепёж
    emin = 9e9; nmin = 9e9
    for s in sh:
        e = min(s.bb[0], s.bb[1], d['W'] - s.bb[2], d['H'] - s.bb[3]); emin = min(emin, e)
        if e < B.EDGE - 1e-6: viol.append(f'медь у края {e:.3f}: {s.kind} {s.ref}')
        for (x, y, dd) in d['npth']:
            g = G.shape_dist(s, G.Shape(s.layer, None, [(x, y)], dd / 2)); nmin = min(nmin, g)
            if g < (1.3 if dd >= 3 else 0.3) - 1e-6: viol.append(f'медь у неметаллизированного отверстия {g:.3f}: {s.kind} {s.ref}')
    pe = 9e9; pn = 9e9
    for L in 'TB':
        for p in d['pour'][L]:
            P = np.asarray(p); pe = min(pe, P[:, 0].min(), P[:, 1].min(), d['W'] - P[:, 0].max(), d['H'] - P[:, 1].max())
            q = edge_samples(p, 0.2)
            for (x, y, dd) in d['npth']: pn = min(pn, float(np.hypot(q[:, 0] - x, q[:, 1] - y).min()) - dd / 2)
    if pe < B.EDGE - 1e-6: viol.append(f'заливка у края {pe:.3f}')
    if pn < 0.3: viol.append(f'заливка у неметаллизированного отверстия {pn:.3f}')
    R.append(f'A6. Медь до края платы: дорожки/площадки мин. {emin:.3f} мм, заливка мин. {pe:.3f} мм (норма ≥ {B.EDGE}); до крепёжных отверстий: дорожки/площадки {nmin:.3f} мм, заливка {pn:.3f} мм (зона М3 ⌀6 → ≥ 1,4 от края отверстия ⌀3,2)')
    # 7. маска
    ops = [s for s in sh if s.kind in ('pad', 'smd')]
    mmin = (9e9, '')
    for L in 'TB':
        S = [s for s in ops if s.layer == L]
        for i in range(len(S)):
            for j in range(i + 1, len(S)):
                if S[i].net == S[j].net or G.bb_gap(S[i], S[j]) > 1.0: continue
                g = G.shape_dist(S[i], S[j]) - 2 * B.MASK_EXP
                if g < mmin[0]: mmin = (g, f'{S[i].ref} ↔ {S[j].ref}')
    if mmin[0] < 0.1: viol.append(f'перемычка маски {mmin[0]:.3f} < 0,1: {mmin[1]}')
    R.append(f'A7. Маска: расширение {B.MASK_EXP} мм на сторону; минимальная перемычка маски между площадками разных цепей {mmin[0]:.3f} мм ({mmin[1]}; норма ≥ 0,1); переходные закрыты маской')
    # 8. шелк
    smin = 9e9; nbad = 0; lwmin = 9e9
    for L in 'TB':
        S = [s for s in ops if s.layer == L] + [G.Shape(L, None, [(x, y)], dd / 2, 'npth') for x, y, dd in d['npth']]
        segs = d['silk'][L]
        if not segs: continue
        A_ = np.array([(s[0], s[1], s[2], s[3]) for s in segs]); wv = np.array([s[4] for s in segs]); lwmin = min(lwmin, wv.min())
        # выборка по 5 точек на отрезок
        T = np.linspace(0, 1, 7)
        X = A_[:, 0:1] + (A_[:, 2:3] - A_[:, 0:1]) * T; Y = A_[:, 1:2] + (A_[:, 3:4] - A_[:, 1:2]) * T
        for s in S:
            m = (X.max(axis=1) > s.bb[0] - 0.6) & (X.min(axis=1) < s.bb[2] + 0.6) & (Y.max(axis=1) > s.bb[1] - 0.6) & (Y.min(axis=1) < s.bb[3] + 0.6)
            if not m.any(): continue
            dd = G.dist_grid(s, X[m], Y[m]) - wv[m][:, None] / 2 - (B.MASK_EXP if s.kind != 'npth' else 0)
            v = float(dd.min()); smin = min(smin, v)
            if v < 0.1 - 1e-6: nbad += 1; viol.append(f'шелк ближе 0,1 мм к вскрытию маски: {s.ref or s.kind} ({v:.3f}) слой {L}')
        if X.min() < 0.3 or Y.min() < 0.3 or X.max() > d['W'] - 0.3 or Y.max() > d['H'] - 0.3: viol.append('шелк у края платы')
    hmin_t = min(t['h'] for t in d['texts'])
    if hmin_t < 1.0 - 1e-9: viol.append(f'текст ниже 1,0 мм: {hmin_t}')
    if lwmin < 0.15 - 1e-9: viol.append(f'линия шелка тоньше 0,15: {lwmin}')
    R.append(f'A8. Шелкография: мин. расстояние краски до вскрытия маски {smin:.3f} мм (норма ≥ 0,1); высота текста мин. {hmin_t} мм (≥ 1,0); линия мин. {lwmin} мм (≥ 0,15); надписей {len(d["texts"])}; надписей поверх закрытых маской переходных: {d["silk_report"]["via_overlaps"]}')
    # 9. размещение
    cs = d['comps']; a1 = next(c for c in cs if c['ref'] == 'A1'); nov = 0
    for i in range(len(cs)):
        for j in range(i + 1, len(cs)):
            a, c = cs[i]['court'], cs[j]['court']
            if a[0] < c[2] - 1e-6 and c[0] < a[2] - 1e-6 and a[1] < c[3] - 1e-6 and c[1] < a[3] - 1e-6:
                o = cs[j] if cs[i]['ref'] == 'A1' else cs[i] if cs[j]['ref'] == 'A1' else None
                if o is not None and o['h'] <= 2.0: continue
                nov += 1; viol.append(f'габариты пересекаются: {cs[i]["ref"]} и {cs[j]["ref"]}')
    under = [c['ref'] for c in cs if c['ref'] != 'A1' and c['court'][0] < a1['court'][2] and a1['court'][0] < c['court'][2] and c['court'][1] < a1['court'][3] and a1['court'][1] < c['court'][3]]
    tall = [c['ref'] for c in cs if c['h'] > 8.0 and c['ref'] != 'A1' and c['court'][1] < a1['court'][3] and c['court'][3] > a1['court'][1] and (a1['court'][0] - 20 < c['court'][2] < a1['court'][0] + 1 or a1['court'][2] - 1 < c['court'][0] < a1['court'][2] + 20)]
    if tall: viol.append('высокие детали в зоне кабеля USB/SWD у торцов Blue Pill: ' + ', '.join(tall))
    R.append(f'A9. Размещение: пересечений габаритов {nov}; под платой Blue Pill только детали ≤ 2 мм: {", ".join(under) or "нет"} (SOT-23, 1,1 мм); высоких (> 8 мм) деталей в 20 мм от торцов Blue Pill: {len(tall)}')
    for c in cs:
        if c['pkg'].startswith('TERM') and d['H'] - c['court'][3] > 3.0: viol.append(f'клеммник {c["ref"]} не у края')
    R.append(f'ИТОГО по разделу A: нарушений {len(viol)}')
    for v in viol[:60]: R.append('   ! ' + v)
    return viol

def check_B(d, R):
    sh = all_shapes(d)
    par = list(range(len(sh)))
    def find(a):
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    def uni(a, b_): par[find(a)] = find(b_)
    # сквозные площадки и переходные связывают слои: фигуры с одинаковым центром и kind pad/via
    key = {}
    for i, s in enumerate(sh):
        if s.kind in ('pad', 'via') and (s.kind == 'via' or True):
            k = (s.kind, s.ref, round(sum(p[0] for p in s.pts) / len(s.pts), 3), round(sum(p[1] for p in s.pts) / len(s.pts), 3))
            if k in key: uni(i, key[k])
            else: key[k] = i
    for L in 'TB':
        idx = [i for i, s in enumerate(sh) if s.layer == L]
        cell = 6.0; grid = {}
        for i in idx:
            s = sh[i]
            for gx in range(int(s.bb[0] // cell), int(s.bb[2] // cell) + 1):
                for gy in range(int(s.bb[1] // cell), int(s.bb[3] // cell) + 1): grid.setdefault((gx, gy), []).append(i)
        seen = set()
        for lst in grid.values():
            for a in range(len(lst)):
                for b_ in range(a + 1, len(lst)):
                    i, j = lst[a], lst[b_]
                    if (i, j) in seen or find(i) == find(j): continue
                    seen.add((i, j))
                    if G.bb_gap(sh[i], sh[j]) > 0: continue
                    if G.shape_dist(sh[i], sh[j]) <= 1e-9: uni(i, j)
    # заливка: каждый многоугольник — узел; фигура соединена, если её центр внутри многоугольника
    base = len(sh); pn = 0
    for L in 'TB':
        idx = [i for i, s in enumerate(sh) if s.layer == L]
        # точки проверки: центр фигуры, а у дорожек ещё и оба конца
        pts = []; own = []
        for i in idx:
            s = sh[i]
            pts.append((sum(p[0] for p in s.pts) / len(s.pts), sum(p[1] for p in s.pts) / len(s.pts))); own.append(i)
            if s.kind == 'track':
                for p in s.pts: pts.append(p); own.append(i)
        cx = np.array([p[0] for p in pts]); cy = np.array([p[1] for p in pts])
        for poly in d['pour'][L]:
            node = base + pn; pn += 1; par.append(node)
            ins = pip(cx, cy, poly)
            for k in np.nonzero(ins)[0]: uni(own[k], node)
    comp_nets = {}; net_comps = {}
    for i, s in enumerate(sh):
        if s.net.startswith('NC:'): continue
        r = find(i); comp_nets.setdefault(r, set()).add(s.net); net_comps.setdefault(s.net, set()).add(r)
    shorts = [sorted(v) for v in comp_nets.values() if len(v) > 1]
    opens = {n: len(v) for n, v in net_comps.items() if len(v) > 1}
    nets = [n['id'] for n in json.load(open(os.path.join(B.HERE, 'netlist.json')))['nets']]
    missing = [n for n in nets if n not in net_comps]
    # выводы: каждый вывод netlist присутствует как площадка с этой цепью
    padnet = {f"{p['ref']}.{p['name']}": p['net'] for c in d['comps'] for p in c['pads']}
    nlp = {pin: n['id'] for n in json.load(open(os.path.join(B.HERE, 'netlist.json')))['nets'] for pin in n['pins']}
    bad = [k for k, v in nlp.items() if padnet.get(k) != v]
    # NC-площадки не должны ничего касаться
    ncbad = []
    for i, s in enumerate(sh):
        if s.net.startswith('NC:'):
            r = find(i)
            if r in comp_nets: ncbad.append(s.ref)
    R.append(f'B. Связность по геометрии проекта (фигур меди {len(sh)}, многоугольников заливки {pn}):')
    R.append(f'   цепей в netlist {len(nets)}; цепей, собранных в одну связную область: {len(nets) - len(opens) - len(missing)}; разорванных цепей: {len(opens)} {opens or ""}; отсутствующих: {len(missing)}')
    R.append(f'   замыканий между цепями: {len(shorts)} {shorts or ""}; выводов netlist {len(nlp)}, не совпало с площадками: {len(bad)}; свободных (NC) площадок, задетых медью: {len(ncbad)} {ncbad or ""}')
    return len(opens) + len(shorts) + len(missing) + len(bad) + len(ncbad)

def ipc2221(w_mm, t_um, dT):
    """Допустимый ток, А: внешний слой, I = 0,048·ΔT^0,44·A^0,725 (A — сечение в mil²)."""
    A = (w_mm / 0.0254) * (t_um / 25.4)
    return 0.048 * dT ** 0.44 * A ** 0.725

def check_E(d, R):
    R.append('E. Токовая оценка силовых проводников по IPC-2221 (внешний слой), допустимый ток, А:')
    R.append('   цепь (участок)                              ширина  | 35 мкм ΔT=10 | 35 мкм ΔT=20 | 70 мкм ΔT=20 | рабочий ток (оценка)')
    wmin = {}
    for (L, net, x1, y1, x2, y2, w) in d['tracks']: wmin[net] = min(wmin.get(net, 9e9), w)
    rows = [
        ('+12V_F2: шина у кромки, 2,5 мм × 2 слоя', 5.0, 'до 10 А (предохранитель F2); средний 3…5 А'),
        ('BAT+: X1–XF2, 2,5 мм × 2 слоя', 5.0, 'до 10 А'),
        ('BAT+: к XF1 (питание ECU)', 1.5, 'до 2 А (F1)'),
        ('COIL1−/COIL2−: шейка 2,5 мм × 2 слоя + полигон', 5.0, 'импульс до ~8 А, средний ≤ 2 А'),
        ('GND силовая: эмиттер Q1 → X1, 3,0 мм + полигон низа', 3.0, 'импульс до ~8 А, средний ≤ 4 А'),
        ('INJ−: сток Q7 → X12', 2.5, '≈ 1 А'),
        ('HEATER−: сток Q8 → X14', 2.5, 'до ~2 А (уточнить по зонду)'),
        (f'N_D1_A (XF1 → D1)', wmin.get('N_D1_A', 0), 'до 2 А'),
        (f'+12V_PROT', wmin.get('V12', 0), '≤ 1,5 А (LM2596 + L293D)'),
        (f'+12V_F2: отводы к диодам D3…D5 и к разводке', wmin.get('F2', 0), 'импульсы гашения ≤ 2 А'),
        (f'HEATER−/INJ− к диодам D4/D3', min(wmin.get('HEAT', 9), wmin.get('INJ', 9)), 'импульсы ≤ 2 А'),
        (f'+5V_ECU', wmin.get('V5', 0), '≤ 0,3 А'),
        (f'+5V_SENS, +3V3', min(wmin.get('V5S', 9), wmin.get('V33', 9)), '≤ 0,05 А'),
        (f'IAC (обмотки РХХ)', wmin.get('IAC_A1', 0), '≤ 0,6 А'),
        (f'RELAY−', wmin.get('RELAY', 0), '≈ 0,15 А'),
        ('сигнальные', 0.4, 'мА'),
    ]
    for name, w, cur in rows:
        R.append(f'   {name:<46} {w:>4.1f} мм | {ipc2221(w, 35, 10):>10.1f}   | {ipc2221(w, 35, 20):>10.1f}   | {ipc2221(w, 70, 20):>10.1f}   | {cur}')
    R.append('   Примечание: шина +12V_F2 при меди 35 мкм и ΔT=20 °C держит меньше 10 А длительно — номинал F2 она выдерживает только кратковременно;')
    R.append('   средний ток нагрузок ниже. Для запаса заказать медь 70 мкм или пропаять шину у кромки (на ней можно вскрыть маску) — см. README.')

def check_D(R):
    R.append('D. Контрольные размеры посадочных мест:')
    R.append('   посадочное место   | шаг / размеры площадок | источник, уверенность')
    for k, (dim, src) in FPM.INFO.items(): R.append(f'   {k:<18} | {dim} | {src}')
    # самопроверка шагов по координатам
    f = FPM.FP; chk = []
    def pitch(name, a, b_): 
        pa = next(p for p in f[name]['pads'] if p['name'] == a); pb = next(p for p in f[name]['pads'] if p['name'] == b_)
        return round(math.hypot(pa['x'] - pb['x'], pa['y'] - pb['y']), 3)
    for name, a, b_, want in (('R_AXIAL_10.16', '1', '2', 10.16), ('DO-41_10.16', '1', '2', 10.16), ('DO-201AD_15.24', '1', '2', 15.24), ('C_DISC_5.08', '1', '2', 5.08), ('CP_D8_P3.5', '1', '2', 3.5),
                              ('CP_D6.3_P2.5', '1', '2', 2.5), ('TO-220_V', '1', '2', 2.54), ('TO-92', '1', '2', 2.54), ('SO-20W', '1', '2', 1.27), ('SO-20W', '1', '20', 9.3), ('JST_XH_3', '1', '2', 2.5),
                              ('TERM_5.08_2', '1', '2', 5.08), ('HDR_1x6', '1', '2', 2.54), ('BLUEPILL_2x20', 'JL1', 'JL2', 2.54), ('BLUEPILL_2x20', 'JL1', 'JR1', 15.24), ('BLUEPILL_2x20', 'JL1', 'JL20', 48.26), ('SOT-23', '1', '2', 1.9), ('TO-263-2', '1', '3', 5.08)):
        got = pitch(name, a, b_); chk.append(f'{name} {a}–{b_}: {got}' + ('' if abs(got - want) < 1e-6 else f' ≠ {want} !!!'))
    R.append('   Шаги по координатам площадок: ' + '; '.join(chk))

if __name__ == '__main__':
    d = load(); R = []
    va = check_A(d, R); R.append('')
    nb = check_B(d, R); R.append('')
    check_D(R); R.append(''); check_E(d, R)
    open(os.path.join(B.HERE, 'out', 'check_ABDE.txt'), 'w', encoding='utf-8').write('\n'.join(R) + '\n')
    print('\n'.join(R))
    sys.exit(1 if (va or nb) else 0)
