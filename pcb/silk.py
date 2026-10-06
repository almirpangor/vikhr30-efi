# -*- coding: utf-8 -*-
"""Шелкография: контуры деталей (обрезанные у площадок), позиционные обозначения (авторазмещение), подписи контактов, надписи."""
import json, math, os
import numpy as np
import board as B, geom as G, font as F

LW = 0.15
TH = 1.0
SILK_PAD_GAP = 0.15

def load():
    return json.load(open(os.path.join(B.HERE, 'design.json')))

PIN_LABELS = {  # подписи контактов клеммников (у кромки платы) и разъёмов
    'XF1': {'1': 'F1', '2': 'F1'}, 'XF2': {'1': 'F2', '2': 'F2'}, 'X1': {'1': '+BAT', '2': 'GND'},
    'X10': {'1': '+12', '2': 'K1-'}, 'X11': {'1': '+12', '2': 'K2-'}, 'X12': {'1': '+12', '2': 'INJ'}, 'X14': {'1': '+12', '2': 'HTR'},
    'X13': {'1': '+12', '2': 'REL'}, 'X15': {'1': 'A1', '2': 'A2', '3': 'B1', '4': 'B2'},
    'X2': {'1': '5V', '2': 'S', '3': 'G'}, 'X3': {'1': '5V', '2': 'S', '3': 'G'}, 'X7': {'1': '5V', '2': 'S', '3': 'G'},
    'X4': {'1': 'S', '2': 'G'}, 'X5': {'1': 'S', '2': 'G'}, 'X6': {'1': 'S', '2': 'G'}, 'X8': {'1': 'S', '2': 'G'}, 'X9': {'1': 'S', '2': 'G'},
    'X16': {'1': 'G', '2': 'RX', '3': 'TX', '4': 'NC'},
    'A2': {'1': 'ST', '2': 'RX', '3': 'TX', '4': 'G', '5': '5V', '6': 'EN'},
    'A5': {'1': 'IN+', '2': 'IN-', '3': 'OUT+', '4': 'OUT-'},
}
CONN_NAME = {'X2': 'TPS', 'X3': 'MAP', 'X4': 'CHT', 'X5': 'IAT', 'X6': 'O2', 'X7': 'CKP', 'X8': 'SERV', 'X9': 'STOP', 'X16': 'UART'}
REF_TEXT = {'XF1': 'XF1 2A', 'XF2': 'XF2 10A'}
MCU = {**{f'JL{i + 1}': n for i, n in enumerate('VBAT PC13 PC14 PC15 PA0 PA1 PA2 PA3 PA4 PA5 PA6 PA7 PB0 PB1 PB10 PB11 NRST 3V3 GND GND'.split())},
       **{f'JR{i + 1}': n for i, n in enumerate('3V3 GND 5V PB9 PB8 PB7 PB6 PB5 PB4 PB3 PA15 PA12 PA11 PA10 PA9 PA8 PB15 PB14 PB13 PB12'.split())}}

def pad_shape(p, layer='T'):
    s = [q for q in B.shapes_of_pad(p) if q.layer == layer]
    return s[0] if s else None

