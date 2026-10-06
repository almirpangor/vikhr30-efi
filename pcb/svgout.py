# -*- coding: utf-8 -*-
"""Рисунки платы в SVG: «как будет выглядеть» (сверху/снизу), все слои, сборочный."""
import json, os, re
import board as B

def _pad(p, grow=0.0, cls=''):
    w, h = p['w'] + 2 * grow, p['h'] + 2 * grow
    if p['shape'] == 'c': return f'<circle cx="{p["x"]:.3f}" cy="{p["y"]:.3f}" r="{w / 2:.3f}" {cls}/>'
    rx = min(w, h) / 2 if p['shape'] == 'o' else 0
    return f'<rect x="{p["x"] - w / 2:.3f}" y="{p["y"] - h / 2:.3f}" width="{w:.3f}" height="{h:.3f}" rx="{rx:.3f}" {cls}/>'

def _poly_path(polys):
    return ' '.join('M' + ' L'.join(f'{x:.3f},{y:.3f}' for x, y in p) + 'Z' for p in polys)

def copper(d, L, color, opacity=1.0):
    o = [f'<g fill="{color}" stroke="{color}" stroke-linecap="round" opacity="{opacity}">']
    if d['pour'].get(L): o.append(f'<path d="{_poly_path(d["pour"][L])}" fill-rule="evenodd" stroke="none"/>')
    for (l, net, x0, y0, x1, y1) in d['polys']:
        if l == L: o.append(f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" stroke="none"/>')
    for (l, net, x1, y1, x2, y2, w) in d['tracks']:
        if l == L: o.append(f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" stroke-width="{w}"/>')
    for c in d['comps']:
        for p in c['pads']:
            if L == 'T' or p['layers'] == 'TB': o.append(_pad(p, 0, 'stroke="none"'))
    for (x, y, dia, dr, net) in d['vias']: o.append(f'<circle cx="{x:.3f}" cy="{y:.3f}" r="{dia / 2}" stroke="none"/>')
    o.append('</g>')
    return o

def openings(d, L, color):
    o = [f'<g fill="{color}">']
    for c in d['comps']:
        for p in c['pads']:
            if p['layers'] == 'T0': continue
            if L == 'T' or p['layers'] == 'TB': o.append(_pad(p, B.MASK_EXP))
    o.append('</g>')
    return o

def silk(d, L, color):
    o = [f'<g stroke="{color}" stroke-linecap="round" fill="none">']
    for (x1, y1, x2, y2, w) in d['silk'][L]: o.append(f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" stroke-width="{w}"/>')
    o.append('</g>')
    return o

def drills(d, color='#0a0a0a'):
    o = [f'<g fill="{color}">']
    for c in d['comps']:
        for p in c['pads']:
            if p['drill']: o.append(f'<circle cx="{p["x"]:.3f}" cy="{p["y"]:.3f}" r="{p["drill"] / 2}"/>')
    for (x, y, dia, dr, net) in d['vias']: o.append(f'<circle cx="{x:.3f}" cy="{y:.3f}" r="{dr / 2}"/>')
    for (x, y, dd) in d['npth']: o.append(f'<circle cx="{x}" cy="{y}" r="{dd / 2}"/>')
    o.append('</g>')
    return o

def wrap(d, body, mirror=False, bg='#ffffff', scale=20, caption=None, margin=3.0, extra_h=0.0):
    W, H = d['W'], d['H']
    vw, vh = W + 2 * margin, H + 2 * margin + extra_h
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-margin} {-margin} {vw} {vh}" width="{vw * scale:.0f}" height="{vh * scale:.0f}">',
         f'<rect x="{-margin}" y="{-margin}" width="{vw}" height="{vh}" fill="{bg}"/>']
    o.append(f'<g transform="translate({W},0) scale(-1,1)">' if mirror else '<g>')
    o += body
    o.append('</g>')
    if caption: o.append(f'<text x="{W / 2}" y="{H + margin + extra_h - 1.0}" font-size="2.6" font-family="DejaVu Sans, Arial, sans-serif" text-anchor="middle" fill="{"#222" if bg == "#ffffff" else "#ddd"}">{caption}</text>')
    o.append('</svg>')
    return '\n'.join(o)

def real(d, side):
    L = 'T' if side == 'top' else 'B'
    W, H = d['W'], d['H']
    body = [f'<rect x="0" y="0" width="{W}" height="{H}" fill="#0c4a23"/>']
    body += copper(d, L, '#1f7a3c')
    body += openings(d, L, '#d9d7cc')
    body += silk(d, L, '#f5f5f0')
    body += drills(d, '#1a1a1a')
    cap = f'{B.NAME} {B.REV} — вид сверху (сторона деталей)' if side == 'top' else f'{B.NAME} {B.REV} — вид снизу (со стороны пайки, зеркально относительно вида сверху)'
    return wrap(d, body, mirror=(side != 'top'), bg='#ffffff', caption=cap, extra_h=4.0)

def all_layers(d):
    W, H = d['W'], d['H']
    body = [f'<rect x="0" y="0" width="{W}" height="{H}" fill="#101010" stroke="#e6d200" stroke-width="0.15"/>']
    body += copper(d, 'B', '#2f6fe0', 0.75)
    body += copper(d, 'T', '#d83a2e', 0.6)
    body += silk(d, 'T', '#e8e8e8')
    body += drills(d, '#000')
    for (l, net, x0, y0, x1, y1) in d['polys']:
        if l == 'T': body.append(f'<rect x="{x0 - B.CLR_HV}" y="{y0 - B.CLR_HV}" width="{x1 - x0 + 2 * B.CLR_HV}" height="{y1 - y0 + 2 * B.CLR_HV}" fill="none" stroke="#ff0" stroke-width="0.1" stroke-dasharray="0.6 0.4"/>')
    return wrap(d, body, bg='#101010', caption='Все слои: красный — F.Cu, синий — B.Cu, белый — шелк; жёлтый пунктир — зона 2,5 мм у ВВ', extra_h=4.0)

def short_value(c):
    v = c['value']; r = c['ref']
    if r[0] == 'R':
        m = re.match(r'([\d,]+) (к?)Ом', v)
        if m: return (m.group(1).replace(',', 'к') if m.group(2) and ',' in m.group(1) else m.group(1) + ('к' if m.group(2) else ''))
    if r[0] == 'C':
        v = v.replace(' мкФ', 'мк').replace(' нФ', 'н').replace(' × ', '×').replace(' В', 'В')
    if r[0] == 'X': return {'XF1': 'к F1 2А', 'XF2': 'к F2 10А'}.get(r, '')
    if r == 'A1': return 'Blue Pill (в гнёздах PBS-1×20)'
    if r == 'A5': return 'модуль LM2596S на стойках, 5,00 В'
    return v

def assembly(d):
    W, H = d['W'], d['H']
    body = [f'<rect x="0" y="0" width="{W}" height="{H}" fill="#fff" stroke="#000" stroke-width="0.25"/>']
    body.append('<g fill="none" stroke="#999" stroke-width="0.1">')
    for c in d['comps']:
        for p in c['pads']:
            if p['layers'] != 'T0': body.append(_pad(p))
    body.append('</g><g fill="#fff" stroke="#bbb" stroke-width="0.1">')
    for (x, y, dd) in d['npth']: body.append(f'<circle cx="{x}" cy="{y}" r="{dd / 2}"/>')
    body.append('</g><g stroke="#000" stroke-width="0.18" stroke-linecap="round" fill="none">')
    for c in d['comps']:
        for (x1, y1, x2, y2) in c['fab']: body.append(f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}"/>')
    body.append('</g><g font-family="DejaVu Sans, Arial, sans-serif" text-anchor="middle">')
    for c in d['comps']:
        x0, y0, x1, y1 = c['court']; cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        v = short_value(c); ref = c['ref']
        vert = (y1 - y0) > (x1 - x0) * 1.3
        big = c['pkg'] in ('BLUEPILL_2x20', 'LM2596_MODULE')
        fs = 1.6 if big else 1.0
        if c['pkg'] in ('SOT-23',):          # подпись рядом
            body.append(f'<text x="{x1 + 0.2:.2f}" y="{cy - 0.1:.2f}" font-size="0.9" text-anchor="start" fill="#00f">{ref}</text><text x="{x1 + 0.2:.2f}" y="{cy + 0.9:.2f}" font-size="0.75" text-anchor="start" fill="#060">{v}</text>')
            continue
        if c['pkg'].startswith('JST') or c['pkg'].startswith('TERM') or c['pkg'] == 'HDR_1x6':
            ty = cy + (2.2 if c['pkg'].startswith('TERM') else -0.0)
            if c['pkg'] == 'HDR_1x6': body.append(f'<text transform="translate({cx + 2.6:.2f},{cy:.2f}) rotate(-90)" font-size="1.0" fill="#00f">{ref} HC-06</text>')
            else: body.append(f'<text x="{cx:.2f}" y="{ty + 2.4:.2f}" font-size="1.0" fill="#00f">{ref}</text>')
            continue
        t = f'<tspan fill="#00f">{ref}</tspan> <tspan fill="#060">{v}</tspan>' if v else f'<tspan fill="#00f">{ref}</tspan>'
        est = (len(ref) + len(v) + 1) * fs * 0.6
        if vert: body.append(f'<text transform="translate({cx + 0.35:.2f},{cy:.2f}) rotate(-90)" font-size="{fs}">{t}</text>')
        elif (est > (x1 - x0) or c['pkg'] == 'C_DISC_5.08') and not big:
            body.append(f'<text x="{cx:.2f}" y="{cy - 0.15:.2f}" font-size="0.9" fill="#00f">{ref}</text><text x="{cx:.2f}" y="{cy + 0.85:.2f}" font-size="0.75" fill="#060">{v}</text>')
        else: body.append(f'<text x="{cx:.2f}" y="{cy + 0.35:.2f}" font-size="{fs}">{t}</text>')
    body.append('</g>')
    return wrap(d, body, caption=f'{B.NAME} {B.REV} — сборочный чертёж (вид сверху): обозначение и номинал', extra_h=4.0)

def write_all(d, outdir):
    for name, svg in (('top.svg', real(d, 'top')), ('bottom.svg', real(d, 'bottom')), ('all-layers.svg', all_layers(d)), ('assembly.svg', assembly(d))):
        open(os.path.join(outdir, name), 'w', encoding='utf-8').write(svg)

if __name__ == '__main__':
    d = json.load(open(os.path.join(B.HERE, 'design.json')))
    os.makedirs(os.path.join(B.HERE, 'out'), exist_ok=True)
    write_all(d, os.path.join(B.HERE, 'out'))
