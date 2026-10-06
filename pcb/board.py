# -*- coding: utf-8 -*-
"""Плата «VIKHR-30 EFI rev A»: правила, размещение, вручную заданные силовые и высоковольтные проводники."""
import json, os
from fp import FP, xf
import geom as G

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 148.0, 100.0
NAME, REV, DATE = 'VIKHR-30 EFI', 'rev A', '2026-10'

# ── правила
CLR = 0.30            # минимальный зазор (проверка)
CLR_ROUTE = 0.36      # зазор, закладываемый трассировщиком и заливкой (с запасом на сетку)
CLR_HV = 2.50
CLR_HV_ROUTE = 2.60
EDGE = 0.50
MASK_EXP = 0.05
VIA = (0.8, 0.4)      # сигнальное переходное: площадка/отверстие
VIA_P = (1.2, 0.6)    # силовое
HV_NETS = {'COIL1', 'COIL2'}
WIDTH = {  # ширина дорожек трассировщика по цепям
    'V5': 0.8, 'V5S': 0.8, 'V33': 0.8, 'V12': 1.2, 'N_D1_A': 1.5, 'BAT': 1.5, 'F2': 1.2, 'INJ': 1.0, 'HEAT': 1.2, 'RELAY': 0.8,
    'IAC_A1': 0.8, 'IAC_A2': 0.8, 'IAC_B1': 0.8, 'IAC_B2': 0.8, 'GND': 0.6,
}
SIG_W = 0.4
def width_of(net): return WIDTH.get(net, SIG_W)
def clr_of(a, b, route=False):
    if a in HV_NETS or b in HV_NETS: return CLR_HV_ROUTE if route else CLR_HV
    return CLR_ROUTE if route else CLR

MOUNT = [(4.0, 4.0), (144.0, 4.0), (4.0, 96.0), (144.0, 96.0)]   # М3: отверстие 3,2 без меди, зона 6 мм
MOUNT_D, MOUNT_ZONE = 3.2, 6.0

YT = 93.0   # ряд клеммников
YJ = 4.5    # ряд разъёмов датчиков
RY = 17.08  # центр вертикальных резисторов входных цепей
CY, DY = 26.5, 30.6

