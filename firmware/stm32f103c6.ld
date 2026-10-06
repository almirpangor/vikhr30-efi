ENTRY(Reset_Handler)

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 31K
  CALIB (rx)  : ORIGIN = 0x08007C00, LENGTH = 1K
  RAM   (xrw) : ORIGIN = 0x20000000, LENGTH = 10K
}

_estack = ORIGIN(RAM) + LENGTH(RAM);

SECTIONS
{
  .isr_vector :
  {
    KEEP(*(.isr_vector))
  } > FLASH

  .text :
  {
    *(.text*)
    *(.rodata*)
    . = ALIGN(4);
    _etext = .;
  } > FLASH

  _sidata = LOADADDR(.data);
  .data :
  {
    . = ALIGN(4);
    _sdata = .;
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } > RAM AT > FLASH

  .bss (NOLOAD) :
  {
    . = ALIGN(4);
    _sbss = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > RAM

  .calibration (NOLOAD) :
  {
    . = ALIGN(4);
    KEEP(*(.calibration*))
  } > CALIB

  /DISCARD/ : { *(.comment*) *(.note*) *(.ARM.exidx*) *(.ARM.extab*) }
}

ASSERT(_etext <= ORIGIN(CALIB), "Firmware overlaps the calibration page")
ASSERT(_ebss <= ORIGIN(RAM) + LENGTH(RAM), "Firmware exceeds STM32F103C6 SRAM")
ASSERT(_sidata + (_edata - _sdata) <= ORIGIN(CALIB), "Initialised data overlaps the calibration page")
ASSERT(_ebss + 2048 <= _estack, "Less than 2 KiB left for the stack")
