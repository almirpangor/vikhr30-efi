// Общие типы и константы, совпадающие с прошивкой v0.8 (firmware/src/main.c).

export const RPM_BINS = [600, 900, 1200, 1600, 2200, 3000, 3800, 4500, 5000, 5500, 6000, 7000, 8000] as const;
/** Нагрузка = TPS в десятых долях процента. */
export const LOAD_BINS = [0, 20, 50, 100, 200, 350, 550, 750, 1000] as const;
export const RPM_COUNT = 13;
export const LOAD_COUNT = 9;

export type MapTable = number[][]; // [LOAD_COUNT][RPM_COUNT]

export const DEFAULT_FUEL: MapTable = [
  [1880, 1590, 1470, 1260, 890, 770, 770, 770, 770, 770, 770, 770, 770],
  [1930, 1670, 1550, 1410, 1160, 1060, 1050, 1030, 1020, 1020, 1000, 990, 960],
  [2000, 1790, 1670, 1620, 1560, 1500, 1470, 1420, 1400, 1380, 1350, 1310, 1250],
  [2150, 2000, 1910, 1850, 1820, 1770, 1750, 1730, 1710, 1700, 1670, 1640, 1590],
  [2410, 2280, 2200, 2150, 2130, 2120, 2120, 2110, 2090, 2070, 2050, 2020, 1970],
  [2650, 2560, 2500, 2480, 2480, 2480, 2500, 2500, 2490, 2460, 2430, 2400, 2340],
  [2950, 2870, 2840, 2830, 2850, 2890, 2920, 2940, 2920, 2870, 2840, 2810, 2750],
  [3190, 3140, 3120, 3110, 3150, 3200, 3240, 3250, 3240, 3190, 3160, 3140, 3070],
  [3420, 3380, 3360, 3370, 3410, 3440, 3470, 3450, 3410, 3320, 3300, 3250, 3180],
];

/** УОЗ, десятые доли градуса до ВМТ. */
export const DEFAULT_IGN: MapTable = [
  [50, 100, 140, 180, 220, 260, 280, 280, 270, 250, 240, 220, 200],
  [50, 100, 140, 180, 224, 264, 284, 284, 274, 254, 240, 220, 200],
  [50, 100, 140, 180, 230, 270, 290, 290, 280, 260, 240, 220, 200],
  [50, 90, 130, 180, 230, 270, 290, 290, 280, 260, 240, 220, 200],
  [50, 90, 130, 170, 220, 260, 280, 280, 270, 250, 230, 210, 190],
  [50, 80, 120, 170, 210, 250, 270, 270, 260, 240, 220, 200, 180],
  [50, 80, 120, 160, 208, 248, 268, 268, 258, 238, 218, 188, 168],
  [50, 80, 120, 160, 200, 240, 260, 260, 250, 230, 210, 180, 160],
  [50, 80, 120, 160, 200, 240, 260, 260, 250, 230, 210, 180, 160],
];

/** Пределы ячеек, как их ограничивает прошивка в SET FUEL / SET IGN. */
export const FUEL_LIMITS = { min: 500, max: 10000 } as const;
export const IGN_LIMITS = { min: 0, max: 300 } as const;

/** Строка телеметрии «T,…» — 33 поля в порядке прошивки. */
export interface Telemetry {
  rpm: number;
  tps10: number;        // 0,1 %
  map10: number;        // 0,1 кПа
  cht10: number;        // 0,1 °C
  iat10: number;        // 0,1 °C
  batteryMv: number;
  o2Mv: number;
  lambdaMilli: number;  // 0 для узкополосного
  lambdaDir: number;    // -1 богато, 0 стехиометрия, 1 бедно, 2 нет данных
  pwUs: number;         // длительность впрыска
  advance10: number;    // УОЗ, 0,1°
  sync: number;
  flags: number;
  bt: number;
  service: number;      // 1 = изменения разрешены (SERVICE, RPM=0, нет синхронизации)
  peak: number;
  iacPos: number;
  iacTarget: number;
  heater: number;       // %
  duty10: number;       // загрузка форсунки, 0,1 %
  usb: number;
  actuatorTest: number; // 0 нет, 1 насос, 2 форсунка, 3/4 катушки, 5/6 РХХ, 7 нагреватель
  kill: number;
  uptimeMs: number;
  tpsRaw: number;
  baro10: number;
  preparedDwellUs: number;
  accelPermille: number;
  toothUs: number;
  toothIndex: number;
  fuelCut: number;
  clockPll: number;
  outputMask: number;   // бит0 кат.1, 1 кат.2, 2 форсунка, 3 насос, 4 нагреватель, 5 РХХ вкл.
}

