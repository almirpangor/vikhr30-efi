// Листы принципиальной схемы блока управления. Координаты — на сетке 10; номиналы берутся из SCHEME_PARTS.
import type { BlockId } from '../../core/hardware';
import { SheetBuilder, type Pt, type Sheet } from './model';

const VERIFY = '* — цоколёвку или номинал сверить с даташитом (подробности — в карточке элемента и в перечне элементов).';

// ───────────────────────────── Обзор ─────────────────────────────
function overview(): Sheet {
  const s = new SheetBuilder('overview', 'Обзор', 1220, 590);
  const XL = 20, XI = 280, XM = 540, XO = 790, XR = 1040, H = 36;
  const ext = (id: BlockId, x: number, y: number, title: string, sheet: string, h = H) => s.block(id, x, y, 160, h, title, sheet, { ext: true });
  const brd = (id: BlockId, x: number, y: number, title: string, sheet: string, h = H, sub?: string) => s.block(id, x, y, 150, h, title, sheet, { sub });
  const link = (net: string, a: Pt, b: Pt) => { s.wire(net, a, b); s.tag(net, (a[0] + b[0]) / 2, a[1], 't', { plain: true }); };

  // питание
  const batt = ext('x_batt', XL, 44, 'Аккумулятор 12 В', 'power', 48);
  const pwr = brd('pwr', XI, 40, 'Питание', 'power', 60, 'F1, D1, LM2596, L1');
  link('BAT', batt.r(12), [XI, 56]);
  link('GND', batt.r(36), [XI, 80]);
  (['V12', 'V5', 'V5S'] as const).forEach((n, i) => { s.wire(n, pwr.r(10 + 20 * i), [470, 50 + 20 * i]); s.tag(n, 470, 50 + 20 * i, 'r'); });

  const mcu = s.block('mcu', XM, 140, 140, 420, 'Blue Pill', 'mcu', { sub: 'STM32F103C6T6' });
  s.wire('V33', mcu.t(100), [640, 112]);
  s.tag('V33', 640, 112, 't', { plain: true });

  // входы
  const rows: [BlockId | null, string, BlockId, string, string | null, string][] = [
    ['x_tps', 'Датчик дросселя', 'in_tps', 'Вход TPS', 'TPS_SIG', 'PA0'],
    ['x_map', 'Датчик давления', 'in_map', 'Вход MAP', 'MAP_SIG', 'PA1'],
    ['x_cht', 'Термистор головки', 'in_cht', 'Вход CHT', 'PA4', 'PA4'],
    ['x_iat', 'Термистор воздуха', 'in_iat', 'Вход IAT', 'PA5', 'PA5'],
    [null, '', 'in_vbat', 'Бортсеть ÷5,7', 'V12', 'PA6'],
    ['x_o2', 'Лямбда-зонд', 'in_o2', 'Вход лямбды', 'PA7', 'PA7'],
    ['x_hall', 'Датчик коленвала', 'in_crank', 'Вход ДПКВ', 'PB5', 'PB5'],
  ];
  rows.forEach(([xe, xt, bi, bt, nIn, nOut], i) => {
    const y = 140 + 48 * i, b = brd(bi, XI, y, bt, 'sensors');
    if (xe) link(nIn!, ext(xe, XL, y, xt, 'sensors').r(), b.l());
    else { s.wire(nIn!, [230, y + 18], b.l()); s.tag(nIn!, 230, y + 18, 'l'); }
    link(nOut, b.r(), [XM, y + 18]);
  });
  const sw = brd('in_sw', XI, 476, 'SERVICE, STOP', 'sensors', 84);
  link('PB13', ext('x_service', XL, 476, 'Перемычка SERVICE', 'sensors').r(), sw.l(18));
  link('PB12', ext('x_kill', XL, 524, 'Чека STOP', 'sensors').r(), sw.l(66));
  link('PB13', sw.r(18), [XM, 494]);
  link('PB12', sw.r(66), [XM, 542]);

  // выходы
  const outs: [BlockId, string, string, BlockId, string, string, string][] = [
    ['out_coil1', 'Ключ катушки 1', 'PB0', 'x_coil1', 'Катушка 1', 'COIL1', 'ign'],
    ['out_coil2', 'Ключ катушки 2', 'PB1', 'x_coil2', 'Катушка 2', 'COIL2', 'ign'],
    ['out_inj', 'Ключ форсунки', 'PB10', 'x_inj', 'Форсунка', 'INJ', 'fuel'],
    ['out_pump', 'Ключ реле насоса', 'PB11', 'x_pump', 'Реле K1 и насос', 'RELAY', 'fuel'],
    ['out_heater', 'Ключ нагревателя', 'PB15', 'x_o2', 'Лямбда: нагреватель', 'HEAT', 'fuel'],
  ];
  outs.forEach(([bo, bt, nIn, xe, xt, nOut, sheet], i) => {
    const y = 140 + 48 * i, b = s.block(bo, XO, y, 150, H, bt, sheet);
    link(nIn, [XM + 140, y + 18], b.l());
    link(nOut, b.r(), ext(xe, XR, y, xt, sheet).l());
  });
  const iac = brd('out_iac', XO, 380, 'Драйвер РХХ', 'iac', 84, 'L293DD');
  link('IAC_IN', [XM + 140, 394], iac.l(14));
  link('PA8', [XM + 140, 422], iac.l(42));
  link('PC13', [XM + 140, 450], iac.l(70));
  link('IAC_OUT', iac.r(42), ext('x_iac', XR, 404, 'Регулятор ХХ', 'iac').l());

  // связь
  const bt = brd('bt', XO, 490, 'Bluetooth HC-06', 'mcu', 70);
  link('PA9', [XM + 140, 504], bt.l(14));
  link('PA10', [XM + 140, 525], bt.l(35));
  link('PB14', [XM + 140, 546], bt.l(56));
  const pc = ext('x_pc', XR, 507, 'Компьютер', 'mcu');
  s.dashed(null, bt.r(35), pc.l());

  s.text(20, 584, 'Пунктирная рамка — устройство вне платы. Щелчок по блоку открывает его лист; щелчок по линии — измерение цепи.', { cls: 's2-small' });
  s.note('Структурная схема. Шины питания (+12V_PROT, +5V_ECU, +5V_SENS, +3V3) и масса расходятся ко всем блокам — здесь показаны только их источники; подключение каждого узла см. на его листе.');
  return s.done();
}

