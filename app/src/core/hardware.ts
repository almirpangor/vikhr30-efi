// Аппаратная часть ECU в варианте «из деталей магазина „Электроника“ (Уфа)»:
// перечень комплектующих, блоки, цепи и то, что должно быть на каждой цепи
// при проверке мультиметром и осциллографом. Значения считаются из текущей
// телеметрии по тем же формулам, что в прошивке v0.8.
//
// ВАЖНО: схема составлена по исходной документации и заменам деталей и
// на железе не испытана. Перед подключением к двигателю каждую цепь нужно
// проверить на стенде — именно для этого служит вкладка «3D-схема».
import { coilDwell } from './calc';
import type { Telemetry } from './types';

const SHOP = 'https://magazin-elektronika.ru';

export interface BomItem {
  ref: string;            // позиционное обозначение(я)
  qty: number;
  title: string;          // что купить
  role: string;           // зачем
  original?: string;      // что стояло в исходной схеме
  url?: string;           // страница в магазине
  price?: number;         // ₽ за штуку на 03.10.2026
  status: 'shop' | 'shop-unverified' | 'elsewhere';
  note?: string;
}

/** Цены и ссылки сняты с сайта магазина 03.10.2026. Остатки сайт не показывает — уточнять по телефону магазина. */
export const BOM: BomItem[] = [
  { ref: 'A1', qty: 1, title: 'Плата STM32F103C6T6 (Blue Pill HW-267)', role: 'Микроконтроллер', url: SHOP + '/73-84-23', price: 608, status: 'shop', note: 'Именно C6T6 — прошивка собрана под него.' },
  { ref: 'A2', qty: 1, title: 'Bluetooth-модуль HC-06', role: 'Связь с программой', url: SHOP + '/78-00-66', price: 690, status: 'shop', note: 'Перед установкой перенастроить на 115200 бод (заводские 9600) командой AT+BAUD8.' },
  { ref: 'A3', qty: 1, title: 'USB-UART PL2303HX (3,3 В)', role: 'Проводная связь и настройка HC-06', original: 'CP2102', url: SHOP + '/79-37-02', price: 180, status: 'shop', note: 'Перемычку уровня поставить на 3,3 В. Одновременно с HC-06 к PA10 не подключать.' },
  { ref: 'A4', qty: 1, title: 'ST-Link V2', role: 'Запись прошивки', url: SHOP + '/74-18-77', price: 561, status: 'shop' },
  { ref: 'A5', qty: 1, title: 'DC-DC модуль LM2596S (4–40 В → 5 В, 2 А)', role: 'Питание +5 В', original: 'LM53603-Q1', url: SHOP + '/78-96-44', price: 190, status: 'shop', note: 'ДО установки выставить подстроечником 5,00 В на выходе при 12 В на входе.' },
  { ref: 'F1', qty: 1, title: 'Предохранитель ножевой 2 А + держатель', role: 'Защита питания ECU', url: SHOP + '/98-92-58', price: 60, status: 'shop-unverified', note: 'Держатель найден; номинал 2 А отдельной страницей не найден — спросить в магазине.' },
  { ref: 'F2', qty: 1, title: 'Предохранитель ножевой 10 А + держатель', role: 'Катушки, форсунка, насос', url: SHOP + '/98-94-63', price: 35, status: 'shop' },
  { ref: 'D1', qty: 1, title: 'Диод Шоттки SR560 (5 А, 60 В)', role: 'Защита от переполюсовки', original: 'LM74700-Q1 + MOSFET', url: SHOP + '/99-42-50', price: 30, status: 'shop', note: 'Падение около 0,4 В — учтено в ожидаемых напряжениях.' },
  { ref: 'D2', qty: 1, title: 'TVS-диод SM8S30A', role: 'Гашение выбросов бортсети', original: 'SMBJ33CA', url: SHOP + '/76-06-46', price: 590, status: 'shop-unverified', note: 'Параметры сверить по даташиту. Дешёвая замена из другого магазина: P6KE33A или 1.5KE33A.' },
  { ref: 'C1', qty: 1, title: 'Конденсатор 470 мкФ × 25 В', role: 'Фильтр на входе питания', url: SHOP + '/99-01-97', price: 18, status: 'shop' },
  { ref: 'C2, C16, C17', qty: 3, title: 'Конденсатор 47 мкФ × 63 В', role: 'Фильтр +5 В датчиков, у HC-06 и у драйвера РХХ', url: SHOP + '/99-02-36', price: 10, status: 'shop' },
  { ref: 'C3…', qty: 12, title: 'Конденсатор керамический 0,1 мкФ × 50 В', role: 'Фильтры входов АЦП и развязка', url: SHOP + '/99-00-22', price: 7, status: 'shop' },
  { ref: 'C13…C15', qty: 3, title: 'Конденсатор керамический 1 нФ × 50 В', role: 'Фильтры входов ДПКВ, SERVICE и STOP', status: 'shop-unverified', note: 'Нужен по схеме входов; на сайте магазина не проверялся — спросить.' },
  { ref: 'L1', qty: 1, title: 'Дроссель 47 мкГн, 1,8 А (CDRH125)', role: 'Фильтр питания датчиков +5V_SENS', original: 'ферритовая бусина', url: SHOP + '/75-99-72', price: 110, status: 'shop' },
  { ref: 'Q1, Q2', qty: 2, title: 'IGBT зажигания IRGS14C40L (TO-263)', role: 'Ключи катушек', original: 'VBG08H-E', url: SHOP + '/99-46-03', price: 590, status: 'shop', note: 'Со встроенным ограничением ~400 В. Нужен теплоотвод (медный полигон или пластина).' },
  { ref: 'Q3…Q6', qty: 4, title: 'MOSFET AO3400A (SOT-23)', role: 'Двухкаскадный драйвер затворов IGBT 3,3 В → 5 В', url: SHOP + '/73-20-80', price: 4.7, status: 'shop', note: 'Два каскада на канал: логика не инвертируется, при сбросе МК катушка выключена.' },
  { ref: 'Q7, Q8', qty: 2, title: 'MOSFET IRLZ44N (TO-220)', role: 'Ключи форсунки и нагревателя лямбды', original: 'VND7NV04', url: SHOP + '/99-46-44', price: 160, status: 'shop', note: 'Без встроенной защиты — обязательны диоды D3, D4.' },
  { ref: 'Q9', qty: 1, title: 'Транзистор BC547C', role: 'Ключ обмотки реле насоса', original: 'BC817', url: SHOP + '/99-52-75', price: 10, status: 'shop' },
  { ref: 'D3…D5', qty: 3, title: 'Диод 1N4007', role: 'Гашение выбросов форсунки, нагревателя и реле', url: SHOP + '/99-43-56', price: 3, status: 'shop' },
  { ref: 'D6…D9, D11', qty: 5, title: 'Сборка диодов Шоттки BAR43S (SOT-23)', role: 'Защита входов АЦП и ДПКВ', original: 'BAT54S', url: SHOP + '/76-18-88', price: 14, status: 'shop-unverified', note: 'Цоколёвку сверить по даташиту.' },
  { ref: 'D10', qty: 2, title: 'Стабилитрон 3,3 В 1N4728A', role: 'Запасной вариант защиты входов', url: SHOP + '/79-74-59', price: 8, status: 'shop' },
  { ref: 'U3', qty: 1, title: 'Драйвер L293DD (SO-20)', role: 'Шаговый регулятор холостого хода', original: 'DRV8843', url: SHOP + '/99-86-61', price: 180, status: 'shop', note: 'До 0,6 А на обмотку: измерить сопротивление обмоток РХХ (должно быть не меньше 25 Ом). Выхода аварии нет — PC13 подтянут к +3,3 В.' },
  { ref: 'K1', qty: 1, title: 'Реле автомобильное 12 В 30 А, 4 контакта', role: 'Питание бензонасоса', url: SHOP + '/73-01-81', price: 175, status: 'shop' },
  { ref: 'XK1', qty: 1, title: 'Колодка реле с проводами', role: 'Подключение K1', url: SHOP + '/76-47-22', price: 120, status: 'shop-unverified', note: 'Проверить в магазине, что подходит к «мини»-реле.' },
  { ref: 'B1', qty: 1, title: 'Датчик Холла SS441A', role: 'Датчик положения коленвала (венец 36-1)', original: 'Littelfuse 55075', url: SHOP + '/97-26-74', price: 166, status: 'shop', note: 'Голый корпус SIP-3: нужен герметичный держатель у венца маховика.' },
  { ref: 'RT1, RT2', qty: 2, title: 'Термистор NTC 10 кОм B3950 в гильзе, кабель 0,5 м', role: 'Температура головки (CHT) и воздуха (IAT)', url: SHOP + '/74-95-37', price: 95, status: 'shop', note: 'Гильза без резьбы: для головки нужен хомут или гнездо.' },
  { ref: 'B2', qty: 1, title: 'Датчик давления MPX4115AP', role: 'Давление во впуске (MAP) и барометр', status: 'elsewhere', note: 'В магазине нет. Заказать отдельно (ЧИП и ДИП, Промэлектроника, маркетплейсы).' },
  { ref: 'R…', qty: 40, title: 'Резисторы 0,25 Вт: 91 Ом, 100 Ом, 330 Ом, 470 Ом, 1 кОм, 2,4 кОм, 4,7 кОм, 10 кОм, 20 кОм, 47 кОм, 100 кОм', role: 'Делители, подтяжки, затворы', url: SHOP + '/elektronnye-komponenty/rezistory-13', price: 6, status: 'shop-unverified', note: 'Подтверждены 100 Ом, 1 кОм, 2,4 кОм, 4,7 кОм, 100 кОм; остальные номиналы спросить.' },
  { ref: 'X…', qty: 1, title: 'Набор разъёмов JST XH 2,54 (2–5 контактов)', role: 'Подключение датчиков', url: SHOP + '/74-68-09', price: 320, status: 'shop' },
  { ref: 'X…', qty: 6, title: 'Клеммник разъёмный 5,08 мм 2 контакта', role: 'Силовые подключения', url: SHOP + '/98-19-50', price: 18, status: 'shop-unverified', note: 'Взять парой: вилка на плату и ответная часть.' },
  { ref: 'X…', qty: 2, title: 'Гнездо PBS-1x20 (или 2 × 1x10), 2,54 мм', role: 'Панель под Blue Pill', url: SHOP + '/74-61-86', price: 28.5, status: 'shop' },
  { ref: 'PCB', qty: 1, title: 'Макетная плата под пайку ~9 × 15 см', role: 'Основа', url: SHOP + '/nabory-i-moduli-dlya-proektirovaniya-i-razrabotki/sredstva-proektirovaniya-i-razrabotki-32/maketnye-platy-3802', status: 'shop-unverified', note: 'На сайте подтверждена только 60 × 55 мм — посмотреть раздел в магазине.' },
];

