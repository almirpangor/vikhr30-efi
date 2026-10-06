# -*- coding: utf-8 -*-
"""C. НЕЗАВИСИМАЯ проверка по готовым файлам для завода.
Не использует внутренние структуры проекта: читает только out/*.gbr, out/*.drl, out/pads.csv (координаты выводов) и netlist.json (какой вывод в какой цепи).
Собственный разбор RS-274X (апертуры C/R/O, D01/D02/D03, G36/G37, LPD/LPC) и Excellon; растеризация меди с шагом 0,025 мм; связные области; соединение слоёв
через металлизированные отверстия; сравнение с netlist; измерение зазоров по растру."""
import csv, json, math, os, re, sys, time
import numpy as np
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS = None

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.environ.get('GERB_DIR', os.path.join(HERE, 'out')); BASE = 'vikhr30-efi'
STEP = 0.025
RULE, RULE_HV, RULE_EDGE = 0.30, 2.50, 0.50
HV = {'COIL1', 'COIL2'}

def parse_gerber(path):
    """→ список примитивов: ('flash', pol, x, y, ap) | ('draw', pol, x1, y1, x2, y2, ap) | ('region', pol, [(x, y)...]); ap = ('C', d) | ('R', w, h) | ('O', w, h)."""
    txt = open(path).read()
    aps = {}; prims = []; scale = None; unit = None
    x = y = 0.0; cur = None; pol = 'D'; region = False; contour = []; interp = 1
    for blk in re.findall(r'%[^%]*%|[^%*]+\*', txt):
        blk = blk.strip()
        if blk.startswith('%'):
            for cmd in blk.strip('%').split('*'):
                cmd = cmd.strip()
                if not cmd: continue
                if cmd.startswith('FS'):
                    m = re.match(r'FSLAX(\d)(\d)Y(\d)(\d)', cmd); assert m, cmd; scale = 10 ** int(m.group(2))
                elif cmd.startswith('MO'): unit = cmd[2:4]; assert unit == 'MM'
                elif cmd.startswith('AD'):
                    m = re.match(r'ADD(\d+)([CRO]),([\d.X]+)', cmd); assert m, 'неподдерживаемая апертура ' + cmd
                    v = [float(t) for t in m.group(3).split('X')]
                    aps[int(m.group(1))] = (m.group(2),) + tuple(v)
                elif cmd.startswith('LP'): pol = cmd[2]
                elif cmd.startswith('TF') or cmd.startswith('TA') or cmd.startswith('TO') or cmd.startswith('TD'): pass
                else: raise ValueError('неподдерживаемая команда %' + cmd)
            continue
        cmd = blk.rstrip('*').strip()
        if not cmd: continue
        if cmd in ('G01', 'G1'): interp = 1; continue
        if cmd in ('G02', 'G03', 'G2', 'G3'): raise ValueError('дуги не поддерживаются проверяющим')
        if cmd in ('G75', 'G74'): continue
        if cmd == 'G36': region = True; contour = []; continue
        if cmd == 'G37':
            if len(contour) >= 3: prims.append(('region', pol, contour))
            region = False; contour = []; continue
        if cmd in ('M02', 'M00'): break
        m = re.fullmatch(r'D(\d+)', cmd)
        if m and int(m.group(1)) >= 10: cur = int(m.group(1)); continue
        m = re.fullmatch(r'(?:G0?1)?(?:X(-?\d+))?(?:Y(-?\d+))?(D0?[123])?', cmd)
        if not m: raise ValueError('непонятная команда: ' + cmd)
        nx = int(m.group(1)) / scale if m.group(1) is not None else x
        ny = int(m.group(2)) / scale if m.group(2) is not None else y
        op = int(m.group(3)[1:]) if m.group(3) else 1
        if region:
            if op == 2:
                if len(contour) >= 3: prims.append(('region', pol, contour))
                contour = [(nx, ny)]
            else: contour.append((nx, ny))
        else:
            if op == 1: prims.append(('draw', pol, x, y, nx, ny, aps[cur]))
            elif op == 3: prims.append(('flash', pol, nx, ny, aps[cur]))
        x, y = nx, ny
    return prims, aps