// ───────────────────────────── Питание ─────────────────────────────
function power(): Sheet {
  const s = new SheetBuilder('power', 'Питание', 1200, 350);
  const Y = 150;
  const gb = s.two('BAT', 'GB1', 80, 190, 1, { lp: 'l' });
  const x1 = s.conn('X1', 130, Y - 10, 60, ['+12 В', 'GND']);
  s.wire('BAT', gb.a, [80, Y], x1.l[0]);
  s.wire('GND', gb.b, [80, 240], [110, 240], [110, Y + 20], x1.l[1]);
  const f1 = s.two('F', 'F1', 310, Y), d1 = s.two('DS', 'D1', 400, Y);
  s.wire('BAT', x1.r[0], f1.a);
  s.tag('BAT', 235, Y, 't', { plain: true });
  s.wire('GND', x1.r[1], [210, Y + 20], [210, 200]);
  s.gnd(210, 200);
  s.wire(null, f1.b, d1.a);
  const a5 = s.ic('A5', 740, Y - 20, 100, ['IN+', 'IN−'], ['OUT+', 'OUT−']);
  s.wire('V12', d1.b, a5.l[0]);
  const d2 = s.two('DZ', 'D2', 490, 200, 3), c1 = s.two('CP', 'C1', 590, 200, 1);
  s.wire('V12', [490, Y], d2.b); s.gnd(490, 230);
  s.wire('V12', [590, Y], c1.a); s.gnd(590, 230);
  s.pwr('V12', 680, Y, { v: true });
  s.wire('GND', a5.l[1], [700, Y + 20], [700, 230]); s.gnd(700, 230);
  s.wire('GND', a5.r[1], [880, Y + 20], [880, 230]); s.gnd(880, 230);
  const l1 = s.two('L', 'L1', 1000, Y);
  s.wire('V5', a5.r[0], l1.a);
  s.pwr('V5', 920, Y, { v: true });
  s.wire('V5S', l1.b, [1140, Y]);
  s.pwr('V5S', 1140, Y, { v: true });
  const c2 = s.two('CP', 'C2', 1080, 200, 1);
  s.wire('V5S', [1080, Y], c2.a); s.gnd(1080, 230);
  // силовая ветка
  const f2 = s.two('F', 'F2', 310, 300);
  s.wire('BAT', [240, Y], [240, 300], f2.a);
  s.wire('F2', f2.b, [420, 300]);
  s.tag('F2', 420, 300, 'r', { desc: '→ клеммы X10…X14: катушки, форсунка, обмотка реле насоса, нагреватель лямбда-зонда' });
  s.note('+3V3 формирует стабилизатор на плате A1 из +5V_ECU (лист «Контроллер и связь»). Все знаки массы соединены между собой и с клеммой GND разъёма X1.');
  s.note('До установки A1 в панель выставить подстроечником модуля A5 ровно 5,00 В на выходе при 12 В на входе.');
  s.note('Место D2 и C2 в исходных данных не задано однозначно: D2 показан на +12V_PROT после D1, C2 — после дросселя L1. Силовые нагрузки питаются от аккумулятора через F2, минуя D1.');
  s.note(VERIFY);
  return s.done();
}