export type BlockId =
  | 'mcu' | 'pwr' | 'bt'
  | 'in_tps' | 'in_map' | 'in_cht' | 'in_iat' | 'in_vbat' | 'in_o2' | 'in_crank' | 'in_sw'
  | 'out_coil1' | 'out_coil2' | 'out_inj' | 'out_pump' | 'out_heater' | 'out_iac'
  | 'x_batt' | 'x_tps' | 'x_map' | 'x_cht' | 'x_iat' | 'x_o2' | 'x_hall' | 'x_service' | 'x_kill'
  | 'x_coil1' | 'x_coil2' | 'x_inj' | 'x_pump' | 'x_iac' | 'x_pc';

export interface Block {
  id: BlockId;
  title: string;
  /** На плате ECU или внешнее устройство на двигателе/в лодке. */
  where: 'board' | 'external';
  parts: string;      // что входит
  how: string;        // как работает, одной-двумя фразами
}

export const BLOCKS: Block[] = [
  { id: 'mcu', title: 'Blue Pill STM32F103C6T6', where: 'board', parts: 'A1', how: 'Считает момент искры и длительность впрыска по датчикам. Питается от +5 В, свой стабилизатор даёт +3,3 В.' },
  { id: 'pwr', title: 'Питание', where: 'board', parts: 'F1, F2, D1 SR560, D2 TVS, C1, A5 LM2596, L1, C2', how: '+12 В аккумулятора → предохранитель F1 2 А → диод от переполюсовки → +12V_PROT → модуль LM2596 → +5 В. Через дроссель L1 — отдельные +5 В датчикам. Катушки, форсунка, насос и нагреватель питаются от аккумулятора через свой предохранитель F2 10 А.' },
  { id: 'bt', title: 'Bluetooth HC-06', where: 'board', parts: 'A2, R 1 кОм × 2, C2', how: 'Мост UART ↔ Bluetooth, 115200 бод. Вместо него к тем же контактам можно подключить USB-UART.' },
  { id: 'in_tps', title: 'Вход TPS', where: 'board', parts: 'R 10 кОм, R 20 кОм, R 1 кОм, C 0,1 мкФ, D6', how: 'Делитель 10к/20к снижает 0–5 В датчика до 0–3,3 В (×0,667), RC-фильтр и диоды защищают вход АЦП.' },
  { id: 'in_map', title: 'Вход MAP', where: 'board', parts: 'R 10 кОм, R 20 кОм, R 1 кОм, C 0,1 мкФ, D7', how: 'Та же цепь, что у TPS: делитель ×0,667 и фильтр.' },
  { id: 'in_cht', title: 'Вход CHT', where: 'board', parts: 'R 2,4 кОм + 91 Ом, R 1 кОм, C 0,1 мкФ', how: 'Термистор образует делитель с резистором 2,49 кОм к +3,3 В: чем горячее, тем ниже напряжение.' },
  { id: 'in_iat', title: 'Вход IAT', where: 'board', parts: 'R 2,4 кОм + 91 Ом, R 1 кОм, C 0,1 мкФ', how: 'Как CHT.' },
  { id: 'in_vbat', title: 'Измерение бортсети', where: 'board', parts: 'R 47 кОм, R 10 кОм, C 0,1 мкФ, D8', how: 'Делитель 47к/10к (÷5,7) от +12V_PROT. Именно такой коэффициент заложен в прошивке.' },
  { id: 'in_o2', title: 'Вход лямбды', where: 'board', parts: 'R 10 кОм, C 0,1 мкФ, D9', how: 'Узкополосный датчик 0,1–0,9 В подаётся на АЦП напрямую через 10 кОм.' },
  { id: 'in_crank', title: 'Вход ДПКВ', where: 'board', parts: 'R 4,7 кОм, R 1 кОм, C 1 нФ, D-защита', how: 'Датчик Холла с открытым коллектором подтянут к +3,3 В; прерывание по фронту каждого зуба.' },
  { id: 'in_sw', title: 'Входы SERVICE и STOP', where: 'board', parts: 'R 10 кОм × 2, R 1 кОм × 2, C 1 нФ × 2', how: 'Подтяжка к +3,3 В; замыкание на землю читается как «активно».' },
  { id: 'out_coil1', title: 'Ключ катушки 1', where: 'board', parts: 'Q3, Q4 AO3400A, Q1 IRGS14C40L, R 10 кОм, R 1 кОм, R 470 Ом', how: 'Два каскада на AO3400A поднимают 3,3 В до 5 В на затворе IGBT без инверсии. IGBT замыкает минус катушки на массу на время накопления; искра — в момент выключения.' },
  { id: 'out_coil2', title: 'Ключ катушки 2', where: 'board', parts: 'Q5, Q6 AO3400A, Q2 IRGS14C40L, R 10 кОм, R 1 кОм, R 470 Ом', how: 'Как канал 1, сдвиг 180° по коленвалу.' },
  { id: 'out_inj', title: 'Ключ форсунки', where: 'board', parts: 'Q7 IRLZ44N, R 100 Ом, R 100 кОм, D3 1N4007', how: 'MOSFET замыкает минус форсунки на массу на время впрыска. Диод гасит выброс при закрытии.' },
  { id: 'out_pump', title: 'Ключ реле насоса', where: 'board', parts: 'Q9 BC547C, R 1 кОм, R 10 кОм, D5 1N4007', how: 'Транзистор включает обмотку реле K1; реле подаёт +12 В на насос.' },
  { id: 'out_heater', title: 'Ключ нагревателя лямбды', where: 'board', parts: 'Q8 IRLZ44N, R 100 Ом, R 100 кОм, D4 1N4007', how: 'ШИМ 10 Гц: плавный прогрев датчика от 20 % до заданной скважности.' },
  { id: 'out_iac', title: 'Драйвер РХХ', where: 'board', parts: 'U3 L293DD, C 0,1 мкФ, C 47 мкФ, R 10 кОм (PC13)', how: 'Два моста управляют двумя обмотками шагового регулятора. PA8 разрешает работу; PC13 подтянут к +3,3 В.' },
  { id: 'x_batt', title: 'Аккумулятор 12 В', where: 'external', parts: '', how: 'Питание всей системы. Минус — общая масса двигателя.' },
  { id: 'x_tps', title: 'Датчик дросселя (TPS)', where: 'external', parts: '', how: 'Потенциометр: +5 В, масса, сигнал 0,2–4,8 В.' },
  { id: 'x_map', title: 'Датчик давления MPX4115AP', where: 'external', parts: 'B2', how: '+5 В, масса, сигнал: около 4,0 В при атмосферном давлении.' },
  { id: 'x_cht', title: 'Термистор головки (CHT)', where: 'external', parts: 'RT1', how: 'NTC 10 кОм при 25 °C.' },
  { id: 'x_iat', title: 'Термистор воздуха (IAT)', where: 'external', parts: 'RT2', how: 'NTC 10 кОм при 25 °C.' },
  { id: 'x_o2', title: 'Лямбда-зонд', where: 'external', parts: '', how: 'Сигнал 0,1–0,9 В после прогрева; нагреватель питается от +12 В через ключ.' },
  { id: 'x_hall', title: 'Датчик коленвала SS441A', where: 'external', parts: 'B1', how: 'Открытый коллектор: «0» напротив зуба (магнита), «1» в промежутке.' },
  { id: 'x_service', title: 'Перемычка SERVICE', where: 'external', parts: '', how: 'Замкнута — разрешены запись настроек и тесты.' },
  { id: 'x_kill', title: 'Аварийная чека STOP', where: 'external', parts: '', how: 'Замыкание на массу глушит двигатель: нет искры, нет топлива, насос выключен.' },
  { id: 'x_coil1', title: 'Катушка зажигания 1', where: 'external', parts: '', how: 'Плюс — от +12 В через предохранитель 10 А, минус — на ключ.' },
  { id: 'x_coil2', title: 'Катушка зажигания 2', where: 'external', parts: '', how: 'Плюс — от +12 В через предохранитель 10 А, минус — на ключ.' },
  { id: 'x_inj', title: 'Форсунка Bosch 0 280 158 117', where: 'external', parts: '', how: 'Высокоомная, около 12 Ом. Плюс — от +12 В, минус — на ключ.' },
  { id: 'x_pump', title: 'Реле K1 и бензонасос', where: 'external', parts: 'K1', how: 'Обмотка реле: +12 В и ключ. Контакты 30/87 подают питание на насос.' },
  { id: 'x_iac', title: 'Регулятор холостого хода', where: 'external', parts: '', how: 'Биполярный шаговый двигатель, две обмотки.' },
  { id: 'x_pc', title: 'Компьютер с программой', where: 'external', parts: 'A3', how: 'Связь по Bluetooth или через USB-UART.' },
];