PLACE = [
    # ref, x, y, rot, [fp override]
    ('A1', 82.13, 42.82, 0), ('A5', 14.5, 56.0, 90), ('A2', 4.5, 11.0, 0),
    ('X16', 10.5, YJ, 0), ('R22', 14.0, 11.5, 0), ('R23', 14.0, 14.5, 0), ('C16', 24.5, 13.0, 0),
    # питание
    ('XF1', 18.08, YT, 0, 'TERM_5.08_2R'), ('XF2', 28.24, YT, 0, 'TERM_5.08_2R'), ('X1', 38.4, YT, 0),
    ('D1', 30.0, 70.5, 270), ('D2', 38.4, 47.0, 90), ('C1', 9.0, 84.0, 0),
    ('L1', 122.0, 46.0, 0), ('C2', 135.5, 40.0, 0),
    # зажигание
    ('X10', 48.56, YT, 0), ('X11', 66.34, YT, 0), ('Q1', 53.64, 82.0, 0), ('Q2', 71.42, 82.0, 0),
    ('R24', 52.0, 55.7, 0), ('R25', 52.0, 58.5, 180), ('R26', 52.0, 61.3, 0), ('R27', 52.0, 64.1, 0), ('Q3', 61.3, 58.0, 0), ('Q4', 61.3, 63.0, 0),
    ('R28', 70.5, 55.7, 0), ('R29', 70.5, 58.5, 180), ('R30', 70.5, 61.3, 0), ('R31', 70.5, 64.1, 0), ('Q5', 79.8, 58.0, 0), ('Q6', 79.8, 63.0, 0),
    # форсунка, нагреватель, реле
    ('X12', 81.58, YT, 0), ('Q7', 89.2, 78.0, 0), ('D3', 81.58, 81.92, 90), ('R32', 88.0, 55.7, 0), ('R33', 88.0, 58.5, 180),
    ('X14', 96.82, YT, 0), ('Q8', 104.44, 78.0, 0), ('D4', 96.82, 81.92, 90), ('R34', 101.5, 55.7, 0), ('R35', 101.5, 58.5, 180),
    ('X13', 112.06, YT, 0), ('Q9', 118.2, 81.5, 0), ('D5', 112.06, 81.92, 90), ('R36', 115.6, 70.5, 0), ('R37', 115.6, 73.3, 180),
    # холостой ход
    ('X15', 122.22, YT, 0), ('U3', 130.0, 72.0, 0), ('C9', 133.5, 62.5, 0), ('C17', 125.5, 84.0, 180),
    # входы: разъёмы
    ('X8', 38.0, YJ, 0), ('X9', 47.0, YJ, 0), ('X6', 58.0, YJ, 0), ('X5', 77.0, YJ, 0), ('X4', 87.5, YJ, 0), ('X3', 97.0, YJ, 0), ('X2', 107.5, YJ, 0), ('X7', 119.0, YJ, 0),
    # SERVICE, STOP
    ('R18', 37.5, RY, 90), ('R19', 40.5, RY, 270), ('C14', 39.5, CY, 0),
    ('R20', 46.5, RY, 90), ('R21', 49.5, RY, 270), ('C15', 48.5, CY, 0),
    # лямбда
    ('R15', 58.0, RY, 270), ('C8', 60.0, CY, 0), ('D9', 60.0, DY, 90),
    # бортсеть
    ('R13', 67.0, RY, 270), ('R14', 70.0, RY, 90), ('C7', 68.5, CY, 0), ('D8', 68.5, DY, 90),
    # IAT, CHT
    ('R10', 75.5, RY, 270), ('R11', 78.5, RY, 90), ('R12', 81.5, RY, 270), ('C6', 79.5, CY, 0),
    ('R7', 86.0, RY, 270), ('R8', 89.0, RY, 90), ('R9', 92.0, RY, 270), ('C5', 90.0, CY, 0),
    # MAP, TPS
    ('R4', 96.5, RY, 270), ('R5', 99.5, RY, 90), ('R6', 102.5, RY, 90), ('C4', 100.5, CY, 180), ('D7', 100.5, DY, 90),
    ('R1', 107.0, RY, 270), ('R2', 110.0, RY, 90), ('R3', 113.0, RY, 90), ('C3', 111.0, CY, 180), ('D6', 111.0, DY, 90),
    # ДПКВ, PC13
    ('R16', 119.5, RY, 90), ('R17', 122.5, RY, 270), ('C13', 121.5, CY, 180), ('D11', 121.5, DY, 90),
    ('R38', 116.5, 34.4, 180),
]

class Board:
    pass

def load():
    nl = json.load(open(os.path.join(HERE, 'netlist.json'), encoding='utf-8'))
    comp = {c['ref']: c for c in nl['components']}
    b = Board(); b.W, b.H = W, H; b.netlist = nl
    b.comps = []
    placed = set()
    for row in PLACE:
        ref, x, y, rot = row[:4]
        c = comp[ref]; fpn = row[4] if len(row) > 4 else c['pkg']
        f = FP[fpn]
        pads = []
        for p in f['pads']:
            px, py = xf(p['x'], p['y'], rot)
            w, h = (p['w'], p['h']) if rot % 180 == 0 else (p['h'], p['w'])
            net = c['pins'].get(p['name'])
            if net is None: raise SystemExit(f'{ref}: у вывода {p["name"]} нет записи в netlist')
            pads.append(dict(ref=ref, name=p['name'], x=round(x + px, 4), y=round(y + py, 4), shape=p['shape'], w=w, h=h, drill=p['drill'], layers=p['layers'], net=None if net == '(NC)' else net))
        tl = lambda L: [(x + xf(a, bb, rot)[0], y + xf(a, bb, rot)[1], x + xf(c2, d, rot)[0], y + xf(c2, d, rot)[1]) for a, bb, c2, d in L]
        cx = [x + xf(f['court'][i], f['court'][j], rot)[0] for i in (0, 2) for j in (1, 3)]; cy = [y + xf(f['court'][i], f['court'][j], rot)[1] for i in (0, 2) for j in (1, 3)]
        b.comps.append(dict(ref=ref, value=c['value'], pkg=fpn, x=x, y=y, rot=rot, pads=pads, silk=tl(f['silk']), fab=tl(f['fab']), court=(min(cx), min(cy), max(cx), max(cy)),
                            h=f['h'], smd=f['smd'], npth=[(x + xf(a, bb, rot)[0], y + xf(a, bb, rot)[1], d) for a, bb, d in f['npth']], bom=c.get('bom'), url=c.get('url')))
        placed.add(ref)
        if set(p['name'] for p in f['pads']) != set(c['pins']): raise SystemExit(f'{ref}: выводы посадочного места {sorted(set(p["name"] for p in f["pads"]))} ≠ netlist {sorted(c["pins"])}')
    miss = set(comp) - placed
    if miss: raise SystemExit('не размещены: ' + ', '.join(sorted(miss)))
    b.npth = [(x, y, MOUNT_D) for x, y in MOUNT] + [h for c in b.comps for h in c['npth']]
    b.pad = {(p['ref'], p['name']): p for c in b.comps for p in c['pads'] if p['layers'] != 'T0' and (p['drill'] or True)}
    b.tracks, b.vias, b.polys = [], [], []      # (layer, net, x1,y1,x2,y2,w) ; (x,y,d,drill,net) ; (layer, net, x0,y0,x1,y1)
    manual(b)
    return b