// ───────────────────────────── Контроллер и связь ─────────────────────────────
function mcu(): Sheet {
  const s = new SheetBuilder('mcu', 'Контроллер и связь', 1380, 600);
  type Row = [name: string, net: string | null, desc: string];
  const JL: Row[] = [
    ['VBAT', null, 'свободен'], ['PC13', 'PC13', 'подтяжка R38 → «Холостой ход»'], ['PC14', null, 'свободен (кварц 32 кГц на плате)'], ['PC15', null, 'свободен (кварц 32 кГц на плате)'],
    ['PA0', 'PA0', 'TPS → «Датчики»'], ['PA1', 'PA1', 'MAP → «Датчики»'], ['PA2', null, 'свободен (запасной порт связи, TX)'], ['PA3', null, 'свободен (запасной порт связи, RX)'],
    ['PA4', 'PA4', 'CHT → «Датчики»'], ['PA5', 'PA5', 'IAT → «Датчики»'], ['PA6', 'PA6', 'бортсеть → «Датчики»'], ['PA7', 'PA7', 'лямбда → «Датчики»'],
    ['PB0', 'PB0', 'катушка 1 → «Зажигание»'], ['PB1', 'PB1', 'катушка 2 → «Зажигание»'], ['PB10', 'PB10', 'форсунка → «Топливо и насос»'], ['PB11', 'PB11', 'реле насоса → «Топливо и насос»'],
    ['NRST', null, 'свободен (кнопка сброса на плате)'], ['3V3', 'V33', 'выход стабилизатора платы'], ['GND', 'GND', 'масса'], ['GND', 'GND', 'масса'],
  ];
  const JR: Row[] = [
    ['3V3', 'V33', '→ подтяжки входов, термисторы'], ['GND', 'GND', 'масса'], ['5V', 'V5', 'питание платы от A5'],
    ['PB9', 'IAC_IN', 'IN4 драйвера → «Холостой ход»'], ['PB8', 'IAC_IN', 'IN3 драйвера → «Холостой ход»'], ['PB7', 'IAC_IN', 'IN2 драйвера → «Холостой ход»'], ['PB6', 'IAC_IN', 'IN1 драйвера → «Холостой ход»'],
    ['PB5', 'PB5', 'датчик коленвала → «Датчики»'], ['PB4', null, 'свободен'], ['PB3', null, 'свободен'], ['PA15', null, 'свободен'],
    ['PA12', null, 'свободен (USB D+ на плате)'], ['PA11', null, 'свободен (USB D− на плате)'],
    ['PA10', 'PA10', 'приём ← TXD модуля A2'], ['PA9', 'PA9', 'передача → RXD модуля A2'], ['PA8', 'PA8', 'разрешение драйвера → «Холостой ход»'],
    ['PB15', 'PB15', 'нагреватель → «Топливо и насос»'], ['PB14', 'PB14', 'STATE модуля A2'], ['PB13', 'PB13', 'SERVICE → «Датчики»'], ['PB12', 'PB12', 'STOP → «Датчики»'],
  ];
  const SWD: Row[] = [['3V3', null, 'к A4 не подключать'], ['SWDIO', 'SWDIO', '→ A4'], ['SWCLK', 'SWCLK', '→ A4'], ['GND', 'GND', 'масса, общая с A4']];
  const X = 330, W = 170;
  const a1 = s.ic('A1', X, 50, W,
    [...JL.map((r, i) => ({ num: String(i + 1), name: r[0] })), null, ...SWD.map((r, i) => ({ num: 'S' + (i + 1), name: r[0] }))],
    JR.map((r, i) => ({ num: String(i + 1), name: r[0] })));
  s.text(X + W / 2, 214, '◄ JL        JR ►', { anchor: 'middle', cls: 's2-small' });
  s.text(X + W / 2, 234, 'micro-USB сверху', { anchor: 'middle', cls: 's2-small' });
  s.text(X + W / 2, 484, 'разъём SWD', { anchor: 'middle', cls: 's2-small' });
  const row = (p: Pt, side: 'l' | 'r', [name, net, desc]: Row) => {
    const d = side === 'l' ? -1 : 1;
    if (!net) { s.nc(p[0], p[1], desc, side); return; }
    const q: Pt = [p[0] + 30 * d, p[1]];
    s.wire(net, p, q);
    s.tag(net, q[0], q[1], side, { desc, text: net === 'IAC_IN' ? name : undefined });
  };
  JL.forEach((r, i) => row(a1.l[i], 'l', r));
  SWD.forEach((r, i) => row(a1.l[21 + i], 'l', r));
  JR.forEach((r, i) => row(a1.r[i], 'r', r));

  // Bluetooth
  const OX = 900;
  s.frame(OX - 25, 40, 495, 170, 'Bluetooth');
  const a2 = s.ic('A2', OX + 200, 80, 100, ['RXD', 'STATE', 'TXD'], ['VCC', null, 'GND']);
  const r22 = s.two('R', 'R22', OX + 130, 100, 0, { lp: 't1' }), r23 = s.two('R', 'R23', OX + 130, 140, 0, { lp: 'b1' });
  s.wire('PA9', s.tag('PA9', OX + 80, 100, 'l'), r22.a); s.wire('PA9', r22.b, a2.l[0]);
  s.wire('PB14', s.tag('PB14', OX + 80, 120, 'l'), a2.l[1]);
  s.wire('PA10', s.tag('PA10', OX + 80, 140, 'l'), r23.a); s.wire('PA10', r23.b, a2.l[2]);
  const c16 = s.two('CP', 'C16', OX + 400, 140, 1, { val: '47 мкФ' });
  s.wire('V5', a2.r[0], [OX + 400, 100], c16.a);
  s.pwr('V5', OX + 360, 100);
  s.gnd(OX + 400, 170);
  s.wire('GND', a2.r[2], [OX + 340, 140], [OX + 340, 170]); s.gnd(OX + 340, 170);

  // USB-UART
  s.frame(OX - 25, 230, 495, 150, 'Проводная связь (вместо A2)');
  const a3 = s.ic('A3', OX + 200, 270, 100, ['RXD', 'TXD', 'GND'], ['+5V', '3V3']);
  s.wire('PA9', s.tag('PA9', OX + 130, 290, 'l', { v: false }), a3.l[0]);
  s.wire('PA10', s.tag('PA10', OX + 130, 310, 'l', { v: false }), a3.l[1]);
  s.wire('GND', a3.l[2], [OX + 150, 330], [OX + 150, 350]); s.gnd(OX + 150, 350);
  s.nc(a3.r[0][0], a3.r[0][1], 'не подключать');
  s.nc(a3.r[1][0], a3.r[1][1], 'не подключать');
  s.text(OX + 200, 372, 'USB → компьютер', { cls: 's2-small' });

  // ST-Link
  s.frame(OX - 25, 400, 495, 170, 'Запись прошивки');
  const a4 = s.ic('A4', OX + 200, 440, 100, ['SWDIO', 'SWCLK', '3.3V', 'GND'], []);
  s.wire('SWDIO', s.tag('SWDIO', OX + 130, 460, 'l', { v: false }), a4.l[0]);
  s.wire('SWCLK', s.tag('SWCLK', OX + 130, 480, 'l', { v: false }), a4.l[1]);
  s.nc(a4.l[2][0], a4.l[2][1], 'не подключать', 'l');
  s.wire('GND', a4.l[3], [OX + 150, 520], [OX + 150, 540]); s.gnd(OX + 150, 540);
  s.text(OX + 320, 484, 'только на время', { cls: 's2-small' });
  s.text(OX + 320, 497, 'записи прошивки', { cls: 's2-small' });

  s.note('A1 стоит в панели из двух гнёзд PBS-1x20; номера контактов гребёнок считаются от micro-USB. A2 подключается к плате разъёмом JST XH. Перемычки BOOT0 и BOOT1 на A1 — в положении «0».');
  s.note('A2 перед установкой перенастроить на 115200 бод (AT+BAUD8). A3 (перемычка уровня — 3,3 В) подключают ВМЕСТО A2 к тем же контактам; два передатчика на PA10 одновременно недопустимы.');
  s.note('PA2 и PA3: в прошивке v0.8 включён запасной порт связи (USART2, 115200) — на этой плате не используется. Питание 3,3 В от A4 не подключать, когда плата питается от бортсети.');
  s.note(VERIFY);
  return s.done();
}