export type NetKind = 'power' | 'ground' | 'analog' | 'logic' | 'pwm' | 'serial' | 'hv';

export interface NetDef {
  id: string;
  name: string;         // короткое имя цепи
  title: string;        // что это по-человечески
  kind: NetKind;
  /** Цвет провода на 3D-схеме (RGB 0..1). */
  color: [number, number, number];
  /** Блоки, которые соединяет цепь (первый — источник сигнала). */
  path: BlockId[];
  /** Вывод Blue Pill, если цепь приходит на контроллер. */
  mcuPin?: string;
  /** Куда ставить красный щуп. Чёрный — всегда на массу платы (GND), если не сказано иное. */
  probeAt: string;
}

const C = {
  red: [0.9, 0.16, 0.14], orange: [0.96, 0.5, 0.1], yellow: [0.95, 0.82, 0.15], green: [0.2, 0.75, 0.3], blue: [0.2, 0.45, 0.95],
  violet: [0.6, 0.35, 0.9], white: [0.9, 0.9, 0.9], grey: [0.5, 0.52, 0.55], black: [0.08, 0.08, 0.09], brown: [0.5, 0.3, 0.15],
  pink: [0.95, 0.45, 0.65], cyan: [0.2, 0.8, 0.85],
} as const satisfies Record<string, [number, number, number]>;

export const NETS: NetDef[] = [
  { id: 'BAT', name: 'BAT+', title: 'Плюс аккумулятора', kind: 'power', color: C.red, path: ['x_batt', 'pwr'], probeAt: 'клемма «+12 В» платы, до предохранителя F1' },
  { id: 'V12', name: '+12V_PROT', title: 'Защищённые +12 В', kind: 'power', color: C.orange, path: ['pwr', 'in_vbat', 'out_iac', 'x_coil1', 'x_coil2', 'x_inj', 'x_pump', 'x_o2'], probeAt: 'катод диода D1 (полоска) или плюс конденсатора C1' },
  { id: 'V5', name: '+5V_ECU', title: 'Питание контроллера +5 В', kind: 'power', color: C.pink, path: ['pwr', 'mcu', 'bt', 'out_coil1', 'out_coil2', 'out_iac'], probeAt: 'выход OUT+ модуля LM2596 или контакт «5V» Blue Pill' },
  { id: 'V5S', name: '+5V_SENS', title: 'Питание датчиков +5 В', kind: 'power', color: C.violet, path: ['pwr', 'x_tps', 'x_map', 'x_hall'], probeAt: 'после дросселя L1, контакт «+5» разъёма датчика' },
  { id: 'V33', name: '+3V3', title: 'Опорные +3,3 В', kind: 'power', color: C.yellow, path: ['mcu', 'in_cht', 'in_iat', 'in_crank', 'in_sw', 'out_iac'], probeAt: 'контакт «3V3» Blue Pill' },
  { id: 'GND', name: 'GND', title: 'Масса', kind: 'ground', color: C.black, path: ['x_batt', 'pwr', 'mcu'], probeAt: 'минус аккумулятора — относительно массы платы' },

  { id: 'TPS_SIG', name: 'TPS', title: 'Сигнал датчика дросселя', kind: 'analog', color: C.green, path: ['x_tps', 'in_tps'], probeAt: 'сигнальный контакт разъёма TPS' },
  { id: 'PA0', name: 'PA0', title: 'TPS на входе АЦП', kind: 'analog', color: C.green, path: ['in_tps', 'mcu'], mcuPin: 'PA0', probeAt: 'контакт PA0 Blue Pill' },
  { id: 'MAP_SIG', name: 'MAP', title: 'Сигнал датчика давления', kind: 'analog', color: C.cyan, path: ['x_map', 'in_map'], probeAt: 'выход датчика MPX4115 (вывод 1)' },
  { id: 'PA1', name: 'PA1', title: 'MAP на входе АЦП', kind: 'analog', color: C.cyan, path: ['in_map', 'mcu'], mcuPin: 'PA1', probeAt: 'контакт PA1 Blue Pill' },
  { id: 'PA4', name: 'PA4', title: 'Термистор головки (CHT)', kind: 'analog', color: C.brown, path: ['x_cht', 'in_cht', 'mcu'], mcuPin: 'PA4', probeAt: 'контакт PA4 Blue Pill или сигнальный провод термистора' },
  { id: 'PA5', name: 'PA5', title: 'Термистор воздуха (IAT)', kind: 'analog', color: C.brown, path: ['x_iat', 'in_iat', 'mcu'], mcuPin: 'PA5', probeAt: 'контакт PA5 Blue Pill или сигнальный провод термистора' },
  { id: 'PA6', name: 'PA6', title: 'Бортсеть после делителя', kind: 'analog', color: C.orange, path: ['in_vbat', 'mcu'], mcuPin: 'PA6', probeAt: 'контакт PA6 Blue Pill' },
  { id: 'PA7', name: 'PA7', title: 'Сигнал лямбда-зонда', kind: 'analog', color: C.white, path: ['x_o2', 'in_o2', 'mcu'], mcuPin: 'PA7', probeAt: 'контакт PA7 Blue Pill' },
  { id: 'PB5', name: 'PB5', title: 'Датчик коленвала', kind: 'logic', color: C.blue, path: ['x_hall', 'in_crank', 'mcu'], mcuPin: 'PB5', probeAt: 'контакт PB5 Blue Pill или выход датчика Холла' },
  { id: 'PB13', name: 'PB13', title: 'Перемычка SERVICE', kind: 'logic', color: C.grey, path: ['x_service', 'in_sw', 'mcu'], mcuPin: 'PB13', probeAt: 'контакт PB13 Blue Pill' },
  { id: 'PB12', name: 'PB12', title: 'Аварийная чека STOP', kind: 'logic', color: C.grey, path: ['x_kill', 'in_sw', 'mcu'], mcuPin: 'PB12', probeAt: 'контакт PB12 Blue Pill' },

  { id: 'PA9', name: 'PA9', title: 'Передача ECU → программа (TX)', kind: 'serial', color: C.yellow, path: ['mcu', 'bt', 'x_pc'], mcuPin: 'PA9', probeAt: 'контакт PA9 Blue Pill (RXD модуля HC-06)' },
  { id: 'PA10', name: 'PA10', title: 'Приём программа → ECU (RX)', kind: 'serial', color: C.green, path: ['x_pc', 'bt', 'mcu'], mcuPin: 'PA10', probeAt: 'контакт PA10 Blue Pill (TXD модуля HC-06)' },
  { id: 'PB14', name: 'PB14', title: 'Состояние Bluetooth (STATE)', kind: 'logic', color: C.blue, path: ['bt', 'mcu'], mcuPin: 'PB14', probeAt: 'контакт PB14 Blue Pill' },

  { id: 'PB0', name: 'PB0', title: 'Управление катушкой 1', kind: 'pwm', color: C.violet, path: ['mcu', 'out_coil1'], mcuPin: 'PB0', probeAt: 'контакт PB0 Blue Pill' },
  { id: 'G1', name: 'IGN1_GATE', title: 'Затвор IGBT катушки 1', kind: 'pwm', color: C.violet, path: ['out_coil1'], probeAt: 'затвор Q1 (вывод 1)' },
  { id: 'COIL1', name: 'COIL1−', title: 'Минус первичной обмотки катушки 1', kind: 'hv', color: C.red, path: ['out_coil1', 'x_coil1'], probeAt: 'коллектор Q1 / минус катушки 1' },
  { id: 'PB1', name: 'PB1', title: 'Управление катушкой 2', kind: 'pwm', color: C.pink, path: ['mcu', 'out_coil2'], mcuPin: 'PB1', probeAt: 'контакт PB1 Blue Pill' },
  { id: 'G2', name: 'IGN2_GATE', title: 'Затвор IGBT катушки 2', kind: 'pwm', color: C.pink, path: ['out_coil2'], probeAt: 'затвор Q2 (вывод 1)' },
  { id: 'COIL2', name: 'COIL2−', title: 'Минус первичной обмотки катушки 2', kind: 'hv', color: C.red, path: ['out_coil2', 'x_coil2'], probeAt: 'коллектор Q2 / минус катушки 2' },
  { id: 'PB10', name: 'PB10', title: 'Управление форсункой', kind: 'pwm', color: C.cyan, path: ['mcu', 'out_inj'], mcuPin: 'PB10', probeAt: 'контакт PB10 Blue Pill' },
  { id: 'INJ', name: 'INJ−', title: 'Минус форсунки', kind: 'pwm', color: C.cyan, path: ['out_inj', 'x_inj'], probeAt: 'сток Q7 / минус форсунки' },
  { id: 'PB11', name: 'PB11', title: 'Управление реле насоса', kind: 'logic', color: C.green, path: ['mcu', 'out_pump'], mcuPin: 'PB11', probeAt: 'контакт PB11 Blue Pill' },
  { id: 'RELAY', name: 'RELAY−', title: 'Минус обмотки реле насоса', kind: 'logic', color: C.green, path: ['out_pump', 'x_pump'], probeAt: 'коллектор Q9 / контакт 85 реле' },
  { id: 'PB15', name: 'PB15', title: 'Управление нагревателем лямбды', kind: 'pwm', color: C.white, path: ['mcu', 'out_heater'], mcuPin: 'PB15', probeAt: 'контакт PB15 Blue Pill' },
  { id: 'HEAT', name: 'HEATER−', title: 'Минус нагревателя лямбды', kind: 'pwm', color: C.white, path: ['out_heater', 'x_o2'], probeAt: 'сток Q8 / минус нагревателя' },
  { id: 'IAC_IN', name: 'PB6…PB9', title: 'Фазы шагового РХХ (логика)', kind: 'logic', color: C.yellow, path: ['mcu', 'out_iac'], mcuPin: 'PB6', probeAt: 'контакты PB6, PB7, PB8, PB9 Blue Pill' },
  { id: 'PA8', name: 'PA8', title: 'Разрешение драйвера РХХ', kind: 'logic', color: C.orange, path: ['mcu', 'out_iac'], mcuPin: 'PA8', probeAt: 'контакт PA8 Blue Pill (выводы EN1, EN2 микросхемы L293D)' },
  { id: 'PC13', name: 'PC13', title: 'Исправность драйвера РХХ', kind: 'logic', color: C.grey, path: ['out_iac', 'mcu'], mcuPin: 'PC13', probeAt: 'контакт PC13 Blue Pill' },
  { id: 'IAC_OUT', name: 'IAC A/B', title: 'Обмотки РХХ', kind: 'pwm', color: C.yellow, path: ['out_iac', 'x_iac'], probeAt: 'выходы L293D: щупы на оба конца одной обмотки' },
];