def T(b, net, pts, w, layers='T'):
    for L in layers:
        for i in range(len(pts) - 1):
            b.tracks.append((L, net, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w))
def V(b, net, x, y, v=VIA_P): b.vias.append((x, y, v[0], v[1], net))

HV_POLY = {}
def manual(b):
    pin = lambda r, n: (b.pad[(r, n)]['x'], b.pad[(r, n)]['y'])
    # ── высоковольтные цепи: полигон-теплоотвод под фланцем IGBT на обоих слоях, шейка к клемме, тепловые переходные
    for q, x10, net in (('Q1', 'X10', 'COIL1'), ('Q2', 'X11', 'COIL2')):
        cx, cy = pin(q, '2'); tx, ty = pin(x10, '2')
        assert abs(cx - tx) < 1e-6
        x0, y0, x1, y1 = cx - 6.0, cy - 4.7, cx + 6.0, cy + 7.2
        HV_POLY[net] = (x0, y0, x1, y1)
        for L in 'TB': b.polys.append((L, net, x0, y0, x1, y1))
        T(b, net, [(cx, y1 - 1.3), (tx, ty)], 2.5, 'TB')
        for i in range(7): V(b, net, cx - 4.5 + 1.5 * i, y1 - 1.2)
        for dx in (-3.0, 0.0, 3.0):
            for dy in (-2.0, 1.5): V(b, net, cx + dx, cy + dy, VIA)
    # ── +12V_F2: шина вдоль нижнего края на обоих слоях, отводы к клеммам
    yl = 98.15
    f2x = [pin(r, '2' if r == 'XF2' else '1')[0] for r in ('XF2', 'X10', 'X11', 'X12', 'X14', 'X13')]
    T(b, 'F2', [(min(f2x), yl), (max(f2x), yl)], 2.5, 'TB')
    for x in f2x: T(b, 'F2', [(x, YT), (x, yl)], 2.5, 'TB')
    for d in ('D3', 'D4', 'D5'):
        x, y = pin(d, '1'); T(b, 'F2', [(x, y), (x, YT)], 1.2, 'T')
    # ── BAT+: X1.1–XF2.1 сплошной перемычкой на обоих слоях (10 А), к XF1.1 — в обход клеммы F2 (2 А)
    T(b, 'BAT', [pin('XF2', '1'), pin('X1', '1')], 2.5, 'TB')
    a = pin('XF1', '1'); c = pin('XF2', '1')
    T(b, 'BAT', [a, (a[0], 88.5), (c[0], 88.5), c], 1.5, 'T')
    # ── силовая земля: эмиттеры IGBT — широкой дорожкой к клемме GND разъёма X1 + переходные на полигон нижнего слоя
    e1 = pin('Q1', '3'); g = pin('X1', '2'); yb = 67.8
    T(b, 'GND', [e1, (e1[0], yb), (g[0], yb), g], 3.0, 'T')
    for x in (g[0], g[0] + 2.6, g[0] + 5.2): V(b, 'GND', x, yb)
    for y in (73.0, 78.0, 83.0, 88.0): V(b, 'GND', g[0], y)
    e2 = pin('Q2', '3')
    T(b, 'GND', [e2, (e2[0], yb)], 2.5, 'T'); T(b, 'GND', [(e2[0] - 2.2, yb), (e2[0] + 1.3, yb)], 2.5, 'T')
    for dx in (-2.2, -0.45, 1.3): V(b, 'GND', e2[0] + dx, yb)
    # ── форсунка и нагреватель: сток → клемма
    for q, x in (('Q7', 'X12'), ('Q8', 'X14')):
        d = pin(q, '2'); t = pin(x, '2'); net = b.pad[(q, '2')]['net']
        T(b, net, [d, (d[0], d[1] + 2.9)], 1.9, 'T')      # шейка шириной с площадку между соседними выводами TO-220
        T(b, net, [(d[0], d[1] + 2.9), (d[0], 83.0), (t[0], 83.0 + (d[0] - t[0])), t], 2.5, 'T')
    # ── L293DD: переходные у выводов массы (теплоотвод на нижний слой)
    for side in (-1, 1):
        for k in range(3):
            V(b, 'GND', 130.0 + side * 6.6, 72.0 - 1.9 + 1.9 * k, VIA)
    b.solid = {('X1', '2'), ('Q7', '3'), ('Q8', '3'), ('Q9', '3'), ('A5', '2'), ('A5', '4'), ('D2', '2')}   # площадки без термобарьера