// ───────────────────────────── Датчики ─────────────────────────────
function sensors(): Sheet {
  const s = new SheetBuilder('sensors', 'Датчики', 1460, 710);
  const FW = 465, FH = 210;
  const prot = (ox: number, y: number, x: number, ref: string) => {
    const lo = s.two('DS', ref + '.1', ox + x, y + 40, 3), hi = s.two('DS', ref + '.2', ox + x, y - 40, 3, { val: '' });
    s.gnd(lo.a[0], lo.a[1]);
    s.pwr('V33', hi.b[0], hi.b[1]);
    return [lo.b, [ox + x, y] as Pt, hi.a] as Pt[];
  };
  const capG = (ox: number, y: number, x: number, ref: string, net: string, lp: 'l' | 'r' = 'r') => {
    const c = s.two('C', ref, ox + x, y + 40, 1, { lp });
    s.wire(net, [ox + x, y], c.a);
    s.gnd(c.b[0], c.b[1]);
  };
  const connPwr = (ox: number, y: number, r: Pt[]) => {
    s.wire('V5S', r[0], [ox + 145, y - 20], [ox + 145, y - 60]); s.pwr('V5S', ox + 145, y - 60);
    s.wire('GND', r[2], [ox + 145, y + 20], [ox + 145, y + 40]); s.gnd(ox + 145, y + 40);
  };

  /** TPS и MAP: делитель 10к/20к, резистор 1к, конденсатор, диоды. */
  const divider = (ox: number, oy: number, title: string, sensor: 'pot' | 'map', xr: string, r: string[], c: string, d: string, sig: string, pin: string) => {
    const y = oy + 120;
    s.frame(ox, oy, FW, FH, title);
    const x = s.conn(xr, ox + 80, y - 30, 50, ['+5 В', 'Сигн.', 'GND']);
    if (sensor === 'pot') {
      const p = s.pot('RP1', ox + 30, y, '');
      s.wire('V5S', p.a, x.l[0]); s.wire(sig, p.w, x.l[1]); s.wire('GND', p.b, x.l[2]);
      s.text(ox + 8, y + 52, 'датчик дросселя', { cls: 's2-small' });
    } else {
      s.ic('B2', ox + 12, y - 40, 48, [], ['3|Vs', '1|Вых.', '2|GND'], '');
      s.text(ox + 8, y + 58, 'MPX4115AP', { cls: 's2-small' });
    }
    connPwr(ox, y, x.r);
    const r1 = s.two('R', r[0], ox + 190, y), r3 = s.two('R', r[2], ox + 270, y), r2 = s.two('R', r[1], ox + 230, y + 40, 1, { lp: 'l' });
    s.wire(sig, x.r[1], r1.a);
    s.wire(null, r1.b, r3.a);
    s.wire(null, [ox + 230, y], r2.a);
    s.gnd(r2.b[0], r2.b[1]);
    capG(ox, y, 320, c, pin, 'l');
    const [p1, p2, p3] = prot(ox, y, 360, d);
    s.wire(pin, p1, p2); s.wire(pin, p2, p3);
    s.wire(pin, r3.b, s.tag(pin, ox + 385, y, 'r'));
  };

  /** CHT и IAT: термистор с подтяжкой 2,4к + 91 Ом к +3,3 В. */
  const therm = (ox: number, oy: number, title: string, rt: string, xr: string, r: string[], c: string, pin: string) => {
    const y = oy + 120;
    s.frame(ox, oy, FW, FH, title);
    const x = s.conn(xr, ox + 80, y - 10, 50, ['Сигн.', 'GND']);
    const t = s.two('RT', rt, ox + 40, y + 10, 1, { lp: 'l', val: '' });
    s.wire(pin, t.a, [ox + 60, y - 20], [ox + 60, y], x.l[0]);
    s.wire('GND', t.b, [ox + 60, y + 40], [ox + 60, y + 20], x.l[1]);
    s.text(ox + 8, y + 62, 'NTC 10 кОм, B3950', { cls: 's2-small' });
    const r7 = s.two('R', r[0], ox + 180, y - 50), r8 = s.two('R', r[1], ox + 250, y - 50), r9 = s.two('R', r[2], ox + 320, y);
    s.pwr('V33', r7.a[0], r7.a[1]);
    s.wire(null, r7.b, r8.a);
    s.wire(pin, r8.b, [ox + 280, y]);
    s.wire(pin, x.r[0], r9.a);
    s.wire('GND', x.r[1], [ox + 145, y + 20], [ox + 145, y + 40]); s.gnd(ox + 145, y + 40);
    capG(ox, y, 365, c, pin);
    s.wire(pin, r9.b, s.tag(pin, ox + 385, y, 'r'));
  };

  /** SERVICE и STOP: подтяжка 10к, резистор 1к, конденсатор 1 нФ. */
  const sw = (ox: number, oy: number, title: string, sref: string, what: string, xr: string, r: string[], c: string, pin: string) => {
    const y = oy + 120;
    s.frame(ox, oy, FW, FH, title);
    const x = s.conn(xr, ox + 80, y - 10, 50, ['Вход', 'GND']);
    const k = s.two('SW', sref, ox + 40, y + 10, 1, { lp: 'l', val: '' });
    s.wire(pin, k.a, [ox + 60, y - 20], [ox + 60, y], x.l[0]);
    s.wire('GND', k.b, [ox + 60, y + 40], [ox + 60, y + 20], x.l[1]);
    s.text(ox + 8, y + 62, what, { cls: 's2-small' });
    const ru = s.two('R', r[0], ox + 180, y - 40, 1), rs = s.two('R', r[1], ox + 250, y);
    s.pwr('V33', ru.a[0], ru.a[1]);
    s.wire(pin, ru.b, [ox + 180, y]);
    s.wire(pin, x.r[0], rs.a);
    s.wire('GND', x.r[1], [ox + 145, y + 20], [ox + 145, y + 40]); s.gnd(ox + 145, y + 40);
    capG(ox, y, 310, c, pin);
    s.wire(pin, rs.b, s.tag(pin, ox + 340, y, 'r'));
  };

  const C = [20, 495, 970], R = [40, 260, 480];
  divider(C[0], R[0], 'Дроссель (TPS) → PA0', 'pot', 'X2', ['R1', 'R2', 'R3'], 'C3', 'D6', 'TPS_SIG', 'PA0');
  divider(C[1], R[0], 'Давление (MAP) → PA1', 'map', 'X3', ['R4', 'R5', 'R6'], 'C4', 'D7', 'MAP_SIG', 'PA1');
  { // бортсеть
    const ox = C[2], oy = R[0], y = oy + 120;
    s.frame(ox, oy, FW, FH, 'Бортсеть ÷5,7 → PA6');
    const r13 = s.two('R', 'R13', ox + 120, y), r14 = s.two('R', 'R14', ox + 180, y + 40, 1);
    s.wire('V12', s.pwr('V12', ox + 60, y), r13.a);
    s.wire('PA6', [ox + 180, y], r14.a); s.gnd(r14.b[0], r14.b[1]);
    capG(ox, y, 260, 'C7', 'PA6');
    const [p1, p2, p3] = prot(ox, y, 340, 'D8');
    s.wire('PA6', p1, p2); s.wire('PA6', p2, p3);
    s.wire('PA6', r13.b, s.tag('PA6', ox + 385, y, 'r'));
  }
  therm(C[0], R[1], 'Температура головки (CHT) → PA4', 'RT1', 'X4', ['R7', 'R8', 'R9'], 'C5', 'PA4');
  therm(C[1], R[1], 'Температура воздуха (IAT) → PA5', 'RT2', 'X5', ['R10', 'R11', 'R12'], 'C6', 'PA5');
  { // лямбда
    const ox = C[2], oy = R[1], y = oy + 120;
    s.frame(ox, oy, FW, FH, 'Лямбда-зонд, сигнал → PA7');
    s.ic('B3.1', ox + 12, y - 20, 48, [], ['Сигн.', 'Масса'], '');
    s.text(ox + 8, y + 62, 'чувствительный элемент', { cls: 's2-small' });
    const x = s.conn('X6', ox + 80, y - 10, 50, ['Сигн.', 'GND']);
    const r15 = s.two('R', 'R15', ox + 190, y);
    s.wire('PA7', x.r[0], r15.a);
    s.wire('GND', x.r[1], [ox + 145, y + 20], [ox + 145, y + 40]); s.gnd(ox + 145, y + 40);
    capG(ox, y, 260, 'C8', 'PA7');
    const [p1, p2, p3] = prot(ox, y, 340, 'D9');
    s.wire('PA7', p1, p2); s.wire('PA7', p2, p3);
    s.wire('PA7', r15.b, s.tag('PA7', ox + 385, y, 'r'));
  }
  { // коленвал
    const ox = C[0], oy = R[2], y = oy + 120;
    s.frame(ox, oy, FW, FH, 'Датчик коленвала (ДПКВ) → PB5');
    s.ic('B1', ox + 12, y - 40, 48, [], ['1|+', '3|Вых.', '2|GND'], '');
    s.text(ox + 8, y + 58, 'SS441A', { cls: 's2-small' });
    const x = s.conn('X7', ox + 80, y - 30, 50, ['+5 В', 'Вых.', 'GND']);
    connPwr(ox, y, x.r);
    const r16 = s.two('R', 'R16', ox + 200, y - 40, 1), r17 = s.two('R', 'R17', ox + 270, y);
    s.pwr('V33', r16.a[0], r16.a[1]);
    s.wire('PB5', r16.b, [ox + 200, y]);
    s.wire('PB5', x.r[1], r17.a);
    capG(ox, y, 320, 'C13', 'PB5', 'l');
    const [p1, p2, p3] = prot(ox, y, 360, 'D11');
    s.wire('PB5', p1, p2); s.wire('PB5', p2, p3);
    s.wire('PB5', r17.b, s.tag('PB5', ox + 385, y, 'r'));
  }
  sw(C[1], R[2], 'Перемычка SERVICE → PB13', 'S1', 'перемычка SERVICE', 'X8', ['R18', 'R19'], 'C14', 'PB13');
  sw(C[2], R[2], 'Аварийная чека STOP → PB12', 'S2', 'чека STOP (замыкает на массу)', 'X9', ['R20', 'R21'], 'C15', 'PB12');

  s.note('Сборки BAR43S (D6…D9, D11): два диода Шоттки последовательно; средняя точка (вывод 3) — к сигналу, вывод 1 — к массе, вывод 2 — к +3V3. Цоколёвку MPX4115AP и SS441A см. в карточке элемента.');
  s.note('Сигнальную массу лямбда-зонда не объединять с массой его нагревателя. Стабилитроны D10 (1N4728A) — запасной вариант защиты входов, на плату не ставятся.');
  s.note(VERIFY);
  return s.done();
}

