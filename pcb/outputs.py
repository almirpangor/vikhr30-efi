# -*- coding: utf-8 -*-
"""Выходные файлы: Gerber RS-274X, Excellon, KiCad 7, BOM, placement, pads.csv (для независимой проверки)."""
import json, os, csv, uuid, zipfile, re
import board as B, svgout

OUT = os.path.join(B.HERE, 'out')
BASE = 'vikhr30-efi'
def load(): return json.load(open(os.path.join(B.HERE, 'design.json')))

# ───────────────────────── Gerber
class Gerber:
    def __init__(self, H, func, polarity='Positive'):
        self.H = H; self.ap = {}; self.body = []; self.cur = None
        self.head = ['%TF.GenerationSoftware,Vikhr30,pcbgen,1.0*%', '%TF.CreationDate,2026-10-04T00:00:00+05:00*%', f'%TF.ProjectId,{BASE},56494b48-5233-4045-8649-303030303041,A*%',
                     '%TF.SameCoordinates,Original*%', f'%TF.FileFunction,{func}*%', f'%TF.FilePolarity,{polarity}*%', '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%']
    def c(self, x, y): return f'X{int(round(x * 1e6))}Y{int(round((self.H - y) * 1e6))}'
    def aper(self, kind, *dims):
        key = (kind,) + tuple(round(v, 4) for v in dims)
        if key not in self.ap: self.ap[key] = 10 + len(self.ap)
        n = self.ap[key]
        if self.cur != n: self.body.append(f'D{n}*'); self.cur = n
    def flash_pad(self, p, grow=0.0):
        w, h = p['w'] + 2 * grow, p['h'] + 2 * grow
        if p['shape'] == 'c': self.aper('C', w)
        elif p['shape'] == 'r': self.aper('R', w, h)
        else: self.aper('O', w, h)
        self.body.append(self.c(p['x'], p['y']) + 'D03*')
    def flash_c(self, x, y, dia): self.aper('C', dia); self.body.append(self.c(x, y) + 'D03*')
    def line(self, x1, y1, x2, y2, w):
        self.aper('C', w); self.body.append(self.c(x1, y1) + 'D02*'); self.body.append(self.c(x2, y2) + 'D01*')
    def region(self, pts):
        self.body.append('G36*'); self.body.append(self.c(*pts[0]) + 'D02*')
        for p in pts[1:]: self.body.append(self.c(*p) + 'D01*')
        self.body.append(self.c(*pts[0]) + 'D01*'); self.body.append('G37*')
    def text(self):
        ad = []
        for key, n in sorted(self.ap.items(), key=lambda kv: kv[1]):
            if key[0] == 'C': ad.append(f'%ADD{n}C,{key[1]:.4f}*%')
            else: ad.append(f'%ADD{n}{key[0]},{key[1]:.4f}X{key[2]:.4f}*%')
        return '\n'.join(self.head + ad + ['G01*', 'G75*'] + self.body + ['M02*']) + '\n'