def build(d):
    comps = d['comps']
    top_pads = []; bot_pads = []
    for c in comps:
        for p in c['pads']:
            if p['layers'] == 'T0': continue
            top_pads.append(pad_shape(p, 'T'))
            if p['layers'] == 'TB': bot_pads.append(pad_shape(p, 'B'))
    holes = [(x, y, dr) for c in comps for p in c['pads'] if p['drill'] for (x, y, dr) in [(p['x'], p['y'], p['drill'])]] + [(x, y, dd) for x, y, dd in d['npth']]
    via_holes = [(v[0], v[1], v[3]) for v in d['vias']]
    obst = {'T': top_pads + [G.Shape('T', None, [(x, y)], dr / 2) for x, y, dr in holes], 'B': bot_pads + [G.Shape('B', None, [(x, y)], dr / 2) for x, y, dr in holes]}
    vobst = [G.Shape('T', None, [(x, y)], dr / 2) for x, y, dr in via_holes]
    silk = {'T': [], 'B': []}
    texts = []      # (side, text, x, y, h, rot, bbox)
    report = {'via_overlaps': 0, 'fallback': []}

    def clip(seg, side, w=LW):
        """Обрезать отрезок у площадок/отверстий."""
        x1, y1, x2, y2 = seg
        L = math.hypot(x2 - x1, y2 - y1)
        if L < 1e-6: return []
        n = max(1, int(math.ceil(L / 0.05)))
        t = (np.arange(n) + 0.5) / n
        X = x1 + (x2 - x1) * t; Y = y1 + (y2 - y1) * t
        ok = np.ones(n, bool)
        bb = (min(x1, x2) - 2, min(y1, y2) - 2, max(x1, x2) + 2, max(y1, y2) + 2)
        for s in obst[side] + vobst:
            if s.bb[2] < bb[0] or s.bb[0] > bb[2] or s.bb[3] < bb[1] or s.bb[1] > bb[3]: continue
            ok &= G.dist_grid(s, X, Y) > SILK_PAD_GAP + B.MASK_EXP + w / 2 + 0.03
        ok &= (X > 0.4) & (X < d['W'] - 0.4) & (Y > 0.4) & (Y < d['H'] - 0.4)
        out = []; i = 0
        while i < n:
            if ok[i]:
                j = i
                while j + 1 < n and ok[j + 1]: j += 1
                a, b_ = i / n, (j + 1) / n
                if (b_ - a) * L >= 0.3: out.append((x1 + (x2 - x1) * a, y1 + (y2 - y1) * a, x1 + (x2 - x1) * b_, y1 + (y2 - y1) * b_, w))
                i = j + 1
            else: i += 1
        return out

    for c in comps:
        for sg in c['silk']: silk['T'] += clip(sg, 'T')

    placed = []     # bbox занятых надписями
    courts = {c['ref']: c['court'] for c in comps}
    def free(bb, side, own=None, check_courts=True, soft_vias=True):
        if bb[0] < 0.7 or bb[1] < 0.7 or bb[2] > d['W'] - 0.7 or bb[3] > d['H'] - 0.7: return False
        m = SILK_PAD_GAP + B.MASK_EXP + LW / 2 + 0.05
        for s in obst[side]:
            if s.bb[0] - m < bb[2] and bb[0] < s.bb[2] + m and s.bb[1] - m < bb[3] and bb[1] < s.bb[3] + m: return False
        if soft_vias:
            for s in vobst:
                if s.bb[0] - 0.1 < bb[2] and bb[0] < s.bb[2] + 0.1 and s.bb[1] - 0.1 < bb[3] and bb[1] < s.bb[3] + 0.1: return False
        for q in placed:
            if q[4] == side and q[0] - 0.5 < bb[2] and bb[0] < q[2] + 0.5 and q[1] - 0.25 < bb[3] and bb[1] < q[3] + 0.25: return False
        if check_courts:
            for r, ct in courts.items():
                if r == own: continue
                if ct[0] < bb[2] and bb[0] < ct[2] and ct[1] < bb[3] and bb[1] < ct[3]: return False
        return True
    def put(side, s, x, y, h=TH, rot=0, anchor='c', w=LW):
        bb = F.bbox(s, x, y, h, rot, anchor)
        placed.append((bb[0], bb[1], bb[2], bb[3], side))
        for sg in F.strokes(s, x, y, h, rot, anchor, mirror=(side == 'B')): silk[side].append((sg[0], sg[1], sg[2], sg[3], w))
        texts.append(dict(side=side, text=s, x=x, y=y, h=h, rot=rot, anchor=anchor, bbox=bb))
    def try_put(side, s, cands, own=None, h=TH, note=''):
        for relax in (0, 1, 2):
            for (x, y, rot, anchor, inside) in cands:
                bb = F.bbox(s, x, y, h, rot, anchor)
                if free(bb, side, own=own, check_courts=(not inside and relax < 1), soft_vias=(relax < 2)):
                    put(side, s, x, y, h, rot, anchor)
                    if relax: report['fallback'].append(f'{s}: {"поверх переходного (закрыто маской)" if relax == 2 else "в габарите соседней детали"}')
                    if relax == 2: report['via_overlaps'] += 1
                    return True
        report['fallback'].append(f'{s}: НЕ РАЗМЕЩЕНО {note}')
        return False

    # ── фиксированные надписи
    put('T', B.NAME, 21.0, 20.0, 1.8, w=0.25); put('T', f'{B.REV.upper()}  {B.DATE}', 21.0, 23.2, 1.4, w=0.2)
    hv = [c for c in comps if c['ref'] in ('Q1', 'Q2')]
    xm = (hv[0]['x'] + hv[1]['x']) / 2
    put('T', 'ДО 400 В', xm, hv[0]['y'] + 0.9, 1.5, rot=90, w=0.22)
    put('T', '! HV !', xm, 73.4, 1.2, w=0.2)
    put('B', 'ДО 400 В', xm, hv[0]['y'] + 0.9, 1.5, rot=90, w=0.22)
    put('B', f'{B.NAME} {B.REV.upper()}', 21.0, 20.0, 1.5, w=0.2)
    # Blue Pill
    a1 = next(c for c in comps if c['ref'] == 'A1')
    put('T', 'A1 BLUE PILL STM32F103C6', a1['x'], a1['y'] - 1.0, 1.3, w=0.18)
    put('T', 'СТАВИТЬ ПО НАДПИСЯМ КОНТАКТОВ', a1['x'], a1['y'] + 1.2, 1.0)
    for p in a1['pads']:
        up = p['name'].startswith('JL')
        s = MCU[p['name']]
        x, y = p['x'], p['y'] + (1.75 if up else -1.75)
        bb = F.bbox(s, x, y, TH, 90, 'r' if up else 'l')
        put('T', s, x, y, TH, 90, 'r' if up else 'l')
    # LM2596
    a5 = next(c for c in comps if c['ref'] == 'A5')
    put('T', 'A5 LM2596', a5['x'] + 1.0, a5['y'] - 3, 1.3, rot=90, w=0.18); put('T', '5.00 V', a5['x'] + 3.4, a5['y'] - 3, 1.2, rot=90, w=0.18)
    for p in a5['pads']:
        s = PIN_LABELS['A5'][p['name']]
        put('T', s, p['x'], p['y'] + (2.6 if p['y'] < a5['y'] else -2.6), TH)
    # клеммники: подписи у кромки
    for c in comps:
        if c['pkg'].startswith('TERM'):
            for p in c['pads']: put('T', PIN_LABELS[c['ref']][p['name']], p['x'], p['y'] + 5.75, TH)
    # JST: подписи контактов под корпусом, название — у кромки
    for c in comps:
        if c['pkg'].startswith('JST'):
            for p in c['pads']: put('T', PIN_LABELS[c['ref']][p['name']], p['x'], c['court'][3] + 0.85, TH)
            put('T', CONN_NAME[c['ref']], (c['court'][0] + c['court'][2]) / 2, 1.25, TH)
        if c['ref'] == 'A2':
            for p in c['pads']: put('T', PIN_LABELS['A2'][p['name']], p['x'] + 1.75, p['y'], TH, anchor='l')
            put('T', 'HC-06', 5.0, 27.6, TH, anchor='l')
    # ── позиционные обозначения
    for c in sorted(comps, key=lambda c: (c['court'][2] - c['court'][0]) * (c['court'][3] - c['court'][1])):
        ref = c['ref']; s = REF_TEXT.get(ref, ref)
        if ref in ('A1', 'A5'): continue
        x0, y0, x1, y1 = c['court']; cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        w = F.text_width(s, TH)
        cands = []
        horiz = (x1 - x0) >= (y1 - y0)
        if c['pkg'] in ('R_AXIAL_10.16', 'DO-41_10.16', 'DO-201AD_15.24', 'C_DISC_5.08'):
            off = 0.75 if c['pkg'].startswith('DO-41') else (0.6 if c['pkg'].startswith('DO-201') else 0.0)
            ox, oy = B.xf(off, 0, c['rot'])     # у диодов — в сторону от полоски катода
            cands.append((c['x'] + ox, c['y'] + oy, 0 if horiz else 90, 'c', True))
        if c['pkg'] in ('TO-263-2',): cands.append((cx, y0 + 4.2, 0, 'c', True))
        if c['pkg'] == 'CDRH125': cands.append((cx, cy, 0, 'c', True))
        if c['pkg'] == 'DO-218AB': cands.append((x1 + 0.2 + 0.6, cy - 6, 90, 'c', False))
        if c['pkg'].startswith('TERM'): cands += [(cx, y0 - 0.8, 0, 'c', False), (cx, y0 - 2.2, 0, 'c', False)]
        g = 0.75
        for dd in (0, 0.6, 1.3, 2.2):
            cands += [(cx, y0 - g - dd, 0, 'c', False), (cx, y1 + g + dd, 0, 'c', False), (x1 + 0.3 + dd, cy, 0, 'l', False), (x0 - 0.3 - dd, cy, 0, 'r', False),
                      (x1 + g + dd, cy, 90, 'c', False), (x0 - g - dd, cy, 90, 'c', False),
                      (x0 + w / 2, y0 - g - dd, 0, 'c', False), (x1 - w / 2, y0 - g - dd, 0, 'c', False), (x0 + w / 2, y1 + g + dd, 0, 'c', False), (x1 - w / 2, y1 + g + dd, 0, 'c', False)]
        try_put('T', s, cands, own=ref)
    d['silk'] = silk; d['texts'] = texts; d['silk_report'] = report
    return d

if __name__ == '__main__':
    d = build(load())
    json.dump(d, open(os.path.join(B.HERE, 'design.json'), 'w'))
    print('шелк: отрезков сверху', len(d['silk']['T']), 'снизу', len(d['silk']['B']), '; надписей', len(d['texts']))
    for f in d['silk_report']['fallback']: print('  ', f)
