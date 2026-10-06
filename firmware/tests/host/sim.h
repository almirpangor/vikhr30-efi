#ifndef SIM_H
#define SIM_H
#include <stdint.h>
typedef struct {
  volatile uint16_t *engine_rpm;
  volatile uint8_t *crank_synced;
  volatile uint16_t *prepared_fuel_us, *prepared_dwell_us;
  volatile int16_t *prepared_advance_tenths;
  volatile uint16_t *fault_flags;
  volatile uint8_t *actuator_test;
  volatile uint32_t *last_crank_edge_us;
  uint8_t *cal; uint32_t cal_size;
  uint16_t *fuel; int16_t *ign;
  uint8_t *params; uint32_t params_size;
  const char *version;
} FwView;
void fw_start(void);
const FwView *fw_view(void);
void SysTick_Handler(void);
void EXTI9_5_IRQHandler(void);
void TIM2_IRQHandler(void);
void USART1_IRQHandler(void);
void USART2_IRQHandler(void);
#endif
