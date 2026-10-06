#include <stdint.h>

extern uint32_t _estack;
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss;
int main(void);

void Reset_Handler(void);
void Default_Handler(void);
void SysTick_Handler(void) __attribute__((weak, alias("Default_Handler")));
void EXTI9_5_IRQHandler(void) __attribute__((weak, alias("Default_Handler")));
void USB_LP_CAN1_RX0_IRQHandler(void) __attribute__((weak, alias("Default_Handler")));
void TIM2_IRQHandler(void) __attribute__((weak, alias("Default_Handler")));
void USART1_IRQHandler(void) __attribute__((weak, alias("Default_Handler")));
void USART2_IRQHandler(void) __attribute__((weak, alias("Default_Handler")));

typedef void (*isr_t)(void);

__attribute__((section(".isr_vector"), used))
const isr_t vector_table[59] = {
  [0] = (isr_t)&_estack,
  [1] = Reset_Handler,
  [2] = Default_Handler,
  [3] = Default_Handler,
  [4] = Default_Handler,
  [5] = Default_Handler,
  [6] = Default_Handler,
  [11] = Default_Handler,
  [12] = Default_Handler,
  [14] = Default_Handler,
  [15] = SysTick_Handler,
  [16 + 20] = USB_LP_CAN1_RX0_IRQHandler,
  [16 + 23] = EXTI9_5_IRQHandler,
  [16 + 28] = TIM2_IRQHandler,
  [16 + 37] = USART1_IRQHandler,
  [16 + 38] = USART2_IRQHandler,
};

void Reset_Handler(void) {
  uint32_t *src = &_sidata;
  uint32_t *dst = &_sdata;
  while (dst < &_edata) *dst++ = *src++;
  dst = &_sbss;
  while (dst < &_ebss) *dst++ = 0;
  (void)main();
  for (;;) {}
}

void Default_Handler(void) {
  for (;;) {}
}
