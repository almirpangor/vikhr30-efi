# -*- coding: utf-8 -*-
"""Самопроверка независимого проверяющего: в копию Gerber вносятся дефекты — он обязан их найти."""
import os, re, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, 'out')
def run(mod):
    d = tempfile.mkdtemp(prefix='gerbtest', dir='/tmp/claude-0/-home-claude/52f09a10-6dfb-5424-aedf-6ee0be8dd7d6/scratchpad')
    for f in os.listdir(OUT):
        if f.endswith(('.gbr', '.drl', '.csv')): shutil.copy(os.path.join(OUT, f), d)
    mod(d)
    r = subprocess.run([sys.executable, os.path.join(HERE, 'gerbcheck.py')], env=dict(os.environ, GERB_DIR=d), capture_output=True, text=True)
    shutil.rmtree(d)
    return r.returncode, [l.strip() for l in r.stdout.splitlines() if 'Обрывов' in l or 'ИТОГ' in l]
def cut(d):      # убрать одну сигнальную дорожку 0,4 мм с верхнего слоя
    p = os.path.join(d, 'vikhr30-efi-F_Cu.gbr'); L = open(p).read().split('\n')
    ap = next(re.match(r'%ADD(\d+)C,0\.4000', l).group(1) for l in L if re.match(r'%ADD(\d+)C,0\.4000', l))
    i = L.index(f'D{ap}*'); j = next(k for k in range(i + 1, len(L)) if L[k].endswith('D01*'))
    del L[j - 1:j + 1]; open(p, 'w').write('\n'.join(L))
def short(d):    # перемычка между соседними выводами 1 и 2 микросхемы U3 (PA8 и PB6)
    pads = {tuple(l.split(';')[:2]): l.split(';') for l in open(os.path.join(d, 'pads.csv'), encoding='utf-8').read().split('\n')[1:] if l}
    a, b = pads[('U3', '1')], pads[('U3', '2')]
    sc = lambda v: int(round(float(v) * 1e6))
    p = os.path.join(d, 'vikhr30-efi-F_Cu.gbr'); t = open(p).read()
    ap = re.search(r'%ADD(\d+)C,0\.4000', t).group(1)
    t = t.replace('M02*', f'D{ap}*\nX{sc(a[2])}Y{sc(a[3])}D02*\nX{sc(b[2])}Y{sc(b[3])}D01*\nM02*'); open(p, 'w').write(t)
def nodrill(d):  # убрать из сверловки все отверстия ⌀1,3 (клеммы) — слои на клеммах перестают соединяться
    p = os.path.join(d, 'vikhr30-efi-PTH.drl'); L = open(p).read().split('\n')
    t = next(l for l in L if l.endswith('C1.300'))[:2]
    i = L.index(t); j = next(k for k in range(i + 1, len(L)) if L[k].startswith('T'))
    del L[i + 1:j]; open(p, 'w').write('\n'.join(L))
R = ['Самопроверка проверяющего (в копии файлов намеренно внесён дефект; ожидается «найдено»):']
ok = True
for name, mod in (('удалена одна дорожка 0,4 мм на F_Cu', cut), ('перемычка между выводами U3.1 и U3.2 на F_Cu', short), ('из сверловки удалены отверстия клемм ⌀1,3', nodrill)):
    rc, lines = run(mod)
    R.append(f'   {name}: {"ДЕФЕКТ НАЙДЕН" if rc else "НЕ НАЙДЕН !!!"} — {" | ".join(lines)[:230]}')
    ok &= bool(rc)
open(os.path.join(OUT, 'check_selftest.txt'), 'w', encoding='utf-8').write('\n'.join(R) + '\n'); print('\n'.join(R)); sys.exit(0 if ok else 1)