export const TELEMETRY_KEYS: (keyof Telemetry)[] = [
  'rpm', 'tps10', 'map10', 'cht10', 'iat10', 'batteryMv', 'o2Mv', 'lambdaMilli', 'lambdaDir', 'pwUs', 'advance10', 'sync',
  'flags', 'bt', 'service', 'peak', 'iacPos', 'iacTarget', 'heater', 'duty10', 'usb', 'actuatorTest',
  'kill', 'uptimeMs', 'tpsRaw', 'baro10', 'preparedDwellUs', 'accelPermille', 'toothUs', 'toothIndex', 'fuelCut', 'clockPll', 'outputMask',
];
/** Первые 22 поля есть в любой версии прошивки; остальные добавлены в v0.8. */
export const TELEMETRY_MIN_FIELDS = 20;

export function emptyTelemetry(): Telemetry {
  return {
    rpm: 0, tps10: 0, map10: 1013, cht10: 200, iat10: 200, batteryMv: 12500, o2Mv: 450, lambdaMilli: 0, lambdaDir: 2,
    pwUs: 0, advance10: 0, sync: 0, flags: 0, bt: 0, service: 0, peak: 0, iacPos: 0, iacTarget: 0, heater: 0, duty10: 0,
    usb: 0, actuatorTest: 0, kill: 0, uptimeMs: 0, tpsRaw: 0, baro10: 1013, preparedDwellUs: 0, accelPermille: 1000,
    toothUs: 0, toothIndex: 255, fuelCut: 0, clockPll: 0, outputMask: 0,
  };
}

export interface FaultDef { bit: number; code: string; title: string; hint: string }
export const FAULTS: FaultDef[] = [
  { bit: 0, code: 'EVENT_OVERFLOW', title: 'Переполнение очереди событий', hint: 'Прошивка не успела запланировать искру или впрыск. Проверьте сигнал ДПКВ на помехи.' },
  { bit: 1, code: 'DWELL_SHORT', title: 'Не хватило времени накопления', hint: 'Катушка включена позже расчётного. Возможна слабая искра на высоких оборотах.' },
  { bit: 2, code: 'PW_CLAMP', title: 'Впрыск ограничен по длительности', hint: 'Запрошенный импульс больше 85 % периода. Форсунка на пределе производительности.' },
  { bit: 3, code: 'SENSOR', title: 'Обрыв или замыкание датчика', hint: 'TPS, MAP, CHT или IAT вышли за пределы АЦП. Проверьте проводку по вкладке «3D-схема».' },
  { bit: 4, code: 'OVERHEAT', title: 'Перегрев головки', hint: 'CHT выше 85 °C: прошивка уменьшает УОЗ и добавляет топливо.' },
  { bit: 5, code: 'REV_LIMIT', title: 'Сработала отсечка', hint: 'Обороты достигли мягкого или жёсткого предела.' },
  { bit: 6, code: 'SYNC_LOSS', title: 'Потеря синхронизации', hint: 'Пропал сигнал ДПКВ или нарушен счёт зубьев 36-1.' },
  { bit: 7, code: 'IAC_DRIVER', title: 'Ошибка драйвера РХХ', hint: 'Вход PC13 в нуле: драйвер сообщает об аварии или не подключён.' },
  { bit: 8, code: 'O2_INVALID', title: 'Нет сигнала лямбды', hint: 'Датчик не прогрет, отключён или двигатель остановлен. На стоянке это нормально.' },
  { bit: 9, code: 'FLASH', title: 'Ошибка записи Flash', hint: 'Калибровки не сохранились. Повторите запись.' },
];

