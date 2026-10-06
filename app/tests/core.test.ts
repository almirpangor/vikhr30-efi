import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bracket, lookupMap, workPoint, fuelFlowMlMin, parseMapCsv, mapToCsv, injectorDeadtime, warmupPermille, coilDwell, diffCells, cloneMap } from '../src/core/calc';
import { parseLine, Link, EcuError } from '../src/core/protocol';
import { EcuEmulator } from '../src/core/emulator';
import { DEFAULT_FUEL, DEFAULT_IGN, PARAMS, RPM_BINS, LOAD_BINS, TELEMETRY_KEYS, type Telemetry } from '../src/core/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('bracket: края и середина, как в прошивке', () => {
  assert.deepEqual(bracket(100, RPM_BINS), { lo: 0, hi: 0, fraction: 0 });
  assert.deepEqual(bracket(600, RPM_BINS), { lo: 0, hi: 0, fraction: 0 });
  assert.deepEqual(bracket(750, RPM_BINS), { lo: 0, hi: 1, fraction: 500 });
  assert.deepEqual(bracket(900, RPM_BINS), { lo: 0, hi: 1, fraction: 1000 });
  assert.deepEqual(bracket(9000, RPM_BINS), { lo: 12, hi: 12, fraction: 0 });
  assert.deepEqual(bracket(35, LOAD_BINS), { lo: 1, hi: 2, fraction: 500 });
});

test('lookupMap: узлы сетки дают значения ячеек', () => {
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 13; c++) {
      assert.equal(lookupMap(DEFAULT_FUEL, RPM_BINS[c], LOAD_BINS[r]), DEFAULT_FUEL[r][c]);
      assert.equal(lookupMap(DEFAULT_IGN, RPM_BINS[c], LOAD_BINS[r]), DEFAULT_IGN[r][c]);
    }
});

test('lookupMap: ручной расчёт между ячейками', () => {
  // rpm 750 (между 600 и 900, доля 500), TPS 1,0 % (между 0 и 2 %, доля 500)
  // строка 0: 1880 + (1590-1880)*500/1000 = 1735; строка 1: 1930 + (1670-1930)/2 = 1800; итог 1735 + 65/2 = 1767
  assert.equal(lookupMap(DEFAULT_FUEL, 750, 10), 1767);
  // убывающий участок с усечением к нулю: 1260 → 890 при доле 333
  assert.equal(lookupMap(DEFAULT_FUEL, 1800, 0), 1260 + Math.trunc((-370 * 333) / 1000));
});

test('workPoint: веса в сумме дают 1, не больше четырёх ячеек', () => {
  const w = workPoint(2600, 275);
  assert.equal(w.cells.length, 4);
  assert.ok(Math.abs(w.cells.reduce((s, c) => s + c.weight, 0) - 1) < 1e-9);
  assert.equal(workPoint(600, 0).cells.length, 1);
});

test('вспомогательные таблицы прошивки', () => {
  assert.equal(injectorDeadtime(14000), 649);
  assert.equal(injectorDeadtime(7000), 1951);
  assert.equal(injectorDeadtime(12500), 876 + Math.trunc((500 * (726 - 876)) / 1000));
  assert.equal(warmupPermille(750), 1000);
  assert.equal(warmupPermille(200), 1200);
  assert.equal(coilDwell(1600, 13800), 1600);
  assert.equal(fuelFlowMlMin(500), 270);
});

test('CSV карты: запись и чтение совпадают', () => {
  const csv = mapToCsv(DEFAULT_FUEL, 1, 0);
  assert.deepEqual(parseMapCsv(csv, 1), DEFAULT_FUEL);
  const csvI = mapToCsv(DEFAULT_IGN, 10, 1);
  assert.deepEqual(parseMapCsv(csvI, 10), DEFAULT_IGN);
  assert.throws(() => parseMapCsv('a,b\n1,2', 1));
});