/** Один период сигнала для рисования осциллограммы. */
export interface Waveform {
  periodMs: number;
  /** Точки [время, мс; напряжение, В] одного периода, от 0 до periodMs. */
  points: [number, number][];
  vMin: number;
  vMax: number;
  /** Рекомендуемые настройки осциллографа. */
  vDiv: string;
  tDiv: string;
  caption: string;
}

export type Verdict = 'ok' | 'info' | 'warn';

export interface Probe {
  /** Ожидаемое показание мультиметра в режиме постоянного напряжения, В (среднее значение). */
  volts: number;
  /** Допустимый диапазон, В. */
  lo: number;
  hi: number;
  meterMode: string;
  /** Что это значит сейчас. */
  now: string;
  /** Типовые значения по режимам. */
  states: { label: string; value: string }[];
  wave: Waveform | null;
  /** Что проверить, если показание не совпало. */
  ifWrong: string;
  danger?: string;
  /** Если законны несколько уровней (логический вход в неизвестном положении) — все допустимые значения, В. */
  levels?: number[];
}

const fmtV = (v: number, d = 2) => v.toFixed(d).replace('.', ',') + ' В';
/** Число с десятичной запятой. */
const n = (v: number, d = 1) => v.toFixed(d).replace('.', ',');

function ntcVolts(tC: number): number {
  const r = 10000 * Math.exp(3950 * (1 / (tC + 273.15) - 1 / 298.15));
  return (3.3 * r) / (r + 2490);
}

function square(period: number, high: number, vLo: number, vHi: number): [number, number][] {
  const h = Math.max(period * 0.002, Math.min(period * 0.998, high));
  return [[0, vHi], [h, vHi], [h, vLo], [period, vLo], [period, vHi]];
}
const flat = (v: number): [number, number][] => [[0, v], [1, v]];
const DCWAVE = (v: number, caption = 'Ровная линия'): Waveform => ({ periodMs: 1, points: flat(v), vMin: Math.min(0, v), vMax: Math.max(5, v * 1.2), vDiv: v > 6 ? '5 В/дел' : '1 В/дел', tDiv: '10 мс/дел', caption });

/**
 * Что должно быть на цепи прямо сейчас. t — последняя телеметрия
 * (или null, если связи нет: тогда берётся состояние «зажигание включено, двигатель стоит»).
 */
