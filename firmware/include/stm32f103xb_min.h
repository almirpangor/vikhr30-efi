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

#define PERIPH_BASE       0x40000000UL
#define APB1_BASE         PERIPH_BASE
#define APB2_BASE         (PERIPH_BASE + 0x00010000UL)
#define AHB_BASE          (PERIPH_BASE + 0x00020000UL)

#define AFIO              ((AFIO_TypeDef *)(APB2_BASE + 0x0000UL))
#define EXTI              ((EXTI_TypeDef *)(APB2_BASE + 0x0400UL))
#define GPIOA             ((GPIO_TypeDef *)(APB2_BASE + 0x0800UL))
#define GPIOB             ((GPIO_TypeDef *)(APB2_BASE + 0x0C00UL))
#define GPIOC             ((GPIO_TypeDef *)(APB2_BASE + 0x1000UL))
#define ADC1              ((ADC_TypeDef *)(APB2_BASE + 0x2400UL))
#define USART1            ((USART_TypeDef *)(APB2_BASE + 0x3800UL))
#define TIM2              ((TIM_TypeDef *)(APB1_BASE + 0x0000UL))
#define IWDG              ((IWDG_TypeDef *)(APB1_BASE + 0x3000UL))
#define USART2            ((USART_TypeDef *)(APB1_BASE + 0x4400UL))
#define RCC               ((RCC_TypeDef *)(AHB_BASE + 0x1000UL))
#define FLASH_IF          ((FLASH_TypeDef *)(AHB_BASE + 0x2000UL))

#define SYST_CSR          (*(volatile uint32_t *)0xE000E010UL)
#define SYST_RVR          (*(volatile uint32_t *)0xE000E014UL)
#define SYST_CVR          (*(volatile uint32_t *)0xE000E018UL)
#define NVIC_ISER0        (*(volatile uint32_t *)0xE000E100UL)
#define NVIC_ISER1        (*(volatile uint32_t *)0xE000E104UL)
#define NVIC_ICER0        (*(volatile uint32_t *)0xE000E180UL)
#define NVIC_ICER1        (*(volatile uint32_t *)0xE000E184UL)
#define NVIC_IPR          ((volatile uint8_t *)0xE000E400UL)
/* System handler priorities: SCB_SHPR[n] is exception number n + 4,
   so SysTick (exception 15) is SCB_SHPR[11] at 0xE000ED23. */
#define SCB_SHPR          ((volatile uint8_t *)0xE000ED18UL)

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

static inline void irq_disable(void) { __asm volatile("cpsid i" ::: "memory"); }
static inline void irq_enable(void) { __asm volatile("cpsie i" ::: "memory"); }
/* Nestable critical section: returns the previous PRIMASK and masks IRQs. */
static inline uint32_t irq_save(void) {
  uint32_t primask;
  __asm volatile("mrs %0, primask\n\tcpsid i" : "=r"(primask) :: "memory");
  return primask;
}
static inline void irq_restore(uint32_t primask) {
  __asm volatile("msr primask, %0" :: "r"(primask) : "memory");
}
static inline void cpu_nop(void) { __asm volatile("nop"); }

#endif