test('parseLine: все типы строк', () => {
  const fields = TELEMETRY_KEYS.map((_, i) => i + 1);
  const t = parseLine('T,' + fields.join(','));
  assert.equal(t.kind, 'telemetry');
  if (t.kind === 'telemetry') { assert.equal(t.t.rpm, 1); assert.equal(t.t.outputMask, 33); assert.equal(t.t.kill, 23); }
  // старая прошивка: только 22 поля
  const old = parseLine('T,' + fields.slice(0, 22).join(','));
  assert.equal(old.kind, 'telemetry');
  assert.equal(parseLine('T,1,2,3').kind, 'bad');
  assert.equal(parseLine('T,' + fields.join(',').replace('5', 'x')).kind, 'bad');
  assert.deepEqual(parseLine('F,2,' + DEFAULT_FUEL[2].join(',')), { kind: 'fuelRow', row: 2, values: DEFAULT_FUEL[2] });
  assert.equal(parseLine('F,2,1,2,3').kind, 'bad');
  assert.equal(parseLine('F,9,' + DEFAULT_FUEL[2].join(',')).kind, 'bad');
  assert.deepEqual(parseLine('P,dwell_us,1600'), { kind: 'param', key: 'dwell_us', value: 1600 });
  assert.deepEqual(parseLine('OK,TEST,PUMP'), { kind: 'ok', args: ['TEST', 'PUMP'] });
  assert.deepEqual(parseLine('ERR,service_lock'), { kind: 'err', code: 'service_lock' });
  assert.deepEqual(parseLine('TEST,DONE,PUMP'), { kind: 'test', event: 'DONE', name: 'PUMP' });
  assert.equal(parseLine('END').kind, 'end');
  assert.equal(parseLine('').kind, 'bad');
  assert.equal(parseLine('\u0000ÿ мусор').kind, 'bad');
});

function connect(emu: EcuEmulator) {
  const seen: Telemetry[] = [], tests: string[] = [];
  const link = new Link(emu, { telemetry: (t) => seen.push(t), test: (e, n) => tests.push(e + ':' + n) });
  return { link, seen, tests };
}

test('эмулятор: связь, телеметрия 10 Гц, чтение карт и параметров', async () => {
  const emu = new EcuEmulator();
  const { link, seen } = connect(emu);
  assert.equal(await link.ping(), '0.8.0-C6-BT-DIAG');
  const maps = await link.readMaps();
  assert.deepEqual(maps.fuel, DEFAULT_FUEL);
  assert.deepEqual(maps.ign, DEFAULT_IGN);
  const params = await link.readParams();
  for (const d of PARAMS) assert.equal(params[d.key], d.def, d.key);
  await sleep(600);
  assert.ok(seen.length >= 4 && seen.length <= 9, 'кадров телеметрии: ' + seen.length);
  assert.equal(seen.at(-1)!.service, 1);
  await link.close();
});

test('запись карт: все 234 ячейки, сверка, сохранение во Flash и перезапуск', async () => {
  const emu = new EcuEmulator();
  const { link } = connect(emu);
  const fuel = DEFAULT_FUEL.map((r) => r.map((v) => v + 37)), ign = DEFAULT_IGN.map((r) => r.map((v) => Math.min(300, v + 3)));
  let last = 0;
  const res = await link.writeMaps({ fuel, ign }, (d) => { last = d; });
  assert.equal(res.written, 234);
  assert.equal(last, 234);
  assert.deepEqual(emu.cal.fuel, fuel);
  assert.deepEqual(emu.cal.ign, ign);
  assert.equal(emu.rxOverflowBytes, 0, 'очередь команд не должна переполнять буфер ECU');
  assert.deepEqual(emu.flash.fuel, DEFAULT_FUEL, 'до SAVE Flash не меняется');
  assert.deepEqual(await link.ok('SAVE'), ['SAVED']);
  emu.boot();
  assert.deepEqual((await link.readMaps()).fuel, fuel);
  // повторная запись того же — ноль команд
  assert.equal((await link.writeMaps({ fuel, ign })).written, 0);
  await link.close();
});