def parse_drill(path):
    tools = {}; holes = []; cur = None; metric = False
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith(';'): continue
        if line.startswith('METRIC'): metric = True; continue
        m = re.fullmatch(r'T(\d+)C([\d.]+)', line)
        if m: tools[int(m.group(1))] = float(m.group(2)); continue
        m = re.fullmatch(r'T(\d+)', line)
        if m: cur = int(m.group(1)); continue
        m = re.fullmatch(r'X(-?[\d.]+)Y(-?[\d.]+)', line)
        if m:
            assert '.' in m.group(1) and '.' in m.group(2), 'ожидались десятичные координаты'
            holes.append((float(m.group(1)), float(m.group(2)), tools[cur]))
    assert metric
    return holes, tools

class Raster:
    def __init__(self, W, H):
        self.W, self.H = W, H; self.nx = int(round(W / STEP)); self.ny = int(round(H / STEP))
        self.img = Image.new('L', (self.nx, self.ny), 0); self.dr = ImageDraw.Draw(self.img)
    def px(self, x, y): return (x / STEP - 0.5, (self.H - y) / STEP - 0.5)
    def circle(self, x, y, d, v):
        cx, cy = self.px(x, y); r = max(0.0, d / 2 / STEP - 0.5)      # PIL закрашивает границу включительно — компенсация полпикселя
        self.dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=v)
    def rect(self, x, y, w, h, v):
        cx, cy = self.px(x, y); self.dr.rectangle([cx - w / 2 / STEP + 0.5, cy - h / 2 / STEP + 0.5, cx + w / 2 / STEP - 0.5, cy + h / 2 / STEP - 0.5], fill=v)
    def thick(self, x1, y1, x2, y2, d, v):
        self.circle(x1, y1, d, v); self.circle(x2, y2, d, v)
        L = math.hypot(x2 - x1, y2 - y1)
        if L < 1e-9: return
        ux, uy = (x2 - x1) / L, (y2 - y1) / L; hw = max(0.0, d / 2 - 0.5 * STEP); px_, py_ = -uy * hw, ux * hw
        self.dr.polygon([self.px(x1 + px_, y1 + py_), self.px(x2 + px_, y2 + py_), self.px(x2 - px_, y2 - py_), self.px(x1 - px_, y1 - py_)], fill=v)
    def render(self, prims):
        for p in prims:
            v = 255 if p[1] == 'D' else 0
            if p[0] == 'region': self.dr.polygon([self.px(x, y) for x, y in p[2]], fill=v)
            elif p[0] == 'flash':
                ap = p[4]
                if ap[0] == 'C': self.circle(p[2], p[3], ap[1], v)
                elif ap[0] == 'R': self.rect(p[2], p[3], ap[1], ap[2], v)
                else:
                    w, h = ap[1], ap[2]
                    if w >= h: self.thick(p[2] - (w - h) / 2, p[3], p[2] + (w - h) / 2, p[3], h, v)
                    else: self.thick(p[2], p[3] - (h - w) / 2, p[2], p[3] + (h - w) / 2, w, v)
            else:
                ap = p[6]; assert ap[0] == 'C', 'линии только круглой апертурой'
                self.thick(p[2], p[3], p[4], p[5], ap[1], v)
        return np.array(self.img) > 0
    def at(self, x, y): return (min(self.ny - 1, max(0, int((self.H - y) / STEP))), min(self.nx - 1, max(0, int(x / STEP))))