def shapes(b, with_tracks=True):
    """Вся медь (кроме заливки) как список фигур."""
    out = []
    for c in b.comps:
        for p in c['pads']:
            for L in ('T', 'B') if p['layers'] == 'TB' else ('T',):
                kind = 'pad'
                ref = f"{p['ref']}.{p['name']}"
                if p['shape'] == 'c': out.append(G.circle(L, p['net'], p['x'], p['y'], p['w'], kind, ref))
                elif p['shape'] == 'r': out.append(G.rect(L, p['net'], p['x'], p['y'], p['w'], p['h'], kind, ref))
                else:
                    if p['w'] >= p['h']: out.append(G.seg(L, p['net'], p['x'] - (p['w'] - p['h']) / 2, p['y'], p['x'] + (p['w'] - p['h']) / 2, p['y'], p['h'], kind, ref))
                    else: out.append(G.seg(L, p['net'], p['x'], p['y'] - (p['h'] - p['w']) / 2, p['x'], p['y'] + (p['h'] - p['w']) / 2, p['w'], kind, ref))
    for (L, net, x0, y0, x1, y1) in b.polys:
        out.append(G.Shape(L, net, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], 0.0, 'poly', net))
    if with_tracks:
        for (L, net, x1, y1, x2, y2, w) in b.tracks: out.append(G.seg(L, net, x1, y1, x2, y2, w, 'track', net))
        for (x, y, d, dr, net) in b.vias:
            for L in 'TB': out.append(G.circle(L, net, x, y, d, 'via', net))
    return out

def holes(b):
    """Все отверстия: (x, y, d, plated)."""
    out = [(p['x'], p['y'], p['drill'], True) for c in b.comps for p in c['pads'] if p['drill']]
    out += [(x, y, dr, True) for (x, y, d, dr, net) in b.vias]
    out += [(x, y, d, False) for (x, y, d) in b.npth]
    return out

def shapes_of_pad(p):
    out = []
    for L in ('T', 'B') if p['layers'] == 'TB' else ('T',):
        if p['shape'] == 'c': out.append(G.circle(L, p['net'], p['x'], p['y'], p['w'], 'pad', f"{p['ref']}.{p['name']}"))
        elif p['shape'] == 'r': out.append(G.rect(L, p['net'], p['x'], p['y'], p['w'], p['h'], 'pad', f"{p['ref']}.{p['name']}"))
        elif p['w'] >= p['h']: out.append(G.seg(L, p['net'], p['x'] - (p['w'] - p['h']) / 2, p['y'], p['x'] + (p['w'] - p['h']) / 2, p['y'], p['h'], 'pad', f"{p['ref']}.{p['name']}"))
        else: out.append(G.seg(L, p['net'], p['x'], p['y'] - (p['h'] - p['w']) / 2, p['x'], p['y'] + (p['h'] - p['w']) / 2, p['w'], 'pad', f"{p['ref']}.{p['name']}"))
    return out