test('П4: залп из 234 команд без ожидания ответа теряет данные (поведение старой программы)', async () => {
  const emu = new EcuEmulator();
  const fuel = DEFAULT_FUEL.map((r) => r.map((v) => v + 11));
  let burst = '';
  for (let r = 0; r < 9; r++) for (let c = 0; c < 13; c++) burst += `SET FUEL ${r} ${c} ${fuel[r][c]}\n`;
  for (let r = 0; r < 9; r++) for (let c = 0; c < 13; c++) burst += `SET IGN ${r} ${c} ${DEFAULT_IGN[r][c] + 4}\n`;
  emu.onData = () => {};
  emu.write(burst);
  await sleep(900);
  emu.close();
  const lost = diffCells(emu.cal.fuel, fuel).length + diffCells(emu.cal.ign, DEFAULT_IGN.map((r) => r.map((v) => v + 4))).length;
  console.log(`    залп: потеряно байт ${emu.rxOverflowBytes}, неверных ячеек ${lost} из 234`);
  assert.ok(emu.rxOverflowBytes > 0, 'буфер 256 байт должен переполниться');
  assert.ok(lost > 0, 'часть ячеек должна потеряться');
});

test('помехи в канале: запись карт завершается верно или сообщает об ошибке', async () => {
  let okRuns = 0, errRuns = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const emu = new EcuEmulator({ seed });
    emu.noise = { dropToEcu: 0.015, corruptToEcu: 0.015, dropFromEcu: 0.015, corruptFromEcu: 0.015 };
    const { link } = connect(emu);
    const fuel = DEFAULT_FUEL.map((r, i) => r.map((v, j) => v + ((i * 13 + j * 7 + seed) % 90)));
    const ign = cloneMap(DEFAULT_IGN);
    ign[4][6] = 123;
    try {
      await link.writeMaps({ fuel, ign });
      emu.noise = { dropToEcu: 0, corruptToEcu: 0, dropFromEcu: 0, corruptFromEcu: 0 };
      assert.deepEqual(emu.cal.fuel, fuel, 'seed ' + seed);
      assert.deepEqual(emu.cal.ign, ign, 'seed ' + seed);
      okRuns++;
    } catch (e) {
      assert.ok(e instanceof EcuError, String(e));
      errRuns++;
    }
    await link.close();
  }
  console.log(`    с помехами 1,5 % на строку в каждую сторону: успешно ${okRuns}, с явной ошибкой ${errRuns}`);
  assert.ok(okRuns >= 5, 'большинство записей должно проходить за счёт повторов');
});

