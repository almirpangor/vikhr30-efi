#!/bin/sh
# Полная пересборка проекта платы
set -e
cd /home/claude/vikhr30
NODE_PATH=/opt/npm-tools/node_modules /opt/npm-tools/node_modules/.bin/tsx pcb/netlist.ts > /dev/null
cd pcb
python3 build.py
python3 silk.py
python3 svgout.py
python3 outputs.py
python3 drc.py > /dev/null || echo 'DRC: ЕСТЬ НАРУШЕНИЯ'
python3 gerbcheck.py > /dev/null || echo 'GERBER-ПРОВЕРКА: ЕСТЬ ПРОБЛЕМЫ'
python3 selftest.py > /dev/null || echo 'САМОПРОВЕРКА: дефект не найден'
python3 checkall.py > /dev/null
cd out && for n in top bottom all-layers assembly; do node ../svg2png.mjs $n.svg $n.png 1.5; done
