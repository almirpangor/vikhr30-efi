/*
 * Minimal C runtime support for the clang build (no libc, no compiler-rt).
 * The compiler may emit calls to these for structure copies and
 * initialisation even with -ffreestanding.  Anything unused is removed by
 * --gc-sections.  Plain byte loops on purpose: with -fno-builtin the
 * compiler does not turn them back into calls to themselves.
 */
#include <stddef.h>
#include <stdint.h>

void *memcpy(void *target, const void *source, size_t length) {
  uint8_t *d = (uint8_t *)target;
  const uint8_t *s = (const uint8_t *)source;
  while (length--) *d++ = *s++;
  return target;
}

void *memmove(void *target, const void *source, size_t length) {
  uint8_t *d = (uint8_t *)target;
  const uint8_t *s = (const uint8_t *)source;
  if (d < s) { while (length--) *d++ = *s++; }
  else { d += length; s += length; while (length--) *--d = *--s; }
  return target;
}

void *memset(void *target, int value, size_t length) {
  uint8_t *d = (uint8_t *)target;
  while (length--) *d++ = (uint8_t)value;
  return target;
}

/* ARM EABI names used by clang for arm-none-eabi. */
void __aeabi_memcpy(void *target, const void *source, size_t length) { (void)memcpy(target, source, length); }
void __aeabi_memcpy4(void *target, const void *source, size_t length) { (void)memcpy(target, source, length); }
void __aeabi_memcpy8(void *target, const void *source, size_t length) { (void)memcpy(target, source, length); }
void __aeabi_memmove(void *target, const void *source, size_t length) { (void)memmove(target, source, length); }
void __aeabi_memmove4(void *target, const void *source, size_t length) { (void)memmove(target, source, length); }
void __aeabi_memmove8(void *target, const void *source, size_t length) { (void)memmove(target, source, length); }
/* Note the argument order: (target, length, value). */
void __aeabi_memset(void *target, size_t length, int value) { (void)memset(target, value, length); }
void __aeabi_memset4(void *target, size_t length, int value) { (void)memset(target, value, length); }
void __aeabi_memset8(void *target, size_t length, int value) { (void)memset(target, value, length); }
void __aeabi_memclr(void *target, size_t length) { (void)memset(target, 0, length); }
void __aeabi_memclr4(void *target, size_t length) { (void)memset(target, 0, length); }
void __aeabi_memclr8(void *target, size_t length) { (void)memset(target, 0, length); }