test('блокировки: запись и тесты запрещены на работающем двигателе и без SERVICE', async () => {
  const emu = new EcuEmulator();
  const { link, seen, tests } = connect(emu);
  emu.inputs.service = false;
  await assert.rejects(link.ok('SET FUEL 0 0 2000'), (e: EcuError) => e.code === 'service_lock');
  await assert.rejects(link.ok('TEST PUMP'), (e: EcuError) => e.code === 'service_lock');
  await assert.rejects(link.ok('SAVE'), (e: EcuError) => e.code === 'service_lock');
  emu.inputs.service = true;
  emu.inputs.running = true;
  await sleep(700);
  assert.ok(seen.at(-1)!.rpm > 300, 'двигатель должен раскрутиться');
  assert.equal(seen.at(-1)!.service, 0);
  await assert.rejects(link.ok('SET FUEL 0 0 2000'), (e: EcuError) => e.code === 'service_lock');
  await assert.rejects(link.ok('TEST COIL1'), (e: EcuError) => e.code === 'service_lock');
  assert.deepEqual(emu.cal.fuel, DEFAULT_FUEL);
  emu.inputs.running = false;
  await sleep(3500);
  assert.equal(seen.at(-1)!.rpm, 0);
  // все семь тестов
  for (const name of ['PUMP', 'INJECTOR', 'COIL1', 'COIL2', 'IAC_OPEN', 'IAC_CLOSE', 'O2_HEATER']) {
    assert.deepEqual(await link.ok('TEST ' + name), ['TEST', name]);
    if (name === 'PUMP') { await sleep(150); assert.equal(seen.at(-1)!.actuatorTest, 1); assert.deepEqual(await link.ok('TEST STOP'), ['TEST', 'STOP']); }
    else if (name === 'O2_HEATER') { await sleep(150); await link.ok('TEST STOP'); }
    else await sleep(700);
  }
  await sleep(150);
  assert.equal(seen.at(-1)!.actuatorTest, 0);
  for (const name of ['PUMP', 'INJECTOR', 'COIL1', 'COIL2', 'IAC_OPEN', 'IAC_CLOSE', 'O2_HEATER']) assert.ok(tests.includes('DONE:' + name), 'DONE ' + name);
  // чека прерывает тест
  await link.ok('TEST PUMP');
  emu.inputs.kill = true;
  await sleep(200);
  assert.equal(seen.at(-1)!.actuatorTest, 0);
  assert.equal(seen.at(-1)!.kill, 1);
  // неисправный драйвер РХХ
  emu.inputs.kill = false;
  emu.inputs.iacDriverOk = false;
  await assert.rejects(link.ok('TEST IAC_OPEN'), (e: EcuError) => e.code === 'bad_test');
  await link.close();
});

test('параметры: запись со сверкой, отсечка ограничивает обороты', async () => {
  const emu = new EcuEmulator();
  const { link, seen } = connect(emu);
  const back = await link.writeParams({ rev_limit_soft: 5600, rev_limit_hard: 5800, dwell_us: 1200 });
  assert.equal(back.rev_limit_soft, 5600);
  assert.equal(emu.cal.p.dwell_us, 1200);
  await assert.rejects(link.ok('SET PARAM no_such 1'), (e: EcuError) => e.code === 'unknown_parameter');
  emu.inputs.running = true;
  emu.inputs.throttle = 1;
  await sleep(4000);
  const t = seen.at(-1)!;
  assert.ok(t.rpm > 5200 && t.rpm < 5900, 'обороты у отсечки: ' + t.rpm);
  assert.ok(t.flags & (1 << 5), 'флаг отсечки');
  assert.ok(t.duty10 > 0 && t.pwUs > 500);
  await link.close();
});

test('обрыв связи: ожидающие команды завершаются ошибкой, событие closed приходит', async () => {
  const emu = new EcuEmulator();
  let closed = false;
  const link = new Link(emu, { closed: () => { closed = true; } });
  await link.ping();
  const p = link.readMaps();
  emu.unplug();
  await assert.rejects(p, (e: EcuError) => e.code === 'closed');
  assert.ok(closed);
  await assert.rejects(link.ping(), (e: EcuError) => e.code === 'closed');
});

test('молчащий порт: таймаут, а не зависание', async () => {
  const silent = { write() {}, onData: null, onClose: null, close() {} };
  const link = new Link(silent);
  const t0 = Date.now();
  await assert.rejects(link.ping(200, 1), (e: EcuError) => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 1000);
});

// ---------- устойчивость ядра ----------

