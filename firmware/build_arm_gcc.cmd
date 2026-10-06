@echo off
rem Сборка v0.9 компилятором arm-none-eabi-gcc (НЕ ПРОВЕРЯЛАСЬ: в среде подготовки v0.9 этого компилятора не было).
rem Проверенная сборка делается скриптом build.sh (clang + ld.lld).
setlocal
set OUT=release\gcc
if not exist "%OUT%" mkdir "%OUT%"
arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb -std=c11 -Os -Wall -Wextra -Werror -ffreestanding -fno-builtin -fdata-sections -ffunction-sections -nostdlib -Iinclude src\startup.c src\main.c src\rt.c -Tstm32f103c6.ld -Wl,--gc-sections -Wl,-e,Reset_Handler -Wl,-Map=%OUT%\vikhr30_ecu_v0.9_gcc.map -o %OUT%\vikhr30_ecu_v0.9_gcc.elf
if errorlevel 1 exit /b 1
arm-none-eabi-objcopy -O binary %OUT%\vikhr30_ecu_v0.9_gcc.elf %OUT%\vikhr30_ecu_v0.9_gcc.bin
arm-none-eabi-objcopy -O ihex %OUT%\vikhr30_ecu_v0.9_gcc.elf %OUT%\vikhr30_ecu_v0.9_gcc.hex
arm-none-eabi-size %OUT%\vikhr30_ecu_v0.9_gcc.elf
endlocal
