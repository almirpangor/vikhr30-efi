#!/bin/sh
# Сборка прошивки Vikhr-30 ECU v0.9 для STM32F103C6T6A (clang + ld.lld).
set -eu
cd "$(dirname "$0")"
LLVM=${LLVM:-/usr/lib/llvm-18/bin}
OUT=release
NAME=vikhr30_ecu_v0.9
OBJ=build/arm
mkdir -p "$OUT" "$OBJ"

CFLAGS="--target=arm-none-eabi -mcpu=cortex-m3 -mthumb -mfloat-abi=soft -std=c11 -Os -g
 -ffreestanding -fno-builtin -ffunction-sections -fdata-sections
 -Wall -Wextra -Werror -Iinclude"

for f in startup main rt; do
  "$LLVM/clang" $CFLAGS -c "src/$f.c" -o "$OBJ/$f.o"
done
"$LLVM/ld.lld" -T stm32f103c6.ld --gc-sections -e Reset_Handler \
  --no-undefined -Map="$OUT/$NAME.map" \
  "$OBJ/startup.o" "$OBJ/main.o" "$OBJ/rt.o" -o "$OUT/$NAME.elf"
"$LLVM/llvm-objcopy" -O binary "$OUT/$NAME.elf" "$OUT/$NAME.bin"
"$LLVM/llvm-objcopy" -O ihex   "$OUT/$NAME.elf" "$OUT/$NAME.hex"
"$LLVM/llvm-objdump" -d --no-show-raw-insn "$OUT/$NAME.elf" > "$OUT/$NAME.lst"
"$LLVM/llvm-size" "$OUT/$NAME.elf"
node tools/verify_image.cjs "$OUT/$NAME" "$LLVM"
( cd "$OUT" && sha256sum "$NAME.elf" "$NAME.bin" "$NAME.hex" "$NAME.map" > SHA256SUMS.txt && cat SHA256SUMS.txt )