test('CSV карты: «;» как разделитель и десятичная запятая (Excel с русскими настройками)', () => {
  const head = 'TPS_pct;' + RPM_BINS.join(';');
  const lines = DEFAULT_IGN.map((row, r) => `${String(LOAD_BINS[r] / 10).replace('.', ',')};` + row.map((v) => (v / 10).toFixed(1).replace('.', ',')).join(';'));
  assert.deepEqual(parseMapCsv([head, ...lines].join('\r\n') + '\r\n', 10), DEFAULT_IGN);
  // табуляция и лишние пробелы вокруг чисел
  const tab = [head.replace(/;/g, '\t'), ...lines.map((l) => l.replace(/;/g, ' \t '))].join('\n');
  assert.deepEqual(parseMapCsv(tab, 10), DEFAULT_IGN);
  // «;» в конце каждой строки (так сохраняет Excel) не мешает
  assert.deepEqual(parseMapCsv([head + ';', ...lines.map((l) => l + ';')].join('\r\n'), 10), DEFAULT_IGN);
  // нечисло — понятная ошибка с номером строки и столбца
  const broken = [head, ...lines]; broken[3] = broken[3].replace(/;[^;]+;/, ';abc;');
  assert.throws(() => parseMapCsv(broken.join('\n'), 10), /Строка 4, столбец 2/);
});

test('CSV карты: BOM, пустые строки в начале, середине и конце', () => {
  const csv = mapToCsv(DEFAULT_FUEL, 1, 0).split('\r\n');
  const messy = '﻿\r\n\r\n' + csv[0] + '\r\n\r\n' + csv.slice(1, 5).join('\r\n') + '\r\n   \r\n' + csv.slice(5).join('\r\n') + '\r\n\r\n\r\n';
  assert.deepEqual(parseMapCsv(messy, 1), DEFAULT_FUEL);
  assert.deepEqual(parseMapCsv('﻿' + mapToCsv(DEFAULT_IGN, 10, 1), 10), DEFAULT_IGN);
  // не хватает строки или столбца — ошибка, а не молча неполная карта
  assert.throws(() => parseMapCsv(csv.slice(0, 9).join('\r\n'), 1), /меньше 10 строк/);
  assert.throws(() => parseMapCsv(csv.map((l) => l.split(',').slice(0, 13).join(',')).join('\r\n'), 1), /нужно 13 значений/);
  assert.throws(() => parseMapCsv('', 1));
});

/** Транспорт-заглушка: тест сам решает, что и когда «ответит ECU». */
function fakeTransport(onWrite: (cmd: string, reply: (line: string, delayMs?: number) => void) => void) {
  const sent: string[] = [];
  const t = {
    onData: null as ((c: string) => void) | null, onClose: null as (() => void) | null, sent,
    write(data: string) {
      const cmd = data.trim();
      sent.push(cmd);
      onWrite(cmd, (line, delayMs = 0) => { setTimeout(() => t.onData?.(line + '\r\n'), delayMs); });
    },
    close() {},
  };
  return t;
}

test('мусор в канале: случайные байты без переводов строк и сверхдлинные строки не роняют связь и не копятся', async () => {
  const t = fakeTransport((cmd, reply) => { if (cmd === 'PING') reply('OK,VIKHR30_STM32,0.8.0'); });
  const seen: Telemetry[] = [];
  const link = new Link(t, { telemetry: (x) => seen.push(x) });
  const inner = link as unknown as { buf: string };
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const junk = (n: number, eol: boolean) => {
    let s = '';
    while (s.length < n) { const c = Math.floor(rnd() * 256); if (!eol && (c === 10 || c === 13)) continue; s += String.fromCharCode(c); }
    return s;
  };
  // 200 кусков по 5 КБ без единого перевода строки (1 МБ): буфер не должен расти
  let maxBuf = 0;
  for (let i = 0; i < 200; i++) { link.feed(junk(5000, false)); maxBuf = Math.max(maxBuf, inner.buf.length); }
  assert.ok(maxBuf <= 5000 + 1024, 'буфер приёма разросся до ' + maxBuf);
  assert.ok(inner.buf.length <= 1024, 'после куска остаётся не больше предела: ' + inner.buf.length);
  // строки длиннее 4 КБ, в том числе похожие на протокол
  link.feed('\n' + 'T,' + '1,'.repeat(3000) + '1\n');
  link.feed('OK,' + 'x'.repeat(6000) + '\r\n');
  link.feed('F,0,' + '9'.repeat(5000) + '\n');
  // случайные байты с переводами строк
  for (let i = 0; i < 50; i++) link.feed(junk(5000, true));
  assert.equal(seen.length, 0, 'мусор не должен стать телеметрией');
  assert.ok(link.stats.badLines > 0);
  // после мусора (в буфере — хвост без перевода строки) нормальный обмен продолжается
  link.feed(junk(300, false));
  link.feed('\n');
  assert.equal(await link.ping(300, 1), '0.8.0');
  const fields = TELEMETRY_KEYS.map((_, i) => i + 1);
  link.feed('T,' + fields.join(',') + '\r\n');
  assert.equal(seen.length, 1);
  // мусор посреди ожидания ответа не принимается за ответ
  const p = link.ok('STREAM 10', 150, 0);
  link.feed(junk(5000, true) + '\nOK,' + junk(40, false) + '\n');
  await assert.rejects(p, (e: EcuError) => e.code === 'timeout');
});