// ───────────────────────────── Зажигание ─────────────────────────────
function ignition(): Sheet {
  const s = new SheetBuilder('ign', 'Зажигание', 1250, 700);
  const chan = (oy: number, n: number, pb: string, g: string, coil: string, r: string[], q: string[], xr: string, t: string) => {
    const Y = oy + 220;
    s.frame(20, oy, 890, 310, `Канал ${n}: ${pb} → ${q[0]} → ${q[1]} → ${q[2]} → катушка ${t}`);
    const rs = s.two('R', r[0], 150, Y), rg = s.two('R', r[1], 210, Y + 40, 1);
    const q3 = s.tr('NMOS', q[0], 270, Y, { pn: ['1', '3', '2'] }), q4 = s.tr('NMOS', q[1], 400, Y - 50, { pn: ['1', '3', '2'] }), q1 = s.tr('IGBT', q[2], 560, Y - 90, { pn: ['1', '2', '3'] });
    s.wire(pb, s.tag(pb, 110, Y, 'l'), rs.a);
    s.wire(null, rs.b, q3.g);
    s.wire(null, [210, Y], rg.a); s.gnd(rg.b[0], rg.b[1]);
    s.wire('GND', q3.s, [280, Y + 70]); s.gnd(280, Y + 70);
    const r26 = s.two('R', r[2], 280, Y - 90, 1), r27 = s.two('R', r[3], 410, Y - 140, 1);
    s.pwr('V5', r26.a[0], r26.a[1]); s.pwr('V5', r27.a[0], r27.a[1]);
    s.wire(null, r26.b, q3.d);
    s.wire(null, [280, Y - 50], q4.g);
    s.wire('GND', q4.s, [410, Y + 70]); s.gnd(410, Y + 70);
    s.wire(g, r27.b, q4.d);
    s.wire(g, [410, Y - 90], q1.g);
    s.tag(g, 424, Y - 90, 't', { plain: true, anchor: 'start' });
    s.wire('GND', q1.s, [570, Y + 70]); s.gnd(570, Y + 70);
    const x = s.conn(xr, 690, Y - 170, 50, ['+12 В', 'К−']);
    s.wire(coil, q1.d, [570, Y - 140], x.l[1]);
    s.tag(coil, 580, Y - 140, 'b', { plain: true, anchor: 'start' });
    s.wire('F2', s.pwr('F2', 650, Y - 160), x.l[0]);
    s.load('IGN', t, 740, Y - 150, { note: 'ВН → к свече', val: `катушка ${n}` });
  };
  chan(40, 1, 'PB0', 'G1', 'COIL1', ['R24', 'R25', 'R26', 'R27'], ['Q3', 'Q4', 'Q1'], 'X10', 'T1');
  chan(370, 2, 'PB1', 'G2', 'COIL2', ['R28', 'R29', 'R30', 'R31'], ['Q5', 'Q6', 'Q2'], 'X11', 'T2');
  const tx = 925;
  [
    ['Как работает канал', 's2-h'],
    ['PB0 = 1 (3,3 В): Q3 открыт → на затворе Q4', ''], ['около 0 В → Q4 закрыт → затвор Q1 через R27', ''], ['заряжается до +5 В → Q1 открыт, катушка', ''], ['накапливает энергию.', ''],
    ['', ''],
    ['PB0 = 0 или сброс контроллера: R25 держит', ''], ['Q3 закрытым → R26 открывает Q4 → затвор Q1', ''], ['на массе → Q1 закрыт. В момент закрытия', ''], ['ток катушки обрывается — это и есть искра.', ''],
    ['', ''],
    ['Логика не инвертируется: импульс на PB0 и', ''], ['на затворе Q1 (IGN1_GATE) одной полярности,', ''], ['3,3 В превращаются в 5 В.', ''],
    ['', ''],
    ['Опасно: на COIL1−, COIL2− до 400 В.', 's2-h'], ['Измерять только осциллографом со щупом', ''], ['1:10 на 600 В.', ''],
    ['', ''],
    ['Q1, Q2 — на теплоотвод. Катушки питаются', ''], ['от аккумулятора через F2 10 А (+12V_F2).', ''],
  ].forEach(([t, c], i) => { if (t) s.text(tx, 60 + i * 16, t, { cls: c || 's2-note' }); });
  s.note('Номера у выводов транзисторов — цоколёвка корпусов: AO3400A (SOT-23): 1 — затвор, 2 — исток, 3 — сток; IRGS14C40L (D2PAK): 1 — затвор, 2 и фланец — коллектор, 3 — эмиттер.');
  s.note('R24, R28: номинал в описании блока не указан — взят 330 Ом из исходной схемы. Вторичная обмотка катушки показана условно: тип и цоколёвка катушек не подтверждены.');
  s.note(VERIFY);
  return s.done();
}

