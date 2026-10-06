#!/bin/sh
# Сборка симулятора на хосте: одна и та же sim.c + main.c v0.8 (без изменений) или main.c v0.9.
set -eu
cd "$(dirname "$0")"
CLANG=${CLANG:-/usr/lib/llvm-18/bin/clang}
mkdir -p build
COMMON="-std=gnu11 -O2 -g -funsigned-char -Ihost/include -Ihost"
INSTR="-fsanitize-coverage=trace-pc-guard,trace-loads,trace-stores"
$CLANG $COMMON -Wall -Wextra -c host/sim.c -o build/sim.o
$CLANG $COMMON $INSTR -Wall -Wextra -Werror -DFW_MAIN_C='"../../src/main.c"' -c host/fw_wrap.c -o build/fw_new.o
$CLANG $COMMON $INSTR -DFW_MAIN_C='"../v0.8/main.c"' -c host/fw_wrap.c -o build/fw_old.o
$CLANG build/sim.o build/fw_new.o -lm -o build/sim_new
$CLANG build/sim.o build/fw_old.o -lm -o build/sim_old