export function probeNet(id: string, t: Telemetry | null, dwellParamUs = 1600): Probe {
  const rpm = t?.rpm ?? 0, running = rpm > 0 && !!t?.sync;
  const batt = (t?.batteryMv ?? 12600) / 1000;
  const v12 = Math.max(0, batt);            // прошивка измеряет уже после диода
  const revMs = running ? 60000 / rpm : 0;
  const base = { meterMode: 'Постоянное напряжение, предел 20 В', wave: null as Waveform | null };
  switch (id) {
    case 'BAT':
      return { ...base, volts: v12 + 0.4, lo: 11.0, hi: 15.0, now: `На ${fmtV(0.4, 1)} выше, чем показывает программа (падение на диоде D1).`, states: [{ label: 'Двигатель стоит', value: '12,2–12,8 В' }, { label: 'Двигатель работает', value: '13,5–14,5 В' }], wave: DCWAVE(v12 + 0.4, 'Ровная линия; при работе допустима рябь до 0,5 В'), ifWrong: 'Ниже 11 В — разряжен аккумулятор или плохой контакт клемм. Выше 15 В — неисправен регулятор напряжения.' };
    case 'V12':
      return { ...base, volts: v12, lo: 10.5, hi: 14.8, now: `Программа показывает бортсеть ${fmtV(batt)} — на этой цепи должно быть столько же.`, states: [{ label: 'Двигатель стоит', value: '11,8–12,4 В' }, { label: 'Двигатель работает', value: '13,1–14,1 В' }], wave: DCWAVE(v12), ifWrong: '0 В при наличии BAT+ — сгорел предохранитель F1 или диод D1 впаян наоборот. Отличие от показаний программы больше 0,3 В — проверить делитель 47к/10к на входе PA6.' };
    case 'V5':
      return { ...base, volts: 5.0, lo: 4.85, hi: 5.15, now: 'Постоянно 5,0 В при любом режиме.', states: [{ label: 'Всегда', value: '4,85–5,15 В' }], wave: DCWAVE(5, 'Ровная линия; рябь не больше 0,1 В'), ifWrong: 'Не 5 В — подстроить LM2596 (без Blue Pill!). Больше 5,5 В опасно для контроллера и датчиков.' };
    case 'V5S':
      return { ...base, volts: 5.0, lo: 4.8, hi: 5.15, now: 'Постоянно 5,0 В.', states: [{ label: 'Всегда', value: '4,8–5,15 В' }], wave: DCWAVE(5), ifWrong: 'Просадка — короткое замыкание в проводке датчика. Отключать датчики по одному.' };
    case 'V33':
      return { ...base, volts: 3.3, lo: 3.2, hi: 3.4, now: 'Постоянно 3,3 В от стабилизатора Blue Pill.', states: [{ label: 'Всегда', value: '3,2–3,4 В' }], wave: DCWAVE(3.3), ifWrong: 'Нет 3,3 В при наличии 5 В — неисправен стабилизатор на Blue Pill или замыкание на плате.' };
    case 'GND':
      return { ...base, volts: 0, lo: -0.1, hi: 0.1, now: 'Между минусом аккумулятора и массой платы — не больше 0,1 В.', states: [{ label: 'Всегда', value: '0,00–0,10 В' }], wave: DCWAVE(0), ifWrong: 'Больше 0,1 В — плохая масса: зачистить контакт, увеличить сечение провода. Плохая масса даёт ложные показания всех датчиков.' };
    case 'TPS_SIG': case 'PA0': {
      const pin = ((t?.tpsRaw ?? 420) * 3.3) / 4095, sig = pin * 1.5, atPin = id === 'PA0', v = atPin ? pin : sig;
      return { ...base, volts: v, lo: atPin ? 0.1 : 0.15, hi: atPin ? 3.25 : 4.9, now: `Дроссель ${n((t?.tps10 ?? 0) / 10)} %, АЦП ${t?.tpsRaw ?? '—'}: ${atPin ? 'на входе' : 'на датчике'} ${fmtV(v)}.`, states: atPin ? [{ label: 'Закрыт', value: '≈ 0,34 В' }, { label: 'Открыт полностью', value: '≈ 3,00 В' }] : [{ label: 'Закрыт', value: '≈ 0,5 В' }, { label: 'Открыт полностью', value: '≈ 4,5 В' }], wave: DCWAVE(v, 'Плавно растёт при открытии дросселя, без провалов'), ifWrong: atPin ? 'На датчике верно, а здесь нет — проверить резисторы 10к/20к делителя (должно быть ×0,667).' : '0 В — нет питания +5V_SENS или обрыв. 5 В — обрыв массы датчика. Провалы при повороте — изношен потенциометр.' };
    }
    case 'MAP_SIG': case 'PA1': {
      const sig = (((t?.map10 ?? 1013) - 200) * 80) / 19 / 1000 + 0.5, pin = sig / 1.5, atPin = id === 'PA1', v = atPin ? pin : sig;
      return { ...base, volts: v, lo: atPin ? 0.15 : 0.25, hi: atPin ? 3.2 : 4.8, now: `Давление ${n((t?.map10 ?? 1013) / 10)} кПа: ${fmtV(v)}.`, states: atPin ? [{ label: 'Атмосфера (двигатель стоит)', value: '≈ 2,61 В' }, { label: 'Холостой ход', value: '0,8–1,5 В' }] : [{ label: 'Атмосфера (двигатель стоит)', value: '≈ 3,92 В' }, { label: 'Холостой ход', value: '1,2–2,2 В' }], wave: DCWAVE(v, 'На работающем моторе — пульсации с частотой впуска'), ifWrong: 'На стоящем двигателе должно быть около 3,9 В на датчике. Иначе — нет питания +5V_SENS, обрыв массы или неисправен датчик.' };
    }
    case 'PA4': case 'PA5': {
      const tc = (id === 'PA4' ? t?.cht10 ?? 200 : t?.iat10 ?? 200) / 10, v = ntcVolts(tc);
      return { ...base, volts: v, lo: 0.1, hi: 3.2, now: `Температура ${n(tc)} °C: ${fmtV(v)}.`, states: [{ label: '0 °C', value: fmtV(ntcVolts(0)) }, { label: '20 °C', value: fmtV(ntcVolts(20)) }, { label: '70 °C', value: fmtV(ntcVolts(70)) }, { label: '100 °C', value: fmtV(ntcVolts(100)) }], wave: DCWAVE(v), ifWrong: '3,3 В — обрыв термистора или разъёма. 0 В — замыкание провода на массу. Отключённый термистор при 25 °C должен показывать 10 кОм.' };
    }
    case 'PA6': {
      const v = batt / 5.7;
      return { ...base, volts: v, lo: 1.8, hi: 2.65, now: `Бортсеть ${fmtV(batt)} ÷ 5,7 = ${fmtV(v)}.`, states: [{ label: '12,0 В', value: '2,11 В' }, { label: '14,0 В', value: '2,46 В' }], wave: DCWAVE(v), ifWrong: 'Не сходится с расчётом — не те номиналы делителя. Должны быть 47 кОм сверху и 10 кОм снизу.' };
    }
    case 'PA7': {
      const v = (t?.o2Mv ?? 450) / 1000, active = running && (t?.heater ?? 0) >= 50;
      const wave: Waveform = active
        ? { periodMs: 700, points: [[0, 0.1], [60, 0.82], [350, 0.82], [410, 0.1], [700, 0.1]], vMin: 0, vMax: 1, vDiv: '0,2 В/дел', tDiv: '200 мс/дел', caption: 'Прогретый датчик переключается между ≈0,1 и ≈0,8 В 1–3 раза в секунду' }
        : { ...DCWAVE(0.45, 'Холодный датчик: ровные ≈0,45 В'), vMax: 1, vDiv: '0,2 В/дел' };
      return { ...base, meterMode: 'Постоянное напряжение, предел 2 В', volts: v, lo: 0.05, hi: 0.95, now: active ? `Сейчас ${fmtV(v)} — ${v > 0.75 ? 'богатая смесь' : v < 0.12 ? 'бедная смесь' : 'переход'}.` : 'Датчик не прогрет или двигатель стоит: около 0,45 В.', states: [{ label: 'Холодный', value: '≈ 0,45 В' }, { label: 'Бедная смесь', value: '< 0,12 В' }, { label: 'Богатая смесь', value: '> 0,75 В' }], wave, ifWrong: 'Постоянно 0 В — обрыв сигнала или подсос воздуха. Постоянно 0,9 В — очень богатая смесь. Не меняется после прогрева — датчик неисправен.' };
    }
    case 'PB5': {
      if (!running) return { ...base, levels: [3.3, 0.1], volts: 3.3, lo: 0, hi: 3.4, now: 'Двигатель стоит: 3,3 В, если датчик между зубьями, или около 0 В напротив зуба.', states: [{ label: 'Между зубьями', value: '≈ 3,3 В' }, { label: 'Напротив зуба', value: '< 0,3 В' }, { label: 'Двигатель работает (среднее)', value: '≈ 1,6 В' }], wave: DCWAVE(3.3, 'Проверка: провернуть маховик рукой — уровень должен переключаться'), ifWrong: 'Не переключается при провороте — зазор до венца, питание датчика, полярность магнита.' };
      const tooth = revMs / 36, pts: [number, number][] = [];
      for (let i = 0; i < 8; i++) {
        const t0 = i * tooth;
        if (i === 5) { pts.push([t0, 3.3], [t0 + tooth, 3.3]); continue; } // пропущенный зуб
        pts.push([t0, 0.1], [t0 + tooth / 2, 0.1], [t0 + tooth / 2, 3.3], [t0 + tooth, 3.3], [t0 + tooth, i === 4 ? 3.3 : 0.1]);
      }
      return { ...base, volts: 1.7, lo: 1.2, hi: 2.2, now: `${rpm} об/мин: ${Math.round((rpm / 60) * 36)} Гц, период зуба ${n(tooth * 1000, 0)} мкс. Мультиметр показывает среднее ≈ 1,7 В.`, states: [{ label: 'Холостой ход 1100 об/мин', value: '660 Гц' }, { label: '6000 об/мин', value: '3600 Гц' }], wave: { periodMs: tooth * 8, points: pts, vMin: 0, vMax: 3.6, vDiv: '1 В/дел', tDiv: tooth > 1 ? '1 мс/дел' : '200 мкс/дел', caption: 'Прямоугольник 0–3,3 В, один раз за оборот — пауза в два зуба (пропуск 36-1)' }, ifWrong: 'Нет паузы раз в оборот — программа не получит синхронизацию. Неровные импульсы — помехи: экранированный провод, конденсатор 1 нФ на входе.' };
    }
    case 'PB13': {
      // Телеметрия передаёт не саму перемычку, а «запись разрешена» (перемычка И двигатель стоит).
      const closed = !!t?.service;
      return { ...base, levels: closed ? [0] : rpm > 0 ? [3.3, 0] : [3.3], volts: closed ? 0 : 3.3, lo: 0, hi: 3.4, now: closed ? 'Перемычка замкнута: 0 В, запись разрешена.' : 'Перемычка снята — 3,3 В; установлена — 0 В. На работающем двигателе программа показывает «запись запрещена» при любом положении перемычки.', states: [{ label: 'Перемычка снята', value: '≈ 3,3 В' }, { label: 'Перемычка установлена', value: '≈ 0 В' }], wave: null, ifWrong: 'Всегда 0 В — замыкание на массу. Всегда 3,3 В при установленной перемычке — обрыв провода перемычки.' };
    }
    case 'PB12': {
      const kill = !!t?.kill;
      return { ...base, volts: kill ? 0 : 3.3, lo: 0, hi: 3.4, now: kill ? 'Чека активна (STOP): 0 В. Искра и топливо отключены.' : 'Рабочее положение: 3,3 В.', states: [{ label: 'Работа', value: '≈ 3,3 В' }, { label: 'STOP', value: '≈ 0 В' }], wave: null, ifWrong: 'Двигатель не заводится и здесь 0 В — чека замкнута на массу или перетёрся провод.' };
    }
    case 'PA9':
      return { ...base, volts: 3.1, lo: 2.6, hi: 3.35, now: 'Покой 3,3 В; десять раз в секунду — пачка данных (~13 мс). Мультиметр показывает чуть меньше 3,3 В.', states: [{ label: 'Нет передачи', value: '3,3 В' }, { label: 'Телеметрия 10 Гц', value: '≈ 3,0–3,2 В' }], wave: { periodMs: 100, points: [[0, 3.3], [0, 0.1], [1, 0.1], [1, 3.3], [2, 3.3], [2, 0.1], [2.6, 0.1], [2.6, 3.3], [4, 3.3], [4, 0.1], [5, 0.1], [5, 3.3], [7, 3.3], [7, 0.1], [7.5, 0.1], [7.5, 3.3], [9, 3.3], [9, 0.1], [11, 0.1], [11, 3.3], [13, 3.3], [100, 3.3]], vMin: 0, vMax: 3.6, vDiv: '1 В/дел', tDiv: '10 мс/дел', caption: 'Пачки импульсов 0–3,3 В каждые 100 мс; один бит — 8,7 мкс' }, ifWrong: 'Ровные 3,3 В без пачек — прошивка не работает (проверить BOOT0 = 0, питание). 0 В — замыкание.' };
    case 'PA10':
      return { ...base, volts: 3.3, lo: 2.8, hi: 3.4, now: 'Покой 3,3 В; импульсы только когда программа посылает команду.', states: [{ label: 'Нет команд', value: '3,3 В' }], wave: { periodMs: 500, points: [[0, 3.3], [200, 3.3], [200, 0.1], [200.6, 0.1], [200.6, 3.3], [201.2, 3.3], [201.2, 0.1], [202, 0.1], [202, 3.3], [500, 3.3]], vMin: 0, vMax: 3.6, vDiv: '1 В/дел', tDiv: '50 мс/дел', caption: 'Короткие пачки при каждой команде (PING раз в полсекунды)' }, ifWrong: 'ECU не отвечает, а здесь нет импульсов — перепутаны TX/RX или HC-06 не сопряжён. Два источника на этом контакте (HC-06 и USB-UART одновременно) дают ≈1,6 В.' };
    case 'PB14':
      return { ...base, levels: [3.3, 0], volts: t?.bt ? 3.3 : 0, lo: 0, hi: 3.4, now: t?.bt ? 'Bluetooth соединён: 3,3 В.' : 'Нет соединения: 0 В (или мигание у некоторых модулей).', states: [{ label: 'Соединён', value: '≈ 3,3 В' }, { label: 'Не соединён', value: '0 В / мигает' }], wave: null, ifWrong: 'На работу не влияет: прошивка только показывает это состояние.' };
    case 'PB0': case 'PB1': case 'G1': case 'G2': case 'COIL1': case 'COIL2': {
      const dwellMs = (t?.preparedDwellUs || coilDwell(dwellParamUs, batt * 1000)) / 1000;
      const gate = id === 'G1' || id === 'G2', coil = id === 'COIL1' || id === 'COIL2', hi = gate ? 5 : 3.3;
      if (coil) {
        const pts: [number, number][] = running ? [[0, v12], [0, 0.9], [dwellMs, 1.3], [dwellMs, 60], [dwellMs + 0.05, 60], [dwellMs + 0.12, 32], [dwellMs + 1.0, 28], [dwellMs + 1.1, v12 + 6], [dwellMs + 1.4, v12 - 4], [dwellMs + 1.8, v12], [revMs, v12]] : flat(v12);
        return { ...base, volts: running ? v12 * (1 - dwellMs / revMs) : v12, lo: 8, hi: 15, now: running ? `Импульс накопления ${n(dwellMs, 2)} мс раз в оборот (${n(revMs)} мс), затем выброс до ≈400 В.` : 'Двигатель стоит: постоянно +12 В через обмотку катушки.', states: [{ label: 'Двигатель стоит', value: fmtV(v12, 1) }, { label: 'Работает', value: 'чуть ниже +12 В (среднее)' }], wave: { periodMs: running ? revMs : 1, points: pts, vMin: 0, vMax: 60, vDiv: '10 В/дел (щуп 1:10 обязателен)', tDiv: '1 мс/дел', caption: 'Спад до ≈1 В на время накопления, затем пик (на экране обрезан: реально ≈400 В) и «полка» горения искры ≈1 мс' }, ifWrong: 'Нет спада — не открывается IGBT (проверить затвор: 5 В в импульсе). Нет пика — обрыв катушки. Постоянно ≈1 В — ключ пробит, катушка греется: немедленно выключить.', danger: 'До 400 В! Мультиметром в режиме сопротивления и щупом 1:1 не измерять. Осциллограф — только со щупом 1:10 на 600 В.' };
      }
      const avg = running ? (hi * dwellMs) / revMs : 0;
      return { ...base, volts: avg, lo: 0, hi: hi * 0.4, now: running ? `Импульс ${hi} В длиной ${n(dwellMs, 2)} мс раз в оборот; мультиметр покажет среднее ≈ ${fmtV(avg)}.` : `Двигатель стоит: 0 В. При тесте катушки — одиночный импульс 1 мс.`, states: [{ label: 'Двигатель стоит', value: '0 В' }, { label: 'Амплитуда импульса', value: `${hi} В` }, { label: 'Длительность', value: `${n(dwellMs, 2)} мс` }], wave: { periodMs: running ? revMs : 10, points: running ? square(revMs, dwellMs, 0, hi) : [[0, 0], [10, 0]], vMin: 0, vMax: hi + 0.5, vDiv: '1 В/дел', tDiv: revMs > 20 ? '5 мс/дел' : '2 мс/дел', caption: `Положительный импульс ${hi} В; конец импульса — момент искры` }, ifWrong: gate ? 'На PB0/PB1 импульс есть, а здесь меньше 4,5 В — проверить Q3–Q6 и подтяжку 470 Ом к +5 В. Постоянно 5 В при стоящем двигателе — катушка под током, выключить питание.' : 'Нет импульсов на работающем двигателе — нет синхронизации, активна чека или сработала отсечка.' };
    }
    case 'PB10': case 'INJ': {
      const pw = (t?.pwUs ?? 0) / 1000, per = running ? revMs / 2 : 0, cut = !!t?.fuelCut, act = running && !cut;
      if (id === 'PB10') {
        const avg = act ? (3.3 * pw) / per : 0;
        return { ...base, volts: avg, lo: 0, hi: 3.0, now: act ? `Импульс ${n(pw, 2)} мс дважды за оборот (каждые ${n(per)} мс); среднее ≈ ${fmtV(avg)}.` : cut && running ? 'Отсечка топлива: импульсов нет.' : 'Двигатель стоит: 0 В.', states: [{ label: 'Двигатель стоит', value: '0 В' }, { label: 'Амплитуда', value: '3,3 В' }], wave: { periodMs: act ? per : 10, points: act ? square(per, pw, 0, 3.3) : [[0, 0], [10, 0]], vMin: 0, vMax: 3.6, vDiv: '1 В/дел', tDiv: '2 мс/дел', caption: 'Положительный импульс = форсунка открыта' }, ifWrong: 'Нет импульсов при работающем двигателе — отсечка топлива, чека или нет синхронизации.' };
      }
      const avg = act ? v12 * (1 - pw / per) : v12;
      const pts: [number, number][] = act ? [[0, v12], [0, 0.15], [pw, 0.2], [pw, v12 + 0.8], [pw + 0.6, v12 + 0.8], [pw + 0.9, v12], [per, v12]] : flat(v12);
      return { ...base, volts: avg, lo: 6, hi: 15, now: act ? `Замыкается на массу на ${n(pw, 2)} мс; загрузка форсунки ${n((t?.duty10 ?? 0) / 10)} %. Среднее ≈ ${fmtV(avg, 1)}.` : 'Форсунка закрыта: +12 В через обмотку.', states: [{ label: 'Закрыта', value: fmtV(v12, 1) }, { label: 'Открыта', value: '< 0,3 В' }], wave: { periodMs: act ? per : 1, points: pts, vMin: 0, vMax: 20, vDiv: '5 В/дел', tDiv: '2 мс/дел', caption: 'Спад до ≈0 В на время впрыска; после закрытия — ступенька на 0,8 В выше питания (диод D3)' }, ifWrong: '0 В постоянно — пробит Q7 или замыкание: форсунка льёт, топливо отключить немедленно. Нет +12 В — обрыв форсунки или предохранитель F2.' };
    }
    case 'PB11': case 'RELAY': {
      const on = !!((t?.outputMask ?? 0) & 8);
      if (id === 'PB11') return { ...base, volts: on ? 3.3 : 0, lo: 0, hi: 3.4, now: on ? 'Насос включён: 3,3 В.' : 'Насос выключен: 0 В.', states: [{ label: 'Первые 2 с после включения', value: '3,3 В' }, { label: 'Двигатель работает', value: '3,3 В' }, { label: 'Стоит дольше 1 с', value: '0 В' }], wave: null, ifWrong: 'Не включается на 2 с при подаче питания — активна чека STOP.' };
      return { ...base, volts: on ? 0.15 : v12, lo: 0, hi: 15, now: on ? 'Реле включено: около 0,1–0,3 В.' : 'Реле выключено: +12 В через обмотку.', states: [{ label: 'Выключено', value: fmtV(v12, 1) }, { label: 'Включено', value: '< 0,3 В' }], wave: null, ifWrong: 'На PB11 3,3 В, а здесь +12 В — не открывается Q9 (цоколёвка BC547: К-Б-Э). 0 В всегда — обрыв обмотки реле или нет +12 В.' };
    }
    case 'PB15': case 'HEAT': {
      const d = (t?.heater ?? 0) / 100;
      const w = (lo: number, hi: number, inv: boolean): Waveform => ({ periodMs: 100, points: d > 0 ? square(100, inv ? 100 * (1 - d) : 100 * d, lo, hi) : flat(inv ? hi : lo), vMin: 0, vMax: hi * 1.2 + 0.5, vDiv: hi > 6 ? '5 В/дел' : '1 В/дел', tDiv: '20 мс/дел', caption: `ШИМ 10 Гц, заполнение ${Math.round(d * 100)} %` });
      if (id === 'PB15') return { ...base, volts: 3.3 * d, lo: 0, hi: 2.4, now: d ? `ШИМ ${Math.round(d * 100)} %: среднее ${fmtV(3.3 * d)}.` : 'Нагреватель выключен: 0 В.', states: [{ label: 'Двигатель стоит', value: '0 В' }, { label: 'Первые 2 с работы', value: '20 % → 0,66 В' }, { label: 'Прогрет', value: '70 % → 2,31 В' }], wave: w(0, 3.3, false), ifWrong: 'Нет ШИМ на работающем двигателе — выбран режим широкополосной лямбды (o2_mode = 1) или напряжение вне 9–16,5 В.' };
      return { ...base, volts: v12 * (1 - d), lo: 3, hi: 15, now: d ? `Среднее ≈ ${fmtV(v12 * (1 - d), 1)} при заполнении ${Math.round(d * 100)} %.` : 'Выключен: +12 В через нагреватель.', states: [{ label: 'Выключен', value: fmtV(v12, 1) }, { label: '70 %', value: fmtV(v12 * 0.3, 1) }], wave: w(0.1, v12, true), ifWrong: '0 В при выключенном нагревателе — обрыв нагревателя (у исправного 3–15 Ом) или нет +12 В.' };
    }
    case 'IAC_IN': {
      const moving = t ? t.iacPos !== t.iacTarget || t.actuatorTest === 5 || t.actuatorTest === 6 : false;
      return { ...base, volts: moving ? 1.65 : 3.3, lo: 0, hi: 3.4, now: moving ? `Шток движется (${t!.iacPos} → ${t!.iacTarget}): на каждой фазе меандр, шаг каждые 4 мс.` : `Шток стоит на шаге ${t?.iacPos ?? 0}: на одной фазе 3,3 В, на трёх остальных 0 В.`, levels: moving ? undefined : [3.3, 0], states: [{ label: 'Стоит', value: '3,3 В на одной фазе, 0 В на остальных' }, { label: 'Движется', value: '≈ 1,65 В (среднее)' }], wave: !moving ? null : { periodMs: 16, points: square(16, 8, 0, 3.3), vMin: 0, vMax: 3.6, vDiv: '1 В/дел', tDiv: '5 мс/дел', caption: 'При движении: меандр 62,5 Гц, фазы сдвинуты на четверть периода' }, ifWrong: 'Все четыре фазы 0 В — драйвер запрещён (см. PA8 и PC13).' };
    }
    case 'PA8': {
      const en = !!((t?.outputMask ?? 32) & 32);
      return { ...base, volts: en ? 3.3 : 0, lo: 0, hi: 3.4, now: en ? 'Драйвер разрешён: 3,3 В.' : 'Драйвер запрещён: 0 В — прошивка видит ошибку на PC13.', states: [{ label: 'Норма', value: '3,3 В' }, { label: 'Ошибка драйвера', value: '0 В' }], wave: null, ifWrong: '0 В — проверить подтяжку PC13 к +3,3 В.' };
    }
    case 'PC13': {
      const fault = !!((t?.flags ?? 0) & 128);
      return { ...base, volts: fault ? 0 : 3.3, lo: 0, hi: 3.4, now: fault ? 'Прошивка видит 0 В: «ошибка драйвера РХХ».' : 'Норма: 3,3 В через резистор 10 кОм.', states: [{ label: 'Норма', value: '3,3 В' }], wave: null, ifWrong: 'У L293D нет выхода аварии, поэтому вход должен быть постоянно подтянут к +3,3 В резистором 10 кОм. 0 В — резистор не установлен.' };
    }
    case 'IAC_OUT':
      return { ...base, volts: v12 - 2.6, lo: 6, hi: 13, now: 'Между концами запитанной обмотки ≈ бортсеть минус 2,6 В (потери в L293D); полярность меняется при шагах.', states: [{ label: 'Обмотка под током', value: `± ${fmtV(v12 - 2.6, 1)}` }, { label: 'Драйвер запрещён', value: '0 В' }], wave: { periodMs: 16, points: [[0, v12 - 2.6], [8, v12 - 2.6], [8, -(v12 - 2.6)], [16, -(v12 - 2.6)], [16, v12 - 2.6]], vMin: -14, vMax: 14, vDiv: '5 В/дел', tDiv: '5 мс/дел', caption: 'При движении: двуполярный меандр' }, ifWrong: 'Микросхема горячая — ток обмотки больше 0,6 А: измерить сопротивление обмоток (нужно ≥ 25 Ом). 0 В — нет +12 В на выводе VS или нет разрешения.' };
  }
  return { ...base, volts: 0, lo: 0, hi: 0, now: 'Нет данных по этой цепи.', states: [], ifWrong: '' };
}