// ───────────────────────────── Топливо и насос ─────────────────────────────
function fuel(): Sheet {
  const s = new SheetBuilder('fuel', 'Топливо и насос', 1360, 570);
  const low = (ox: number, oy: number, w: number, title: string, pb: string, out: string, kind: 'NMOS' | 'NPN', q: string, r: string[], d: string, xr: string, row: string) => {
    const Y = oy + 160;
    s.frame(ox, oy, w, 250, title);
    const rs = s.two('R', r[0], ox + 140, Y), rg = s.two('R', r[1], ox + 200, Y + 40, 1);
    const t = s.tr(kind, q, ox + 260, Y, { pn: kind === 'NMOS' ? ['1', '2', '3'] : ['2', '1', '3'] });
    s.wire(pb, s.tag(pb, ox + 100, Y, 'l'), rs.a);
    s.wire(null, rs.b, t.g);
    s.wire(null, [ox + 200, Y], rg.a); s.gnd(rg.b[0], rg.b[1]);
    s.wire('GND', t.s, [ox + 270, Y + 70]); s.gnd(ox + 270, Y + 70);
    const x = s.conn(xr, ox + 400, Y - 90, 50, ['+12 В', row]);
    const dd = s.two('D', d, ox + 330, Y - 90, 3, { lp: 'l' });
    s.wire(out, t.d, [ox + 270, Y - 60], x.l[1]);
    s.tag(out, ox + 282, Y - 60, 'b', { plain: true, anchor: 'start' });
    s.pwr('F2', dd.b[0], dd.b[1]);
    s.wire('F2', dd.b, [ox + 370, Y - 120], [ox + 370, Y - 80], x.l[0]);
    return { Y, x };
  };
  const a = low(20, 40, 600, 'Форсунка: PB10 → Q7', 'PB10', 'INJ', 'NMOS', 'Q7', ['R32', 'R33'], 'D3', 'X12', 'Ф−');
  s.load('WIND', 'Y1', 470, a.Y - 70, { val: 'форсунка, ≈ 12 Ом' });
  const b = low(20, 310, 600, 'Нагреватель лямбда-зонда: PB15 → Q8', 'PB15', 'HEAT', 'NMOS', 'Q8', ['R34', 'R35'], 'D4', 'X14', 'Н−');
  s.load('HEAT', 'B3.2', 470, b.Y - 70, { val: 'нагреватель', note: 'лямбда-зонда' });
  const OX = 640, c = low(OX, 40, 700, 'Бензонасос: PB11 → Q9 → реле K1', 'PB11', 'RELAY', 'NPN', 'Q9', ['R36', 'R37'], 'D5', 'X13', '85');
  s.load('KCOIL', 'K1', OX + 450, c.Y - 70, { val: 'обмотка', note: '86 — к +12 В' });
  const k = s.two('SW', 'K1.1', OX + 600, c.Y - 70, 1, { val: 'контакты', pn: ['30', '87'] }), m = s.two('M', 'M1', OX + 600, c.Y + 10, 1);
  s.wire('F2', s.pwr('F2', OX + 600, c.Y - 110), k.a);
  s.wire(null, k.b, m.a);
  s.wire('GND', m.b, [OX + 600, c.Y + 70]); s.gnd(OX + 600, c.Y + 70);
  const tx = OX + 10;
  [
    ['Как работают ключи', 's2-h'],
    ['Форсунка: на время впрыска PB10 = 1, Q7 замыкает минус форсунки на массу. D3 гасит выброс при закрытии.', ''],
    ['Нагреватель: ШИМ 10 Гц на PB15, плавный прогрев от 20 % до заданной скважности. D4 — как D3.', ''],
    ['Насос: PB11 = 1 → Q9 включает обмотку реле K1 (выводы 85–86); контакты 30–87 подают +12 В на насос.', ''],
    ['R33, R35, R37 закрывают ключи, пока контроллер в сбросе.', ''],
    ['', ''],
    ['Цоколёвка (номера у выводов)', 's2-h'],
    ['IRLZ44N (TO-220): 1 — затвор, 2 и фланец — сток, 3 — исток.', ''],
    ['BC547C (TO-92, плоской стороной к себе, слева направо): 1 — коллектор, 2 — база, 3 — эмиттер.', ''],
    ['Q7, Q8 без встроенной защиты: диоды D3, D4 обязательны.', ''],
    ['', ''],
    ['Нагрузки питаются от аккумулятора через F2 10 А (+12V_F2), минуя диод D1.', ''],
  ].forEach(([t, cl], i) => { if (t) s.text(tx, 330 + i * 17, t, { cls: cl || 's2-note' }); });
  s.note('Реле K1 стоит в колодке XK1 вне платы. Цоколёвка и ток нагревателя конкретного лямбда-зонда не подтверждены — проверить по его документации; при токе больше 5 А Q8 нужен теплоотвод.');
  s.note(VERIFY);
  return s.done();
}