def gerbers(d):
    H = d['H']; files = {}
    for L, name, func in (('T', 'F_Cu', 'Copper,L1,Top'), ('B', 'B_Cu', 'Copper,L2,Bot')):
        g = Gerber(H, func)
        for poly in d['pour'][L]: g.region(poly)
        for (l, net, x0, y0, x1, y1) in d['polys']:
            if l == L: g.region([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
        for (l, net, x1, y1, x2, y2, w) in d['tracks']:
            if l == L: g.line(x1, y1, x2, y2, w)
        for c in d['comps']:
            for p in c['pads']:
                if L == 'T' or p['layers'] == 'TB': g.flash_pad(p)
        for (x, y, dia, dr, net) in d['vias']: g.flash_c(x, y, dia)
        files[name] = g.text()
    for L, name, func in (('T', 'F_Mask', 'Soldermask,Top'), ('B', 'B_Mask', 'Soldermask,Bot')):
        g = Gerber(H, func, 'Negative')
        for c in d['comps']:
            for p in c['pads']:
                if p['layers'] == 'T0': continue
                if L == 'T' or p['layers'] == 'TB': g.flash_pad(p, B.MASK_EXP)
        for (x, y, dd) in d['npth']: g.flash_c(x, y, dd + 0.2)
        files[name] = g.text()
    g = Gerber(H, 'Paste,Top')
    for c in d['comps']:
        for p in c['pads']:
            if not p['drill'] and p['layers'] == 'T': g.flash_pad(p)
    files['F_Paste'] = g.text()
    for L, name, func in (('T', 'F_Silkscreen', 'Legend,Top'), ('B', 'B_Silkscreen', 'Legend,Bot')):
        g = Gerber(H, func)
        for (x1, y1, x2, y2, w) in d['silk'][L]: g.line(x1, y1, x2, y2, w)
        files[name] = g.text()
    g = Gerber(H, 'Profile,NP')
    W = d['W']
    for a, b_ in (((0, 0), (W, 0)), ((W, 0), (W, H)), ((W, H), (0, H)), ((0, H), (0, 0))): g.line(a[0], a[1], b_[0], b_[1], 0.1)
    files['Edge_Cuts'] = g.text()
    return files

def excellon(d):
    H = d['H']
    pth = [(p['x'], p['y'], p['drill']) for c in d['comps'] for p in c['pads'] if p['drill']] + [(v[0], v[1], v[3]) for v in d['vias']]
    npth = [(x, y, dd) for x, y, dd in d['npth']]
    out = {}
    for name, holes, plated in (('PTH', pth, True), ('NPTH', npth, False)):
        tools = sorted(set(round(h[2], 3) for h in holes))
        o = ['M48', f'; {B.NAME} {B.REV} - {"plated" if plated else "non-plated"} holes', '; FORMAT={-:-/ absolute / metric / decimal}',
             f'; #@! TF.FileFunction,{"Plated,1,2,PTH" if plated else "NonPlated,1,2,NPTH"}', 'FMAT,2', 'METRIC']
        for i, t in enumerate(tools): o.append(f'T{i + 1}C{t:.3f}')
        o += ['%', 'G90', 'G05']
        for i, t in enumerate(tools):
            o.append(f'T{i + 1}')
            for h in holes:
                if round(h[2], 3) == t: o.append(f'X{h[0]:.4f}Y{H - h[1]:.4f}')
        o += ['T0', 'M30']
        out[name] = ('\n'.join(o) + '\n', {t: sum(1 for h in holes if round(h[2], 3) == t) for t in tools})
    return out

# ───────────────────────── KiCad
NETNAME = {'V12': '+12V_PROT', 'V5': '+5V_ECU', 'V5S': '+5V_SENS', 'V33': '+3V3', 'F2': '+12V_F2', 'BAT': 'BAT+', 'COIL1': 'COIL1-', 'COIL2': 'COIL2-', 'G1': 'IGN1_GATE', 'G2': 'IGN2_GATE',
           'INJ': 'INJ-', 'HEAT': 'HEATER-', 'RELAY': 'RELAY-'}
def kn(net): return NETNAME.get(net, net)
def f(v):
    s = f'{v:.4f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s
_uid = [0]
def ts():
    _uid[0] += 1
    return f'(tstamp {uuid.uuid5(uuid.NAMESPACE_DNS, "vikhr30-efi-" + str(_uid[0]))})'
def q(s): return '"' + str(s).replace('\\', '\\\\').replace('"', "'") + '"'

def kicad(d):
    nets = ['GND'] + sorted({p['net'] for c in d['comps'] for p in c['pads'] if p['net'] and p['net'] != 'GND'})
    nid = {n: i + 1 for i, n in enumerate(nets)}
    o = ['(kicad_pcb (version 20221018) (generator pcbnew)', '  (general (thickness 1.6))', '  (paper "A4")',
         f'  (title_block (title {q(B.NAME)}) (date {q(B.DATE)}) (rev "A") (comment 1 "Generated by script; never opened in KiCad, KiCad DRC not run"))',
         '  (layers', '    (0 "F.Cu" signal)', '    (31 "B.Cu" signal)', '    (32 "B.Adhes" user "B.Adhesive")', '    (33 "F.Adhes" user "F.Adhesive")', '    (34 "B.Paste" user)', '    (35 "F.Paste" user)',
         '    (36 "B.SilkS" user "B.Silkscreen")', '    (37 "F.SilkS" user "F.Silkscreen")', '    (38 "B.Mask" user)', '    (39 "F.Mask" user)', '    (40 "Dwgs.User" user "User.Drawings")',
         '    (41 "Cmts.User" user "User.Comments")', '    (42 "Eco1.User" user "User.Eco1")', '    (43 "Eco2.User" user "User.Eco2")', '    (44 "Edge.Cuts" user)', '    (45 "Margin" user)',
         '    (46 "B.CrtYd" user "B.Courtyard")', '    (47 "F.CrtYd" user "F.Courtyard")', '    (48 "B.Fab" user)', '    (49 "F.Fab" user)', '  )',
         f'  (setup (pad_to_mask_clearance {f(B.MASK_EXP)}))', '  (net 0 "")']
    for n in nets: o.append(f'  (net {nid[n]} {q(kn(n))})')
    for c in d['comps']:
        x0, y0 = c['x'], c['y']
        attr = 'smd' if c['smd'] else 'through_hole'
        o.append(f'  (footprint {q("vikhr30:" + c["pkg"])} (layer "F.Cu") {ts()} (at {f(x0)} {f(y0)})')
        o.append(f'    (descr {q(c["value"])}) (attr {attr})')
        ct = c['court']; cx, cy = (ct[0] + ct[2]) / 2 - x0, (ct[1] + ct[3]) / 2 - y0
        o.append(f'    (fp_text reference {q(c["ref"])} (at {f(cx)} {f(cy)}) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))) {ts()})')
        o.append(f'    (fp_text value {q(c["value"])} (at {f(cx)} {f(cy + 1.5)}) (layer "F.Fab") hide (effects (font (size 1 1) (thickness 0.15))) {ts()})')
        for (x1, y1, x2, y2) in c['fab']:
            o.append(f'    (fp_line (start {f(x1 - x0)} {f(y1 - y0)}) (end {f(x2 - x0)} {f(y2 - y0)}) (stroke (width 0.1) (type solid)) (layer "F.Fab") {ts()})')
        for (a, b_) in (((ct[0], ct[1]), (ct[2], ct[1])), ((ct[2], ct[1]), (ct[2], ct[3])), ((ct[2], ct[3]), (ct[0], ct[3])), ((ct[0], ct[3]), (ct[0], ct[1]))):
            o.append(f'    (fp_line (start {f(a[0] - x0)} {f(a[1] - y0)}) (end {f(b_[0] - x0)} {f(b_[1] - y0)}) (stroke (width 0.05) (type solid)) (layer "F.CrtYd") {ts()})')
        for p in c['pads']:
            net = f' (net {nid[p["net"]]} {q(kn(p["net"]))})' if p['net'] else ''
            shape = {'c': 'circle', 'r': 'rect', 'o': 'oval'}[p['shape']]
            if p['drill']:
                o.append(f'    (pad {q(p["name"])} thru_hole {shape} (at {f(p["x"] - x0)} {f(p["y"] - y0)}) (size {f(p["w"])} {f(p["h"])}) (drill {f(p["drill"])}) (layers "*.Cu" "*.Mask"){net} {ts()})')
            else:
                layers = '"F.Cu"' if p['layers'] == 'T0' else '"F.Cu" "F.Paste" "F.Mask"'
                o.append(f'    (pad {q(p["name"])} smd {shape} (at {f(p["x"] - x0)} {f(p["y"] - y0)}) (size {f(p["w"])} {f(p["h"])}) (layers {layers}){net} {ts()})')
        for (x, y, dd) in c['npth']:
            o.append(f'    (pad "" np_thru_hole circle (at {f(x - x0)} {f(y - y0)}) (size {f(dd)} {f(dd)}) (drill {f(dd)}) (layers "*.Cu" "*.Mask") {ts()})')
        o.append('  )')
    for i, (x, y) in enumerate(B.MOUNT):
        o.append(f'  (footprint "vikhr30:MountingHole_3.2mm_M3" (layer "F.Cu") {ts()} (at {f(x)} {f(y)})')
        o.append(f'    (attr exclude_from_pos_files exclude_from_bom)')
        o.append(f'    (fp_text reference {q("H" + str(i + 1))} (at 0 -4) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))) {ts()})')
        o.append(f'    (fp_text value "M3" (at 0 4) (layer "F.Fab") hide (effects (font (size 1 1) (thickness 0.15))) {ts()})')
        o.append(f'    (fp_circle (center 0 0) (end {f(B.MOUNT_ZONE / 2)} 0) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd") {ts()})')
        o.append(f'    (pad "" np_thru_hole circle (at 0 0) (size {f(B.MOUNT_D)} {f(B.MOUNT_D)}) (drill {f(B.MOUNT_D)}) (layers "*.Cu" "*.Mask") {ts()})')
        o.append('  )')
    W, H = d['W'], d['H']
    for a, b_ in (((0, 0), (W, 0)), ((W, 0), (W, H)), ((W, H), (0, H)), ((0, H), (0, 0))):
        o.append(f'  (gr_line (start {f(a[0])} {f(a[1])}) (end {f(b_[0])} {f(b_[1])}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") {ts()})')
    for L, lay in (('T', 'F.SilkS'), ('B', 'B.SilkS')):
        for (x1, y1, x2, y2, w) in d['silk'][L]:
            o.append(f'  (gr_line (start {f(x1)} {f(y1)}) (end {f(x2)} {f(y2)}) (stroke (width {f(w)}) (type solid)) (layer {q(lay)}) {ts()})')
    o.append(f'  (gr_text {q(B.NAME + " " + B.REV + " " + B.DATE)} (at {f(W / 2)} {f(H + 4)}) (layer "Cmts.User") (effects (font (size 1.5 1.5) (thickness 0.2))) {ts()})')
    lay = {'T': 'F.Cu', 'B': 'B.Cu'}
    for (L, net, x1, y1, x2, y2, w) in d['tracks']:
        o.append(f'  (segment (start {f(x1)} {f(y1)}) (end {f(x2)} {f(y2)}) (width {f(w)}) (layer {q(lay[L])}) (net {nid[net]}) {ts()})')
    for (x, y, dia, dr, net) in d['vias']:
        o.append(f'  (via (at {f(x)} {f(y)}) (size {f(dia)}) (drill {f(dr)}) (layers "F.Cu" "B.Cu") (net {nid[net]}) {ts()})')
    def pts(poly): return '(pts ' + ' '.join(f'(xy {f(x)} {f(y)})' for x, y in poly) + ')'
    for (L, net, x0, y0, x1, y1) in d['polys']:
        r = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        o.append(f'  (zone (net {nid[net]}) (net_name {q(kn(net))}) (layer {q(lay[L])}) {ts()} (name {q("HV_" + net + "_" + L)}) (hatch edge 0.508) (priority 1)')
        o.append('    (connect_pads yes (clearance 0.3)) (min_thickness 0.3) (filled_areas_thickness no)')
        o.append('    (fill yes (thermal_gap 0.4) (thermal_bridge_width 0.6))')
        o.append(f'    (polygon {pts(r)})'); o.append(f'    (filled_polygon (layer {q(lay[L])}) {pts(r)})'); o.append('  )')
    for L in 'TB':
        m = B.EDGE + 0.05
        r = [(m, m), (W - m, m), (W - m, H - m), (m, H - m)]
        o.append(f'  (zone (net {nid["GND"]}) (net_name "GND") (layer {q(lay[L])}) {ts()} (name {q("GND_" + L)}) (hatch edge 0.508)')
        o.append('    (connect_pads (clearance 0.45)) (min_thickness 0.3) (filled_areas_thickness no)')
        o.append('    (fill yes (thermal_gap 0.4) (thermal_bridge_width 0.6))')
        o.append(f'    (polygon {pts(r)})')
        for poly in d['pour'][L]: o.append(f'    (filled_polygon (layer {q(lay[L])}) {pts(poly)})')
        o.append('  )')
    o.append(')')
    txt = '\n'.join(o) + '\n'
    # самопроверка синтаксиса: баланс скобок вне строк и разбор S-выражений
    depth = 0; instr = False; esc = False; maxd = 0
    for ch in txt:
        if instr:
            if esc: esc = False
            elif ch == '\\': esc = True
            elif ch == '"': instr = False
        elif ch == '"': instr = True
        elif ch == '(': depth += 1; maxd = max(maxd, depth)
        elif ch == ')':
            depth -= 1
            assert depth >= 0, 'лишняя закрывающая скобка'
    assert depth == 0 and not instr, 'скобки не сбалансированы'
    stats = dict(nets=len(nets), footprints=txt.count('(footprint '), pads=txt.count('(pad '), segments=txt.count('(segment '), vias=txt.count('(via '), zones=txt.count('(zone '), filled=txt.count('(filled_polygon '), gr_lines=txt.count('(gr_line '), bytes=len(txt.encode('utf-8')))
    dru = '\n'.join(['(version 1)', '# Правила, повторяющие проектные: подключить в KiCad (Файл → Параметры платы → Пользовательские правила)',
                     '(rule "HV_coil_clearance"', '  (condition "A.NetName == \'COIL1-\' || A.NetName == \'COIL2-\'")', '  (constraint clearance (min 2.5mm)))',
                     '(rule "min_clearance"', '  (constraint clearance (min 0.3mm)))', '(rule "min_track"', '  (constraint track_width (min 0.3mm)))',
                     '(rule "edge"', '  (constraint edge_clearance (min 0.5mm)))', '']) 
    return txt, dru, stats

def bom_and_placement(d):
    groups = {}
    for c in d['comps']:
        val = 'Клеммник 4 конт. 5,08 (на схеме — JST XH 4 конт.)' if c['ref'] == 'X15' else c['value']
        k = (val, c['pkg'], ('Клеммник разъёмный 5,08 мм — 2 шт. по 2 контакта или один на 4' if c['ref'] == 'X15' else c.get('bom') or ''), ('' if c['ref'] == 'X15' else c.get('url') or ''))
        groups.setdefault(k, []).append(c['ref'])
    nat = lambda s: [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', s)]
    with open(os.path.join(OUT, 'bom.csv'), 'w', newline='', encoding='utf-8-sig') as fh:
        w = csv.writer(fh, delimiter=';')
        w.writerow(['Обозначение', 'Номинал / тип', 'Корпус (посадочное место)', 'Кол-во', 'Что купить (строка перечня программы)', 'Ссылка магазина'])
        for k, refs in sorted(groups.items(), key=lambda kv: nat(sorted(kv[1], key=nat)[0])):
            w.writerow([', '.join(sorted(refs, key=nat)), k[0], k[1], len(refs), k[2], k[3]])
        w.writerow(['—', 'Гнездо PBS-1x20 под A1', 'в посадочном месте A1', 2, 'Гнездо PBS-1x20 (или 2 × 1x10), 2,54 мм', 'https://magazin-elektronika.ru/74-61-86'])
        w.writerow(['—', 'Гнездо PBS-1x6 под A2 (HC-06)', 'HDR_1x6', 1, 'из линейки PBS, 2,54 мм', ''])
        w.writerow(['—', 'Стойки М3 для модуля A5 и крепежа платы', '', 6, '', ''])
    with open(os.path.join(OUT, 'placement.csv'), 'w', newline='', encoding='utf-8-sig') as fh:
        w = csv.writer(fh, delimiter=';')
        w.writerow(['Ref', 'Value', 'Package', 'X_mm', 'Y_mm', 'Rotation_deg', 'Side', 'примечание: начало координат — левый нижний угол платы, Y вверх (как в Gerber); поворот против часовой, вид сверху'])
        for c in sorted(d['comps'], key=lambda c: nat(c['ref'])):
            if c['smd']: w.writerow([c['ref'], c['value'], c['pkg'], f'{c["x"]:.3f}', f'{d["H"] - c["y"]:.3f}', c['rot'], 'top', ''])
    with open(os.path.join(OUT, 'pads.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh, delimiter=';')
        w.writerow(['ref', 'pin', 'x_mm', 'y_mm', 'type', 'net'])
        for c in d['comps']:
            for p in c['pads']:
                if p['layers'] == 'T0': continue
                w.writerow([c['ref'], p['name'], f'{p["x"]:.4f}', f'{d["H"] - p["y"]:.4f}', 'TH' if p['drill'] else 'SMD_TOP', p['net'] or ''])
    return len(groups)

def main():
    d = load(); os.makedirs(OUT, exist_ok=True)
    files = gerbers(d); names = []
    for n, t in files.items():
        fn = f'{BASE}-{n}.gbr'; open(os.path.join(OUT, fn), 'w').write(t); names.append(fn)
    ex = excellon(d)
    for n, (t, tools) in ex.items():
        fn = f'{BASE}-{n}.drl'; open(os.path.join(OUT, fn), 'w', encoding='utf-8').write(t); names.append(fn)
        print(f'  сверловка {n}:', ', '.join(f'⌀{k} × {v}' for k, v in tools.items()))
    with zipfile.ZipFile(os.path.join(OUT, f'{BASE}-gerber.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for fn in names: z.write(os.path.join(OUT, fn), fn)
    txt, dru, st = kicad(d)
    open(os.path.join(OUT, f'{BASE}.kicad_pcb'), 'w', encoding='utf-8').write(txt)
    open(os.path.join(OUT, f'{BASE}.kicad_dru'), 'w', encoding='utf-8').write(dru)
    print('  KiCad:', st)
    n = bom_and_placement(d)
    print(f'  BOM: строк {n}; Gerber-файлов {len(files)}')
    json.dump(dict(kicad=st, drills={k: v[1] for k, v in ex.items()}), open(os.path.join(B.HERE, 'out_stats.json'), 'w'))

if __name__ == '__main__': main()
