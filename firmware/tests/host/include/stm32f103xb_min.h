/*
 * HOST MOCK of include/stm32f103xb_min.h.
 * Same register structures, but the peripherals are ordinary variables that
 * the simulator (sim.c) animates.  Works for both the unmodified v0.8
 * main.c and the v0.9 main.c.
 */
#ifndef STM32F103XB_MIN_H
#define STM32F103XB_MIN_H

#include <stdint.h>

typedef struct {
  volatile uint32_t CRL, CRH, IDR, ODR, BSRR, BRR, LCKR;
} GPIO_TypeDef;

typedef struct {
  volatile uint32_t CR, CFGR, CIR, APB2RSTR, APB1RSTR, AHBENR,
                    APB2ENR, APB1ENR, BDCR, CSR;
} RCC_TypeDef;

typedef struct {
  volatile uint32_t EVCR, MAPR, EXTICR[4], MAPR2;
} AFIO_TypeDef;

typedef struct {
  volatile uint32_t IMR, EMR, RTSR, FTSR, SWIER, PR;
} EXTI_TypeDef;

typedef struct {
  volatile uint32_t SR, CR1, CR2, SMPR1, SMPR2, JOFR1, JOFR2, JOFR3, JOFR4,
                    HTR, LTR, SQR1, SQR2, SQR3, JSQR, JDR1, JDR2, JDR3,
                    JDR4, DR;
} ADC_TypeDef;

typedef struct {
  volatile uint32_t CR1, CR2, SMCR, DIER, SR, EGR, CCMR1, CCMR2, CCER, CNT,
                    PSC, ARR, RCR, CCR1, CCR2, CCR3, CCR4, BDTR, DCR, DMAR;
} TIM_TypeDef;

typedef struct {
  volatile uint32_t SR, DR, BRR, CR1, CR2, CR3, GTPR;
} USART_TypeDef;

typedef struct {
  volatile uint32_t ACR, KEYR, OPTKEYR, SR, CR, AR, RESERVED, OBR, WRPR;
} FLASH_TypeDef;

typedef struct {
  volatile uint32_t KR, PR, RLR, SR;
} IWDG_TypeDef;

extern AFIO_TypeDef sim_AFIO;
extern EXTI_TypeDef sim_EXTI;
extern GPIO_TypeDef sim_GPIOA, sim_GPIOB, sim_GPIOC;
extern ADC_TypeDef sim_ADC1;
extern USART_TypeDef sim_USART1, sim_USART2;
extern TIM_TypeDef sim_TIM2;
extern IWDG_TypeDef sim_IWDG;
extern RCC_TypeDef sim_RCC;
extern FLASH_TypeDef sim_FLASH;
extern volatile uint32_t sim_SYST_CSR, sim_SYST_RVR, sim_SYST_CVR;
extern volatile uint32_t sim_NVIC_ISER0, sim_NVIC_ISER1, sim_NVIC_ICER0, sim_NVIC_ICER1;
extern volatile uint8_t sim_NVIC_IPR[64];
extern volatile uint8_t sim_SCB_SHPR[12];
extern volatile uint32_t sim_primask;

#define AFIO              (&sim_AFIO)
#define EXTI              (&sim_EXTI)
#define GPIOA             (&sim_GPIOA)
#define GPIOB             (&sim_GPIOB)
#define GPIOC             (&sim_GPIOC)
#define ADC1              (&sim_ADC1)
#define USART1            (&sim_USART1)
#define TIM2              (&sim_TIM2)
#define IWDG              (&sim_IWDG)
#define USART2            (&sim_USART2)
#define RCC               (&sim_RCC)
#define FLASH_IF          (&sim_FLASH)

#define SYST_CSR          sim_SYST_CSR
#define SYST_RVR          sim_SYST_RVR
#define SYST_CVR          sim_SYST_CVR
#define NVIC_ISER0        sim_NVIC_ISER0
#define NVIC_ISER1        sim_NVIC_ISER1
#define NVIC_ICER0        sim_NVIC_ICER0
#define NVIC_ICER1        sim_NVIC_ICER1
#define NVIC_IPR          sim_NVIC_IPR
#define SCB_SHPR          sim_SCB_SHPR

#define FLASH_ACR_PRFTBE  (1UL << 4)
#define FLASH_ACR_LATENCY_2 2UL
#define FLASH_SR_BSY      (1UL << 0)
#define FLASH_SR_PGERR    (1UL << 2)
#define FLASH_SR_WRPRTERR (1UL << 4)
#define FLASH_SR_EOP      (1UL << 5)
#define FLASH_CR_PG       (1UL << 0)
#define FLASH_CR_PER      (1UL << 1)
#define FLASH_CR_STRT     (1UL << 6)
#define FLASH_CR_LOCK     (1UL << 7)

#define USART_SR_ORE      (1UL << 3)
#define USART_SR_RXNE     (1UL << 5)
#define USART_SR_TXE      (1UL << 7)
#define USART_CR1_RE      (1UL << 2)
#define USART_CR1_TE      (1UL << 3)
#define USART_CR1_RXNEIE  (1UL << 5)
#define USART_CR1_TXEIE   (1UL << 7)
#define USART_CR1_UE      (1UL << 13)

#define TIM_DIER_UIE      (1UL << 0)
#define TIM_DIER_CC1IE    (1UL << 1)
#define TIM_SR_UIF        (1UL << 0)
#define TIM_SR_CC1IF      (1UL << 1)

/* PRIMASK is a plain variable; the simulator delivers no interrupt while it is set. */
static inline void irq_disable(void) { sim_primask = 1; }
static inline void irq_enable(void) { sim_primask = 0; }
static inline uint32_t irq_save(void) { uint32_t p = sim_primask; sim_primask = 1; return p; }
static inline void irq_restore(uint32_t primask) { sim_primask = primask; }
static inline void cpu_nop(void) {}

#endif