// ───────────────────────────── Холостой ход ─────────────────────────────
function iac(): Sheet {
  const s = new SheetBuilder('iac', 'Холостой ход', 1130, 440);
  const u = s.ic('U3', 260, 80, 120,
    ['1|EN1', '2|IN1', '9|IN2', '11|EN2', '12|IN3', '19|IN4', null, null, '20|VSS'],
    ['3|OUT1', '8|OUT2', '13|OUT3', '18|OUT4', null, '10|VS', null, '4…7|GND', '14…17|GND']);
  const pins: [number, string][] = [[1, 'PB6'], [2, 'PB7'], [4, 'PB8'], [5, 'PB9']];
  pins.forEach(([i, name]) => s.wire('IAC_IN', s.tag('IAC_IN', 140, u.l[i][1], 'l', { text: name }), u.l[i]));
  s.wire('PA8', s.tag('PA8', 140, 100, 'l'), u.l[0]);
  s.wire('PA8', [190, 100], [190, 160], u.l[3]);
  // питание логики
  s.wire('V5', s.pwr('V5', 90, 260), u.l[8]);
  const c9 = s.two('C', 'C9', 170, 300, 1);
  s.wire('V5', [170, 260], c9.a); s.gnd(170, 330);
  // силовое питание
  s.wire('V12', u.r[5], s.pwr('V12', 510, 200));
  const c17 = s.two('CP', 'C17', 465, 240, 1, { val: '47 мкФ' });
  s.wire('V12', [465, 200], c17.a); s.gnd(465, 270);
  s.wire('GND', u.r[7], [430, 240], [430, 290]); s.gnd(430, 290);
  s.wire('GND', u.r[8], [430, 260]);
  // обмотки
  const x = s.conn('X15', 540, 90, 50, ['A1', 'A2', 'B1', 'B2']);
  [0, 1, 2, 3].forEach((i) => s.wire('IAC_OUT', u.r[i], x.l[i]));
  s.tag('IAC_OUT', 410, 100, 't', { plain: true, anchor: 'start' });
  const wa = s.load('WIND', 'M2.1', 630, 110, { val: 'обмотка A' }), wb = s.load('WIND', 'M2.2', 630, 150, { val: 'обмотка B' });
  s.wire('IAC_OUT', x.r[0], wa.a); s.wire('IAC_OUT', x.r[1], wa.b);
  s.wire('IAC_OUT', x.r[2], wb.a); s.wire('IAC_OUT', x.r[3], wb.b);
  s.text(630, 192, 'шаговый регулятор', { cls: 's2-small' });
  // PC13
  const r38 = s.two('R', 'R38', 90, 400);
  s.pwr('V33', r38.a[0], r38.a[1]);
  s.wire('PC13', r38.b, s.tag('PC13', 160, 400, 'r', { desc: '→ A1' }));
  const tx = 800;
  [
    ['Как работает', 's2-h'],
    ['U3 — два моста: OUT1–OUT2 питают обмотку A,', ''], ['OUT3–OUT4 — обмотку B. Защитные диоды —', ''], ['внутри микросхемы.', ''],
    ['PA8 = 1 разрешает оба моста (EN1, EN2).', ''],
    ['Шаг — раз в 4 мс; в каждый момент активен', ''], ['один вход в порядке PB6 → PB8 → PB7 → PB9', ''], ['(назад — в обратном порядке).', ''],
    ['', ''],
    ['PC13: у L293DD нет выхода аварии, поэтому', ''], ['вход постоянно подтянут к +3,3 В через R38.', ''], ['При 0 В на PC13 прошивка запрещает драйвер.', ''],
    ['', ''],
    ['Ток обмотки — до 0,6 А: сопротивление', ''], ['обмоток РХХ должно быть не меньше 25 Ом.', ''],
  ].forEach(([t, c], i) => { if (t) s.text(tx, 90 + i * 16, t, { cls: c || 's2-note' }); });
  s.note('U3 L293DD в корпусе SO-20: у выводов — номера по корпусу; выводы 4–7 и 14–17 — масса и теплоотвод, все восемь припаять к полигону массы.');
  s.note('Соответствие выводов разъёма X15 обмоткам конкретного регулятора определить омметром: обмотка A — между A1 и A2, обмотка B — между B1 и B2. Если шток движется не в ту сторону — поменять направление в параметрах.');
  s.note(VERIFY);
  return s.done();
}

export const SHEETS: Sheet[] = [overview(), power(), mcu(), sensors(), ignition(), fuel(), iac()];

/** Лист, на который переходить при выборе цепи: подробные листы важнее контроллера и обзора. */
const ORDER = ['power', 'sensors', 'ign', 'fuel', 'iac', 'mcu', 'overview'];
export function netsOf(sheet: Sheet): Set<string> {
  const out = new Set<string>();
  for (const w of sheet.wires) if (w.net) out.add(w.net);
  for (const e of sheet.els) { if (e.k === 'tag' || e.k === 'pwr') out.add(e.net); else if (e.k === 'gnd') out.add('GND'); }
  return out;
}
const SHEET_NETS = new Map(SHEETS.map((s) => [s.id, netsOf(s)]));
export const sheetHasNet = (sheetId: string, net: string) => !!SHEET_NETS.get(sheetId)?.has(net);
export function homeSheet(net: string): string | null {
  return ORDER.find((id) => sheetHasNet(id, net)) ?? null;
}