export interface ParamDef {
  key: string;
  label: string;
  units: string;
  def: number;
  min: number;
  max: number;
  help: string;
  /** Не хранится во Flash (действует до перезапуска). */
  volatile?: boolean;
}
export const PARAMS: ParamDef[] = [
  { key: 'trigger_trim_tenths', label: 'Поправка ДПКВ', units: '0,1°', def: 0, min: -100, max: 100, help: 'Положительное значение делает искру раньше. Подбирается только по стробоскопу.' },
  { key: 'dwell_us', label: 'Время накопления катушки', units: 'мкс', def: 1600, min: 1000, max: 2600, help: 'Начать с 1000 мкс; увеличивать, контролируя ток катушки и нагрев ключа.' },
  { key: 'injector_deadtime_us', label: 'Мёртвое время форсунки при 14 В', units: 'мкс', def: 650, min: 450, max: 2200, help: 'Опорная задержка; поправка по напряжению уже есть в прошивке.' },
  { key: 'tps_min_raw', label: 'TPS закрыт', units: 'АЦП', def: 420, min: 0, max: 3500, help: 'Сырое значение АЦП при полностью закрытой заслонке.' },
  { key: 'tps_max_raw', label: 'TPS открыт', units: 'АЦП', def: 3720, min: 400, max: 4095, help: 'Сырое значение АЦП при полностью открытой заслонке.' },
  { key: 'fuel_scale_permille', label: 'Общий масштаб топлива', units: '‰', def: 1000, min: 700, max: 1300, help: '1000 — без изменения; 1050 добавляет 5 % топлива всей карте.' },
  { key: 'rev_limit_soft', label: 'Мягкая отсечка', units: 'об/мин', def: 6800, min: 5500, max: 8500, help: 'Пропуск искры и топлива через раз.' },
  { key: 'rev_limit_hard', label: 'Жёсткая отсечка', units: 'об/мин', def: 7000, min: 5700, max: 9000, help: 'Должна быть минимум на 100 об/мин выше мягкой.' },
  { key: 'iac_max_steps', label: 'Полный ход РХХ', units: 'шаг', def: 180, min: 60, max: 300, help: 'Подбирается без упора штока, затем «Калибровать РХХ».' },
  { key: 'iac_crank_steps', label: 'РХХ при запуске', units: 'шаг', def: 90, min: 0, max: 300, help: 'Больше шагов — больше пускового воздуха.' },
  { key: 'iac_hot_steps', label: 'РХХ на прогретом', units: 'шаг', def: 30, min: 0, max: 300, help: 'Базовый байпас воздуха на прогретом моторе.' },
  { key: 'iac_target_rpm', label: 'Целевой холостой ход', units: 'об/мин', def: 1100, min: 800, max: 1600, help: 'Прошивка подстраивает РХХ при закрытом дросселе.' },
  { key: 'iac_direction', label: 'Направление РХХ', units: '−1 / 1', def: 1, min: -1, max: 1, help: 'Если «открыть» физически закрывает клапан — сменить знак.' },
  { key: 'o2_heater_duty_pct', label: 'Нагреватель лямбды', units: '%', def: 70, min: 0, max: 70, help: 'Мягкий старт 20 % → заданное значение.' },
  { key: 'o2_mode', label: 'Тип лямбда-входа', units: '0 узкая / 1 широкая', def: 0, min: 0, max: 1, help: '0 — узкополосный датчик; 1 — внешний широкополосный контроллер 0–5 В.' },
  { key: 'wideband_lambda_min_milli', label: 'λ при 0 В (WB)', units: 'λ×1000', def: 700, min: 500, max: 1000, help: 'По документации широкополосного контроллера.' },
  { key: 'wideband_lambda_max_milli', label: 'λ при 5 В (WB)', units: 'λ×1000', def: 1300, min: 1000, max: 2000, help: 'По документации широкополосного контроллера.' },
  { key: 'fixed_ign_tenths', label: 'Фиксированный УОЗ', units: '0,1°', def: -1, min: -1, max: 300, help: '−1 — работать по карте; 100 — фиксированные 10,0° для проверки стробоскопом.', volatile: true },
];

export interface ActuatorTestDef { cmd: string; id: number; title: string; note: string; confirm?: string }
export const ACTUATOR_TESTS: ActuatorTestDef[] = [
  { cmd: 'PUMP', id: 1, title: 'Бензонасос', note: 'Реле насоса на 2 с' },
  { cmd: 'INJECTOR', id: 2, title: 'Форсунка', note: 'Один импульс 3 мс', confirm: 'Форсунка откроется на 3 мс. В рампе не должно быть давления топлива, либо под форсункой — ёмкость. Продолжить?' },
  { cmd: 'COIL1', id: 3, title: 'Катушка 1', note: 'Один импульс 1 мс', confirm: 'Катушка 1 даст искру. Свеча должна быть установлена или надёжно заземлена на разряднике, рядом не должно быть паров топлива. Продолжить?' },
  { cmd: 'COIL2', id: 4, title: 'Катушка 2', note: 'Один импульс 1 мс', confirm: 'Катушка 2 даст искру. Свеча должна быть установлена или надёжно заземлена на разряднике, рядом не должно быть паров топлива. Продолжить?' },
  { cmd: 'IAC_OPEN', id: 5, title: 'РХХ открыть', note: '20 шагов на открытие' },
  { cmd: 'IAC_CLOSE', id: 6, title: 'РХХ закрыть', note: '20 шагов на закрытие' },
  { cmd: 'O2_HEATER', id: 7, title: 'Нагреватель лямбды', note: 'ШИМ 20 %, 2 с' },
];

export type LinkStatus = 'disconnected' | 'opening' | 'waiting' | 'online' | 'lost';

/** Bosch 0 280 158 117: 540 см³/мин при 3 бар. */
export const INJECTOR_CC_MIN = 540;
