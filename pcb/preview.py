import board, sys
b = board.load()
import json,os
if os.path.exists('route.json') and len(sys.argv)>1:
    r=json.load(open('route.json')); b.tracks=[tuple(t) for t in r['tracks']]; b.vias=[tuple(v) for v in r['vias']]
S=[]
A=S.append
A(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 {b.W+4} {b.H+4}" width="{(b.W+4)*12}" height="{(b.H+4)*12}"><rect x="-2" y="-2" width="{b.W+4}" height="{b.H+4}" fill="#222"/><rect x="0" y="0" width="{b.W}" height="{b.H}" fill="#0a3d1c" stroke="#ff0" stroke-width="0.15"/>')
for L,net,x0,y0,x1,y1 in b.polys:
    if L=='T': A(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" fill="#c33" opacity="0.6"/>')
for L,net,x1,y1,x2,y2,w in b.tracks:
    A(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{"#c33" if net in board.HV_NETS else "#e8a040" if L=="T" else "#39f"}" stroke-width="{w}" stroke-linecap="round" opacity="0.7"/>')
for c in b.comps:
    x0,y0,x1,y1=c['court']
    A(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" fill="none" stroke="#f0f" stroke-width="0.08"/>')
    for l in c['silk']: A(f'<line x1="{l[0]:.3f}" y1="{l[1]:.3f}" x2="{l[2]:.3f}" y2="{l[3]:.3f}" stroke="#fff" stroke-width="0.15"/>')
    for p in c['pads']:
        col = '#f44' if p['net'] in board.HV_NETS else '#888' if p['net'] is None else '#fc0'
        if p['shape']=='c': A(f'<circle cx="{p["x"]}" cy="{p["y"]}" r="{p["w"]/2}" fill="{col}"/>')
        else: A(f'<rect x="{p["x"]-p["w"]/2}" y="{p["y"]-p["h"]/2}" width="{p["w"]}" height="{p["h"]}" rx="{min(p["w"],p["h"])/2 if p["shape"]=="o" else 0}" fill="{col}"/>')
        if p['drill']: A(f'<circle cx="{p["x"]}" cy="{p["y"]}" r="{p["drill"]/2}" fill="#000"/>')
    A(f'<text x="{(x0+x1)/2}" y="{(y0+y1)/2+0.5}" font-size="1.5" fill="#0ff" text-anchor="middle" font-family="sans-serif">{c["ref"]}</text>')
for x,y,d,dr,net in b.vias: A(f'<circle cx="{x}" cy="{y}" r="{d/2}" fill="#fff"/><circle cx="{x}" cy="{y}" r="{dr/2}" fill="#000"/>')
for x,y,d in b.npth: A(f'<circle cx="{x}" cy="{y}" r="{d/2}" fill="#000" stroke="#fff" stroke-width="0.1"/>')
A('</svg>')
open('/tmp/claude-0/-home-claude/52f09a10-6dfb-5424-aedf-6ee0be8dd7d6/scratchpad/prev.svg','w').write('\n'.join(S))
# пересечения габаритов
cs=b.comps; n=0
for i in range(len(cs)):
    for j in range(i+1,len(cs)):
        a,c=cs[i]['court'],cs[j]['court']
        if a[0]<c[2]-1e-6 and c[0]<a[2]-1e-6 and a[1]<c[3]-1e-6 and c[1]<a[3]-1e-6:
            if 'A1' in (cs[i]['ref'],cs[j]['ref']) or 'A5' in (cs[i]['ref'],cs[j]['ref']): tag='(под модулем!)'
            else: tag=''
            print('ПЕРЕСЕЧЕНИЕ', cs[i]['ref'], cs[j]['ref'], tag); n+=1
print('пересечений', n, 'элементов', len(cs))