test('очередь: запросы, отправленные подряд без ожидания, уходят и завершаются по порядку', async () => {
  const emu = new EcuEmulator();
  const { link } = connect(emu);
  const sentOrder: string[] = [], doneOrder: string[] = [];
  const orig = emu.write.bind(emu);
  emu.write = (d: string) => { sentOrder.push(d.trim()); orig(d); };
  const cmds = ['SET FUEL 0 0 2000', 'SET FUEL 0 0 2100', 'SET IGN 1 1 77', 'SET FUEL 0 0 2200', 'SET PARAM dwell_us 1234', 'SET FUEL 0 0 2300'];
  const all = cmds.map((c) => link.ok(c).then(() => { doneOrder.push(c); }));
  const maps = link.readMaps().then((m) => { doneOrder.push('MAPS'); return m; });
  const ping = link.ping().then(() => { doneOrder.push('PING'); });
  await Promise.all([...all, maps, ping]);
  // readMaps читает карты дважды (сверка); PING, поставленный в очередь позже, уходит после первого чтения
  assert.deepEqual(sentOrder, [...cmds, 'GET MAPS', 'PING', 'GET MAPS'], 'порядок отправки');
  assert.deepEqual(doneOrder, [...cmds, 'PING', 'MAPS'], 'порядок завершения');
  assert.equal(emu.cal.fuel[0][0], 2300, 'последняя запись побеждает');
  assert.equal((await maps).fuel[0][0], 2300, 'чтение, поставленное после записей, видит их все');
  assert.equal(emu.cal.ign[1][1], 77);
  assert.equal(emu.cal.p.dwell_us, 1234);
  // ни одна команда не отправлена, пока не пришёл ответ на предыдущую: в «проводе» никогда не было двух команд
  assert.equal(emu.rxOverflowBytes, 0);
  await link.close();
});

test('опоздавший ответ: поздний OK на прежний SET не засчитывается следующей команде (PING-барьер)', async () => {
  // ECU отвечает с задержкой 150 мс при таймауте 100 мс; вторую команду (SET B) «теряет провод».
  const applied: string[] = [];
  const t = fakeTransport((cmd, reply) => {
    if (cmd === 'PING') return reply('OK,VIKHR30_STM32,0.8.0', 150);
    if (cmd === 'SET FUEL 1 1 2222') return;           // потеряна по дороге к ECU
    if (cmd.startsWith('SET')) { applied.push(cmd); reply('OK', 150); }
  });
  const link = new Link(t);
  const a = link.ok('SET FUEL 0 0 1111', 100, 1);
  const b = link.ok('SET FUEL 1 1 2222', 100, 1);
  await a; // принят опоздавший OK на первую посылку — это верно: команда A выполнена
  // Без защиты второй (опоздавший) OK на A подтвердил бы B, которой ECU не получал.
  await assert.rejects(b, (e: EcuError) => e.code === 'timeout');
  assert.ok(!applied.includes('SET FUEL 1 1 2222'));
  assert.ok(link.stats.barriers >= 1, 'после таймаута должен быть отправлен PING-барьер');
  assert.ok(link.stats.staleDropped >= 1, 'опоздавший OK должен быть отброшен');
  const iA = t.sent.lastIndexOf('SET FUEL 0 0 1111'), iB = t.sent.indexOf('SET FUEL 1 1 2222');
  assert.ok(t.sent.slice(iA + 1, iB).includes('PING'), 'барьер стоит между повтором A и командой B: ' + t.sent.join(' | '));
  // канал приходит в себя: следующая команда проходит и получает именно свой ответ
  const c = await link.ok('SET FUEL 2 2 3333', 400, 1);
  assert.deepEqual(c, []);
  assert.equal(applied.at(-1), 'SET FUEL 2 2 3333');
});