/** Итог по перечню: сколько стоит то, что есть в магазине. */
export function bomTotal(): { shop: number; elsewhere: number } {
  let shop = 0, elsewhere = 0;
  for (const b of BOM) { if (b.status === 'elsewhere') elsewhere++; else shop += (b.price ?? 0) * b.qty; }
  return { shop: Math.round(shop), elsewhere };
}

// ---------------------------------------------------------------------------
// Данные принципиальной схемы (страница «Схема»): перечень элементов
// «обозначение → номинал → узел». Резисторы и конденсаторы пронумерованы сквозной нумерацией.

export interface SchemePart {
  ref: string;            // позиционное обозначение
  value: string;          // номинал или тип
  block: BlockId;         // узел, к которому относится
  role: string;           // назначение
  /** Строка BOM: её ref или начало названия. */
  bom?: string;
  /** Что сверить с даташитом или на месте (цоколёвка, номинал взят не из описания блока). */
  verify?: string;
}

const RES = 'R…', CER = 'C3…', JST = 'Набор разъёмов JST', TERM = 'Клеммник';
const P = (ref: string, value: string, block: BlockId, role: string, bom?: string, verify?: string): SchemePart => ({ ref, value, block, role, bom, verify });

export const SCHEME_PARTS: SchemePart[] = [
  // модули
  P('A1', 'Blue Pill STM32F103C6T6', 'mcu', 'Микроконтроллер; стоит в панели из гнёзд PBS-1x20', 'A1'),
  P('A2', 'HC-06', 'bt', 'Мост UART ↔ Bluetooth, 115200 бод', 'A2', 'У плат с 4 контактами вывода STATE нет — тогда PB14 оставить свободным.'),
  P('A3', 'USB-UART PL2303HX', 'x_pc', 'Проводная связь; подключается вместо A2 к тем же контактам', 'A3'),
  P('A4', 'ST-Link V2', 'x_pc', 'Запись прошивки через контакты SWD платы A1', 'A4'),
  P('A5', 'LM2596S, 5,00 В', 'pwr', 'Понижающий преобразователь +12 В → +5 В', 'A5'),
  // питание
  P('GB1', '12 В', 'x_batt', 'Аккумулятор; минус — масса двигателя'),
  P('X1', 'Клеммник 2 конт.', 'pwr', 'Ввод питания от аккумулятора', TERM),
  P('F1', '2 А', 'pwr', 'Предохранитель питания ECU', 'F1'),
  P('F2', '10 А', 'pwr', 'Предохранитель катушек, форсунки, насоса и нагревателя', 'F2'),
  P('D1', 'SR560', 'pwr', 'Защита от переполюсовки (падение около 0,4 В)', 'D1'),
  P('D2', 'SM8S30A', 'pwr', 'Ограничитель выбросов бортсети', 'D2', 'Место установки в исходных данных не задано: показан на +12V_PROT. Параметры сверить по даташиту.'),
  P('C1', '470 мкФ × 25 В', 'pwr', 'Фильтр на входе питания', 'C1'),
  P('C2', '47 мкФ × 63 В', 'pwr', 'Фильтр питания датчиков после дросселя L1', 'C2, C16, C17', 'Место установки в исходных данных не задано однозначно: показан после L1.'),
  P('L1', '47 мкГн', 'pwr', 'Дроссель фильтра питания датчиков', 'L1'),
  // датчики и их разъёмы
  P('RP1', 'Датчик дросселя', 'x_tps', 'Потенциометр: +5 В, сигнал 0,2–4,8 В, масса'),
  P('B1', 'SS441A', 'x_hall', 'Датчик Холла у венца 36-1, выход — открытый коллектор', 'B1', 'Цоколёвка (со стороны маркировки): 1 — питание, 2 — масса, 3 — выход.'),
  P('B2', 'MPX4115AP', 'x_map', 'Датчик абсолютного давления', 'B2', 'Цоколёвка: 1 — выход, 2 — масса, 3 — питание +5 В, 4–6 не подключать.'),
  P('B3', 'Лямбда-зонд', 'x_o2', 'Узкополосный датчик кислорода с нагревателем', undefined, 'Цоколёвка и ток нагревателя конкретного датчика не подтверждены.'),
  P('RT1', 'NTC 10 кОм B3950', 'x_cht', 'Термистор головки цилиндров', 'RT1, RT2'),
  P('RT2', 'NTC 10 кОм B3950', 'x_iat', 'Термистор воздуха на впуске', 'RT1, RT2'),
  P('S1', 'Перемычка SERVICE', 'x_service', 'Замкнута — разрешены запись настроек и тесты'),
  P('S2', 'Чека STOP', 'x_kill', 'Замыкание на массу глушит двигатель'),
  P('X2', 'JST XH 3 конт.', 'in_tps', 'Разъём датчика дросселя', JST),
  P('X3', 'JST XH 3 конт.', 'in_map', 'Разъём датчика давления', JST),
  P('X4', 'JST XH 2 конт.', 'in_cht', 'Разъём термистора головки', JST),
  P('X5', 'JST XH 2 конт.', 'in_iat', 'Разъём термистора воздуха', JST),
  P('X6', 'JST XH 2 конт.', 'in_o2', 'Разъём сигнала лямбда-зонда', JST),
  P('X7', 'JST XH 3 конт.', 'in_crank', 'Разъём датчика коленвала', JST),
  P('X8', 'JST XH 2 конт.', 'in_sw', 'Разъём перемычки SERVICE', JST),
  P('X9', 'JST XH 2 конт.', 'in_sw', 'Разъём аварийной чеки STOP', JST),
  // входные цепи
  P('R1', '10 кОм', 'in_tps', 'Верхнее плечо делителя ×0,667', RES),
  P('R2', '20 кОм', 'in_tps', 'Нижнее плечо делителя', RES),
  P('R3', '1 кОм', 'in_tps', 'Защитный резистор перед входом АЦП', RES),
  P('C3', '0,1 мкФ', 'in_tps', 'Фильтр входа АЦП', CER),
  P('D6', 'BAR43S', 'in_tps', 'Ограничение напряжения на входе: к массе и к +3,3 В', 'D6…D9, D11', 'Цоколёвка SOT-23: 1 — анод (к GND), 2 — катод (к +3V3), 3 — средняя точка (к сигналу).'),
  P('R4', '10 кОм', 'in_map', 'Верхнее плечо делителя ×0,667', RES),
  P('R5', '20 кОм', 'in_map', 'Нижнее плечо делителя', RES),
  P('R6', '1 кОм', 'in_map', 'Защитный резистор перед входом АЦП', RES),
  P('C4', '0,1 мкФ', 'in_map', 'Фильтр входа АЦП', CER),
  P('D7', 'BAR43S', 'in_map', 'Ограничение напряжения на входе', 'D6…D9, D11', 'Цоколёвка — как у D6.'),
  P('R7', '2,4 кОм', 'in_cht', 'Подтяжка термистора к +3,3 В (вместе с R8 — 2,49 кОм)', RES),
  P('R8', '91 Ом', 'in_cht', 'Добавка к R7 до 2,49 кОм', RES),
  P('R9', '1 кОм', 'in_cht', 'Защитный резистор перед входом АЦП', RES),
  P('C5', '0,1 мкФ', 'in_cht', 'Фильтр входа АЦП', CER),
  P('R10', '2,4 кОм', 'in_iat', 'Подтяжка термистора к +3,3 В (вместе с R11 — 2,49 кОм)', RES),
  P('R11', '91 Ом', 'in_iat', 'Добавка к R10 до 2,49 кОм', RES),
  P('R12', '1 кОм', 'in_iat', 'Защитный резистор перед входом АЦП', RES),
  P('C6', '0,1 мкФ', 'in_iat', 'Фильтр входа АЦП', CER),
  P('R13', '47 кОм', 'in_vbat', 'Верхнее плечо делителя ÷5,7', RES),
  P('R14', '10 кОм', 'in_vbat', 'Нижнее плечо делителя', RES),
  P('C7', '0,1 мкФ', 'in_vbat', 'Фильтр входа АЦП', CER),
  P('D8', 'BAR43S', 'in_vbat', 'Ограничение напряжения на входе', 'D6…D9, D11', 'Цоколёвка — как у D6.'),
  P('R15', '10 кОм', 'in_o2', 'Защитный резистор сигнала лямбда-зонда', RES),
  P('C8', '0,1 мкФ', 'in_o2', 'Фильтр входа АЦП', CER),
  P('D9', 'BAR43S', 'in_o2', 'Ограничение напряжения на входе', 'D6…D9, D11', 'Цоколёвка — как у D6.'),
  P('R16', '4,7 кОм', 'in_crank', 'Подтяжка открытого коллектора датчика к +3,3 В', RES),
  P('R17', '1 кОм', 'in_crank', 'Защитный резистор перед входом', RES),
  P('C13', '1 нФ', 'in_crank', 'Фильтр помех', 'C13…C15'),
  P('D11', 'BAR43S', 'in_crank', 'Ограничение напряжения на входе', 'D6…D9, D11', 'В описании блока — «D-защита» без обозначения. Цоколёвка — как у D6.'),
  P('R18', '10 кОм', 'in_sw', 'Подтяжка входа SERVICE к +3,3 В', RES),
  P('R19', '1 кОм', 'in_sw', 'Защитный резистор входа SERVICE', RES),
  P('C14', '1 нФ', 'in_sw', 'Фильтр помех входа SERVICE', 'C13…C15'),
  P('R20', '10 кОм', 'in_sw', 'Подтяжка входа STOP к +3,3 В', RES),
  P('R21', '1 кОм', 'in_sw', 'Защитный резистор входа STOP', RES),
  P('C15', '1 нФ', 'in_sw', 'Фильтр помех входа STOP', 'C13…C15'),
  // связь
  P('R22', '1 кОм', 'bt', 'Защитный резистор линии PA9 → RXD модуля', RES),
  P('R23', '1 кОм', 'bt', 'Защитный резистор линии TXD модуля → PA10', RES),
  P('C16', '47 мкФ × 63 В', 'bt', 'Фильтр питания модуля HC-06', 'C2, C16, C17'),
  // зажигание
  P('R24', '330 Ом', 'out_coil1', 'Резистор в цепи затвора Q3', RES, 'Номинал в описании блока не указан: взят из исходной схемы (330 Ом).'),
  P('R25', '10 кОм', 'out_coil1', 'Подтяжка затвора Q3 к массе: при сбросе контроллера катушка выключена', RES),
  P('R26', '1 кОм', 'out_coil1', 'Нагрузка первого каскада (к +5 В)', RES),
  P('R27', '470 Ом', 'out_coil1', 'Нагрузка второго каскада: заряжает затвор IGBT от +5 В', RES),
  P('Q3', 'AO3400A', 'out_coil1', 'Первый каскад драйвера затвора', 'Q3…Q6', 'Цоколёвка SOT-23: 1 — затвор, 2 — исток, 3 — сток.'),
  P('Q4', 'AO3400A', 'out_coil1', 'Второй каскад драйвера затвора', 'Q3…Q6', 'Цоколёвка SOT-23: 1 — затвор, 2 — исток, 3 — сток.'),
  P('Q1', 'IRGS14C40L', 'out_coil1', 'IGBT: замыкает минус катушки 1 на массу', 'Q1, Q2', 'Цоколёвка D2PAK: 1 — затвор, 2 и фланец — коллектор, 3 — эмиттер.'),
  P('X10', 'Клеммник 2 конт.', 'out_coil1', 'Подключение катушки 1', TERM),
  P('T1', 'Катушка зажигания 1', 'x_coil1', 'Плюс — от +12 В через F2, минус — на ключ Q1'),
  P('R28', '330 Ом', 'out_coil2', 'Резистор в цепи затвора Q5', RES, 'Номинал в описании блока не указан: взят из исходной схемы (330 Ом).'),
  P('R29', '10 кОм', 'out_coil2', 'Подтяжка затвора Q5 к массе', RES),
  P('R30', '1 кОм', 'out_coil2', 'Нагрузка первого каскада (к +5 В)', RES),
  P('R31', '470 Ом', 'out_coil2', 'Нагрузка второго каскада: заряжает затвор IGBT от +5 В', RES),
  P('Q5', 'AO3400A', 'out_coil2', 'Первый каскад драйвера затвора', 'Q3…Q6', 'Цоколёвка SOT-23: 1 — затвор, 2 — исток, 3 — сток.'),
  P('Q6', 'AO3400A', 'out_coil2', 'Второй каскад драйвера затвора', 'Q3…Q6', 'Цоколёвка SOT-23: 1 — затвор, 2 — исток, 3 — сток.'),
  P('Q2', 'IRGS14C40L', 'out_coil2', 'IGBT: замыкает минус катушки 2 на массу', 'Q1, Q2', 'Цоколёвка D2PAK: 1 — затвор, 2 и фланец — коллектор, 3 — эмиттер.'),
  P('X11', 'Клеммник 2 конт.', 'out_coil2', 'Подключение катушки 2', TERM),
  P('T2', 'Катушка зажигания 2', 'x_coil2', 'Плюс — от +12 В через F2, минус — на ключ Q2'),
  // топливо, насос, нагреватель
  P('R32', '100 Ом', 'out_inj', 'Резистор в цепи затвора Q7', RES),
  P('R33', '100 кОм', 'out_inj', 'Подтяжка затвора Q7 к массе', RES),
  P('Q7', 'IRLZ44N', 'out_inj', 'Ключ форсунки', 'Q7, Q8', 'Цоколёвка TO-220: 1 — затвор, 2 и фланец — сток, 3 — исток.'),
  P('D3', '1N4007', 'out_inj', 'Гашение выброса при закрытии форсунки', 'D3…D5'),
  P('X12', 'Клеммник 2 конт.', 'out_inj', 'Подключение форсунки', TERM),
  P('Y1', 'Форсунка Bosch 0 280 158 117', 'x_inj', 'Высокоомная, около 12 Ом'),
  P('R34', '100 Ом', 'out_heater', 'Резистор в цепи затвора Q8', RES),
  P('R35', '100 кОм', 'out_heater', 'Подтяжка затвора Q8 к массе', RES),
  P('Q8', 'IRLZ44N', 'out_heater', 'Ключ нагревателя лямбда-зонда', 'Q7, Q8', 'Цоколёвка TO-220: 1 — затвор, 2 и фланец — сток, 3 — исток.'),
  P('D4', '1N4007', 'out_heater', 'Гашение выброса нагревателя', 'D3…D5'),
  P('X14', 'Клеммник 2 конт.', 'out_heater', 'Подключение нагревателя лямбда-зонда', TERM),
  P('R36', '1 кОм', 'out_pump', 'Резистор в цепи базы Q9', RES),
  P('R37', '10 кОм', 'out_pump', 'Резистор база–эмиттер: закрывает Q9 при сбросе', RES),
  P('Q9', 'BC547C', 'out_pump', 'Ключ обмотки реле насоса', 'Q9', 'Цоколёвка TO-92 (плоской стороной к себе, слева направо): коллектор, база, эмиттер.'),
  P('D5', '1N4007', 'out_pump', 'Гашение выброса обмотки реле', 'D3…D5'),
  P('X13', 'Клеммник 2 конт.', 'out_pump', 'Подключение обмотки реле K1', TERM),
  P('K1', 'Реле 12 В 30 А', 'x_pump', 'Реле бензонасоса в колодке XK1: обмотка 85–86, контакты 30–87', 'K1'),
  P('M1', 'Бензонасос', 'x_pump', 'Питается через контакты реле K1'),
  // холостой ход
  P('U3', 'L293DD', 'out_iac', 'Два моста для обмоток шагового РХХ', 'U3', 'Цоколёвка SO-20: 1 EN1, 2 IN1, 3 OUT1, 4–7 GND, 8 OUT2, 9 IN2, 10 VS, 11 EN2, 12 IN3, 13 OUT3, 14–17 GND, 18 OUT4, 19 IN4, 20 VSS.'),
  P('C9', '0,1 мкФ', 'out_iac', 'Развязка питания логики L293DD', CER),
  P('C17', '47 мкФ × 63 В', 'out_iac', 'Фильтр силового питания L293DD', 'C2, C16, C17'),
  P('R38', '10 кОм', 'out_iac', 'Подтяжка PC13 к +3,3 В (у L293DD нет выхода аварии)', RES),
  P('X15', 'JST XH 4 конт.', 'out_iac', 'Разъём регулятора холостого хода', JST),
  P('M2', 'Шаговый РХХ', 'x_iac', 'Биполярный шаговый двигатель, две обмотки не меньше 25 Ом'),
];

/** Позиции BOM, которых на принципиальной схеме нет намеренно, и почему. */
export const SCHEME_BOM_SKIP: Record<string, string> = {
  'D10': 'запасной вариант защиты входов, на плату не ставится',
  'XK1': 'колодка реле K1 — показана вместе с K1',
  'PCB': 'макетная плата',
  'Гнездо PBS': 'панель под A1 — показана вместе с A1',
};

/** Элемент схемы по обозначению; части многосекционных элементов («D6.1», «K1.1») ищутся по основе. */
export function schemePart(ref: string): SchemePart | undefined {
  const base = ref.replace(/\.\d+$/, '');
  return SCHEME_PARTS.find((p) => p.ref === base);
}

/** Строка BOM для элемента схемы. */
export function schemeBom(part: SchemePart | undefined): BomItem | undefined {
  if (!part?.bom) return undefined;
  return BOM.find((b) => b.ref === part.bom) ?? BOM.find((b) => b.title.startsWith(part.bom!));
}
