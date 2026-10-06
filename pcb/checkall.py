# -*- coding: utf-8 -*-
import json, os, board as B
O = os.path.join(B.HERE, 'out'); d = json.load(open(os.path.join(B.HERE, 'design.json')))
rd = lambda n: open(os.path.join(O, n), encoding='utf-8').read().rstrip()
ab = rd('check_ABDE.txt'); i = ab.index('D. Контрольные')
man = sum(1 for v in d['vias'] if v[2] > 0.8) 
head = [f'ПРОВЕРКА ПЛАТЫ «{B.NAME} {B.REV}» ({B.DATE})', '=' * 60,
        f'Плата {d["W"]:.0f} × {d["H"]:.0f} мм, 2 слоя. Элементов {len(d["comps"])}, цепей {len(json.load(open(os.path.join(B.HERE, "netlist.json")))["nets"])}, отрезков дорожек {len(d["tracks"])}, переходных {len(d["vias"])} (из них силовых 1,2/0,6 — {man}),',
        f'многоугольников заливки GND: сверху {len(d["pour"]["T"])}, снизу {len(d["pour"]["B"])}. Трассировка: 100 % связей, неразведённых нет (см. B и C).',
        'Все числа ниже получены скриптами pcb/drc.py (A, B, D, E — по геометрии проекта) и pcb/gerbcheck.py (C — заново по файлам Gerber/Excellon).',
        'НЕ ПРОВЕРЯЛОСЬ: штатный DRC KiCad (KiCad недоступен, файл .kicad_pcb в нём не открывался); соответствие посадочных мест реальным деталям.', '']
txt = '\n'.join(head) + '\n' + ab[:i].rstrip() + '\n\n' + rd('check_C.txt') + '\n\n' + rd('check_selftest.txt') + '\n\n' + ab[i:] + '\n\n' + open(os.path.join(B.HERE, 'F_visual.txt'), encoding='utf-8').read()
open(os.path.join(O, 'CHECK.txt'), 'w', encoding='utf-8').write(txt)
for n in ('check_ABDE.txt', 'check_C.txt', 'check_selftest.txt'): os.remove(os.path.join(O, n))
print(txt[:600])