test('опоздавший ответ: чужой OK не подтверждает SAVE, DEFAULTS, TEST; молчащий ECU не вешает очередь', async () => {
  let mode: 'wrong' | 'right' | 'silent' = 'wrong';
  const t = fakeTransport((cmd, reply) => {
    if (mode === 'silent') return;
    if (cmd === 'PING') return reply('OK,VIKHR30_STM32,0.8.0');
    if (mode === 'wrong') return reply('OK'); // как будто пришёл ответ на другую команду
    reply(cmd === 'SAVE' ? 'OK,SAVED' : cmd === 'DEFAULTS' ? 'OK,DEFAULTS_RAM' : cmd === 'HOMEIAC' ? 'OK,IAC_HOMING' : cmd.startsWith('TEST') ? 'OK,TEST,' + cmd.split(' ')[1] : 'OK');
  });
  const link = new Link(t);
  for (const cmd of ['SAVE', 'DEFAULTS', 'HOMEIAC', 'TEST PUMP'])
    await assert.rejects(link.ok(cmd, 80, 0), (e: EcuError) => e.code === 'timeout', cmd);
  // и наоборот: «OK,SAVED» не подтверждает SET
  mode = 'right';
  const p = link.ok('SET FUEL 0 0 1000', 80, 0);
  link.feed('OK,SAVED\r\n');
  await p; // принят настоящий «OK», а не «OK,SAVED»
  assert.ok(link.stats.staleDropped >= 5);
  assert.deepEqual(await link.ok('SAVE', 80, 0), ['SAVED']);
  assert.deepEqual(await link.ok('TEST COIL1', 80, 0), ['TEST', 'COIL1']);
  assert.deepEqual(await link.ok('HOMEIAC', 80, 0), ['IAC_HOMING']);
  // ECU замолчал: три команды в очереди завершаются таймаутом за ограниченное время
  mode = 'silent';
  const t0 = Date.now();
  const res = await Promise.allSettled([link.ok('SET FUEL 0 0 1', 80, 0), link.ok('SET FUEL 0 0 2', 80, 0), link.ping(80, 0)]);
  assert.ok(res.every((r) => r.status === 'rejected' && (r.reason as EcuError).code === 'timeout'));
  assert.ok(Date.now() - t0 < 5000, 'очередь не должна зависать: ' + (Date.now() - t0) + ' мс');
  assert.equal(link.busy, false);
  // ECU вернулся — связь восстанавливается без пересоздания Link
  mode = 'right';
  assert.equal(await link.ping(200, 1), '0.8.0');
  assert.deepEqual(await link.ok('SET FUEL 0 0 3', 200, 1), []);
});