def label(m):
    d = np.diff(np.pad(m, ((0, 0), (1, 1))).astype(np.int8), axis=1)
    sr, sc = np.nonzero(d == 1); er, ec = np.nonzero(d == -1)
    n = len(sr); par = list(range(n))
    def find(a):
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    rs = np.searchsorted(sr, np.arange(m.shape[0] + 1)); scl, ecl = sc.tolist(), ec.tolist()
    for r in range(1, m.shape[0]):
        a, a1 = int(rs[r]), int(rs[r + 1]); b, b1 = int(rs[r - 1]), int(rs[r])
        while a < a1 and b < b1:
            if scl[a] < ecl[b] and scl[b] < ecl[a]:
                ra, rb = find(a), find(b)
                if ra != rb: par[ra] = rb
            if ecl[a] < ecl[b]: a += 1
            else: b += 1
    roots = {}; lab = np.zeros(m.shape, np.int32); srl = sr.tolist()
    for i in range(n):
        k = roots.setdefault(find(i), len(roots) + 1)
        lab[srl[i], scl[i]:ecl[i]] = k
    return lab, len(roots)

def main():
    t0 = time.time(); R = []; fails = 0
    edge, _ = parse_gerber(os.path.join(OUT, f'{BASE}-Edge_Cuts.gbr'))
    xs = [v for p in edge for v in (p[2], p[4])]; ys = [v for p in edge for v in (p[3], p[5])]
    assert abs(min(xs)) < 1e-6 and abs(min(ys)) < 1e-6, 'контур платы не от нуля'
    W, H = max(xs), max(ys)
    R.append(f'C. Независимая проверка по файлам для завода (растр {STEP} мм, собственный разбор Gerber/Excellon)')
    R.append(f'   Контур платы по Edge_Cuts: {W:.2f} × {H:.2f} мм; отрезков контура {len(edge)}')
    cu = {}; stat = {}
    for L, name in (('T', 'F_Cu'), ('B', 'B_Cu')):
        prims, aps = parse_gerber(os.path.join(OUT, f'{BASE}-{name}.gbr'))
        stat[L] = dict(regions=sum(1 for p in prims if p[0] == 'region'), draws=sum(1 for p in prims if p[0] == 'draw'), flashes=sum(1 for p in prims if p[0] == 'flash'), aps=len(aps))
        cu[L] = Raster(W, H); cu[L].mask = cu[L].render(prims)
        R.append(f'   {name}: апертур {len(aps)}, областей G36 {stat[L]["regions"]}, линий {stat[L]["draws"]}, вспышек {stat[L]["flashes"]}; меди {cu[L].mask.sum() * STEP * STEP / 100:.1f} см² ({cu[L].mask.mean() * 100:.0f} % площади)')
    pth, tp = parse_drill(os.path.join(OUT, f'{BASE}-PTH.drl')); npth, tn = parse_drill(os.path.join(OUT, f'{BASE}-NPTH.drl'))
    R.append(f'   Сверловка: металлизированных {len(pth)} (инструменты {", ".join(f"{d:g}" for d in sorted(set(tp.values())))} мм), неметаллизированных {len(npth)} ({", ".join(f"{d:g}" for d in sorted(set(tn.values())))} мм)')
    lab = {}; ncomp = {}
    for L in 'TB': lab[L], ncomp[L] = label(cu[L].mask)
    par = {}
    def find(a):
        par.setdefault(a, a)
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    # отверстия соединяют слои; заодно проверяем поясок по растру
    noc = 0; ring_min = (9e9, None)
    for (x, y, dd) in pth:
        ks = []
        for L in 'TB':
            i, j = cu[L].at(x, y); k = int(lab[L][i, j])
            if k == 0: noc += 1; continue
            ks.append((L, k))
            # поясок по растру: расстояние от центра отверстия до ближайшего пикселя без меди
            w = int((dd / 2 + 0.8) / STEP)
            sub = cu[L].mask[max(0, i - w):i + w + 1, max(0, j - w):j + w + 1]
            ii, jj = np.nonzero(~sub)
            if len(ii):
                rr = float(np.sqrt((ii - min(i, w)) ** 2 + (jj - min(j, w)) ** 2).min())
                ring = (rr - 0.5) * STEP - dd / 2
                if ring < ring_min[0]: ring_min = (ring, (round(x, 2), round(y, 2), dd))
        if len(ks) == 2: par[find(ks[0])] = find(ks[1])
    R.append(f'   Металлизированные отверстия без меди на каком-либо слое: {noc}; минимальный поясок меди вокруг отверстия по растру: {ring_min[0]:.3f} мм (отверстие ⌀{ring_min[1][2]} в x={ring_min[1][0]}, y={ring_min[1][1]}; норма переходных ≥ 0,2, выводных ≥ 0,35; погрешность измерения ±{1.5 * STEP:.3f})')
    fails += noc + (1 if ring_min[0] < 0.2 - 1.5 * STEP else 0)
    # выводы
    pads = list(csv.DictReader(open(os.path.join(OUT, 'pads.csv'), encoding='utf-8'), delimiter=';'))
    nl = json.load(open(os.path.join(HERE, 'netlist.json'), encoding='utf-8'))
    want = {pin: n['id'] for n in nl['nets'] for pin in n['pins']}
    allpins = {f"{c['ref']}.{p}": net for c in nl['components'] for p, net in c['pins'].items()}
    root_pins = {}; nocopper = []; seen = set()
    for p in pads:
        key = f"{p['ref']}.{p['pin']}"; seen.add(key)
        x, y = float(p['x_mm']), float(p['y_mm'])
        i, j = cu['T'].at(x, y); k = int(lab['T'][i, j])
        if k == 0: nocopper.append(key); continue
        root_pins.setdefault(find(('T', k)), set()).add(key)
    missing = sorted(set(allpins) - seen)
    net_roots = {}; shorts = []; ncshort = []
    for r, pins in root_pins.items():
        nets = {want.get(k, 'NC:' + k) for k in pins}
        real = {n for n in nets if not n.startswith('NC:')}
        if len(real) > 1: shorts.append(sorted(real))
        if real and any(n.startswith('NC:') for n in nets): ncshort.append(sorted(nets))
        if not real and len(nets) > 1: ncshort.append(sorted(nets))
        for n in real: net_roots.setdefault(n, set()).add(r)
    opens = {n: len(v) for n, v in net_roots.items() if len(v) > 1}
    absent = [n['id'] for n in nl['nets'] if n['id'] not in net_roots]
    okn = len(nl['nets']) - len(opens) - len(absent)
    R.append(f'   Выводов в netlist: {len(allpins)} (в цепях {len(want)}, свободных {len(allpins) - len(want)}); найдено на меди: {len(seen) - len(nocopper)}; без меди под выводом: {len(nocopper)} {nocopper[:5] or ""}; нет координат: {len(missing)} {missing[:5] or ""}')
    R.append(f'   Цепей netlist: {len(nl["nets"])}; совпало (все выводы цепи в одной связной области меди и только они): {okn} из {len(nl["nets"])} = {okn / len(nl["nets"]) * 100:.0f} %')
    R.append(f'   Обрывов: {len(opens)} {opens or ""}; замыканий между цепями: {len(shorts)} {shorts or ""}; свободных выводов, соединённых с чем-либо: {len(ncshort)} {ncshort[:3] or ""}; отсутствующих цепей: {len(absent)}')
    fails += len(nocopper) + len(missing) + len(opens) + len(shorts) + len(ncshort) + len(absent)
    # карта цепей по растру
    names = ['GND'] + sorted(n for n in net_roots if n != 'GND'); nid = {n: i + 1 for i, n in enumerate(names)}
    root_net = {}
    for r, pins in root_pins.items():
        real = {want[k] for k in pins if k in want}
        root_net[r] = nid[sorted(real)[0]] if real else 200 + (len(root_net) % 50)
    netimg = {}; orphan = 0
    for L in 'TB':
        lut = np.zeros(ncomp[L] + 1, np.uint8)
        for k in range(1, ncomp[L] + 1):
            r = find((L, k))
            if r in root_net: lut[k] = root_net[r]
            else: lut[k] = 250; orphan += 1
        netimg[L] = lut[lab[L]]
    R.append(f'   Областей меди, не связанных ни с одним выводом (островки): {orphan}')
    fails += orphan
    # минимальный зазор между областями разных цепей: поиск по смещениям (обычные цепи)
    hvid = {nid[n] for n in HV if n in nid}
    rmax = int(0.45 / STEP)
    offs = sorted([(dy, dx) for dy in range(0, rmax + 1) for dx in range(-rmax, rmax + 1) if (dy > 0 or dx > 0) and dy * dy + dx * dx <= rmax * rmax], key=lambda o: o[0] ** 2 + o[1] ** 2)
    gmin = {}
    for L in 'TB':
        N = netimg[L].copy()
        for h in hvid: N[N == h] = 0          # ВВ-цепи меряем отдельно
        found = None
        ny, nx = N.shape
        for dy, dx in offs:
            a = N[dy:, max(0, dx):nx + min(0, dx)]; b = N[:ny - dy, max(0, -dx):nx - max(0, dx)]
            if ((a != b) & (a != 0) & (b != 0)).any():
                found = math.hypot(dy, dx); 
                ii, jj = np.nonzero((a != b) & (a != 0) & (b != 0)); n1 = int(a[ii[0], jj[0]]); n2 = int(b[ii[0], jj[0]])
                where = (round((jj[0] + max(0, dx)) * STEP, 2), round(H - (ii[0] + dy) * STEP, 2))
                break
        if found is None: gmin[L] = (None, '')
        else:
            nm = lambda k: names[k - 1] if k <= len(names) else 'своб. вывод'
            gmin[L] = (found, f'{nm(n1)} ↔ {nm(n2)} около x={where[0]}, y={where[1]} (коорд. Gerber)')
    for L, name in (('T', 'F_Cu'), ('B', 'B_Cu')):
        if gmin[L][0] is None: R.append(f'   {name}: между областями разных цепей нет пикселей ближе {rmax * STEP:.3f} мм (норма ≥ {RULE})')
        else:
            g = (gmin[L][0] - 1) * STEP
            R.append(f'   {name}: минимальный зазор между областями разных цепей ≈ {g:.3f} мм (расстояние между центрами пикселей {gmin[L][0] * STEP:.3f} мм минус пиксель; погрешность ±{STEP} мм; норма ≥ {RULE}) — {gmin[L][1]}')
            if g < RULE - STEP: fails += 1; R.append('   !!! зазор меньше нормы')
    # ВВ-цепи: расстояние от их меди до любой другой меди (прямой перебор граничных пикселей в окне)
    for L, name in (('T', 'F_Cu'), ('B', 'B_Cu')):
        N = netimg[L]
        for h in sorted(hvid):
            ii, jj = np.nonzero(N == h)
            if not len(ii): continue
            m = int(3.2 / STEP)
            i0, i1, j0, j1 = max(0, ii.min() - m), min(N.shape[0], ii.max() + m + 1), max(0, jj.min() - m), min(N.shape[1], jj.max() + m + 1)
            sub = N[i0:i1, j0:j1]
            hv = sub == h; oth = (sub != 0) & ~hv
            def boundary(mm):
                p = np.pad(mm, 1); return mm & ~(p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:])
            hb = np.argwhere(boundary(hv)).astype(np.float32); ob = np.argwhere(boundary(oth)).astype(np.float32)
            best = 1e9; arg = None
            for k in range(0, len(hb), 400):
                c = hb[k:k + 400]
                dmat = np.sqrt(((c[:, None, :] - ob[None, :, :]) ** 2).sum(axis=2))
                v = float(dmat.min())
                if v < best: best = v; a = np.unravel_index(int(dmat.argmin()), dmat.shape); arg = ob[a[1]]
            g = (best - 1) * STEP
            other = int(sub[int(arg[0]), int(arg[1])]); on = names[other - 1] if other <= len(names) else 'своб. вывод'
            R.append(f'   {name}: ВВ-цепь {names[h - 1]}: зазор до ближайшей чужой меди ≈ {g:.3f} мм (до «{on}», x={(arg[1] + j0) * STEP:.2f}, y={H - (arg[0] + i0) * STEP:.2f}; норма ≥ {RULE_HV}; граничных пикселей ВВ {len(hb)}, чужих {len(ob)})')
            if g < RULE_HV - STEP: fails += 1; R.append('   !!! ВВ-зазор меньше нормы')
    # медь до края
    for L, name in (('T', 'F_Cu'), ('B', 'B_Cu')):
        ii, jj = np.nonzero(cu[L].mask)
        e = min(ii.min(), jj.min(), cu[L].mask.shape[0] - 1 - ii.max(), cu[L].mask.shape[1] - 1 - jj.max()) * STEP
        R.append(f'   {name}: медь до края платы ≥ {e:.3f} мм (норма ≥ {RULE_EDGE})')
        if e < RULE_EDGE - STEP: fails += 1
    # неметаллизированные отверстия: без меди в радиусе d/2 + 0,3
    nb = 0
    for (x, y, dd) in npth:
        for L in 'TB':
            i, j = cu[L].at(x, y); r = int((dd / 2 + 0.3) / STEP)
            yy2, xx2 = np.mgrid[-r:r + 1, -r:r + 1]
            if cu[L].mask[i - r:i + r + 1, j - r:j + r + 1][(xx2 * xx2 + yy2 * yy2) <= r * r].any(): nb += 1
    R.append(f'   Неметаллизированные отверстия с медью ближе 0,3 мм от края отверстия: {nb}'); fails += nb
    # маска и паста: каждая площадка вскрыта, вскрытия не шире площадки + 0,1; паста только на SMD
    mk = {}
    for L, name in (('T', 'F_Mask'), ('B', 'B_Mask')):
        prims, _ = parse_gerber(os.path.join(OUT, f'{BASE}-{name}.gbr')); r = Raster(W, H); mk[L] = r.render(prims)
    closed = 0
    for p in pads:
        x, y = float(p['x_mm']), float(p['y_mm']); i, j = cu['T'].at(x, y)
        if not mk['T'][i, j]: closed += 1
        if p['type'] == 'TH' and not mk['B'][i, j]: closed += 1
    bare = {}
    for L in 'TB':
        # вскрытие маски над медью чужой цепи = оголённая чужая медь рядом с площадкой
        lb, n = label(mk[L]); cnt = 0
        ii, jj = np.nonzero(mk[L] & (netimg[L] != 0))
        pairs = np.unique(np.stack([lb[ii, jj], netimg[L][ii, jj].astype(np.int32)], axis=1), axis=0)
        ks, c = np.unique(pairs[:, 0], return_counts=True)
        bare[L] = int((c > 1).sum())
    R.append(f'   Маска: выводов без вскрытия маски: {closed}; вскрытий, задевающих медь двух разных цепей: сверху {bare["T"]}, снизу {bare["B"]}')
    fails += closed + bare['T'] + bare['B']
    prims, _ = parse_gerber(os.path.join(OUT, f'{BASE}-F_Paste.gbr')); r = Raster(W, H); paste = r.render(prims)
    smd = [p for p in pads if p['type'] != 'TH']; np_ = sum(1 for p in smd if paste[cu['T'].at(float(p['x_mm']), float(p['y_mm']))])
    R.append(f'   Паста: SMD-выводов {len(smd)}, из них с окном пасты {np_}; окон пасты (вспышек) {len(prims)}')
    # шелк не на вскрытиях
    for L, name in (('T', 'F_Silkscreen'), ('B', 'B_Silkscreen')):
        prims, _ = parse_gerber(os.path.join(OUT, f'{BASE}-{name}.gbr')); r = Raster(W, H); sk = r.render(prims)
        ov = int((sk & mk[L]).sum())
        R.append(f'   {name}: линий {len(prims)}; пикселей краски на вскрытиях маски: {ov}')
        fails += 1 if ov else 0
    R.append(f'   ИТОГ раздела C: {"РАСХОЖДЕНИЙ НЕТ — файлы для завода соответствуют netlist" if fails == 0 else f"НАЙДЕНО ПРОБЛЕМ: {fails}"} (время проверки {time.time() - t0:.0f} с)')
    open(os.path.join(OUT, 'check_C.txt'), 'w', encoding='utf-8').write('\n'.join(R) + '\n')
    print('\n'.join(R))
    return fails

if __name__ == '__main__': sys.exit(1 if main() else 0)