test('эмулятор: широкополосная лямбда (o2_mode = 1) по формулам прошивки', async () => {
  const emu = new EcuEmulator({ autoRun: false });
  const { link, seen } = connect(emu);
  const run = async (ms: number) => { emu.step(ms); await sleep(0); };
  const p = link.writeParams({ o2_mode: 1 });
  for (let i = 0; i < 40; i++) await run(50);
  await p;
  await run(2000);
  let t = seen.at(-1)!;
  assert.equal(t.rpm, 0);
  assert.equal(t.lambdaDir, 2, 'двигатель стоит: контроллер упёрся в 5 В — «нет данных»');
  assert.ok(t.o2Mv > 4950 && (t.flags & 256), 'o2Mv ' + t.o2Mv);
  emu.inputs.running = true; emu.inputs.throttle = 0.2;
  await run(6000);
  t = seen.at(-1)!;
  assert.ok(t.rpm > 2000);
  assert.ok(t.lambdaMilli >= 950 && t.lambdaMilli <= 1010, 'λ на частичной нагрузке: ' + t.lambdaMilli);
  assert.equal(t.lambdaMilli, 700 + Math.trunc((t.o2Mv * 600) / 5000), 'пересчёт напряжения в λ как в read_sensors()');
  assert.ok(!(t.flags & 256));
  assert.equal(t.heater, 0, 'нагревателем широкополосного датчика ECU не управляет');
  emu.inputs.throttle = 1;
  await run(5000);
  t = seen.at(-1)!;
  assert.ok(t.lambdaMilli >= 850 && t.lambdaMilli <= 900 && t.lambdaDir === -1, 'λ на полном газу: ' + t.lambdaMilli);
  // узкополосный режим по-прежнему даёт λ = 0
  emu.inputs.running = false; emu.inputs.throttle = 0;
  await run(12000);
  const p2 = link.writeParams({ o2_mode: 0 });
  for (let i = 0; i < 40; i++) await run(50);
  await p2;
  await run(500);
  assert.equal(seen.at(-1)!.lambdaMilli, 0);
  await link.close();
});

test('эмулятор: «обрыв провода» (silent) — команды завершаются таймаутом, после восстановления связь работает', async () => {
  const emu = new EcuEmulator();
  const { link, seen } = connect(emu);
  await link.ping();
  emu.silent = true;
  await sleep(50);
  const n = seen.length;
  await assert.rejects(link.ok('SET FUEL 0 0 2000', 100, 1), (e: EcuError) => e.code === 'timeout');
  await sleep(300);
  assert.equal(seen.length, n, 'телеметрия не должна приходить');
  assert.deepEqual(emu.cal.fuel, DEFAULT_FUEL);
  emu.silent = false;
  assert.equal(await link.ping(300, 2), '0.8.0-C6-BT-DIAG');
  await link.ok('SET FUEL 0 0 2000');
  assert.equal(emu.cal.fuel[0][0], 2000);
  await link.close();
});

test('геометрия: нормали выдавленных деталей смотрят наружу при любом обходе контура', async () => {
  const { extrude, roundedRect, hexPrism, box } = await import('../src/gl/geometry');
  const inward = (g: { positions: Float32Array; normals: Float32Array }) => {
    const p = g.positions, n = g.normals, c = [0, 0, 0];
    for (let i = 0; i < p.length; i += 3) { c[0] += p[i]; c[1] += p[i + 1]; c[2] += p[i + 2]; }
    for (let k = 0; k < 3; k++) c[k] /= p.length / 3;
    let bad = 0;
    for (let i = 0; i < p.length; i += 3) if ((p[i] - c[0]) * n[i] + (p[i + 1] - c[1]) * n[i + 1] + (p[i + 2] - c[2]) * n[i + 2] < -1e-6) bad++;
    return bad;
  };
  assert.equal(inward(box(2, 3, 4)), 0);
  assert.equal(inward(extrude(roundedRect(4, 2, 0.5), 1)), 0, 'roundedRect');
  assert.equal(inward(hexPrism(1, 0.6)), 0, 'hexPrism');
  assert.equal(inward(extrude([[1, -1], [1, 1], [-1, 1], [-1, -1]], 1)), 0, 'обход в одну сторону');
  assert.equal(inward(extrude([[-1, -1], [-1, 1], [1, 1], [1, -1]], 1)), 0, 'обход в другую сторону');
});
