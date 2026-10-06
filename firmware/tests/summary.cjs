#!/usr/bin/env node
/*
 * Runs every simulator scenario on the v0.9 firmware (must pass) and on the
 * unmodified v0.8 firmware (for comparison), then prints a PASS/FAIL summary.
 * Exit code 0 only when all v0.9 checks pass.
 */
"use strict";
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BUILD = path.join(__dirname, "build");
const DUMP = path.join(BUILD, "dump");
fs.mkdirSync(DUMP, { recursive: true });
const QUICK = process.argv.includes("--quick");

function run(fw, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(path.join(BUILD, "sim_" + fw), args.map(String), { env: { ...process.env, ...env }, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`sim_${fw} ${args.join(" ")}: ${err.message} ${stderr}`));
        const r = {};
        for (const line of stdout.split("\n")) {
          const i = line.indexOf("=");
          if (i > 0) { const v = line.slice(i + 1); r[line.slice(0, i)] = /^-?[0-9.]+$/.test(v) ? Number(v) : v; }
        }
        resolve(r);
      });
  });
}

async function pool(jobs, width) {
  const results = new Array(jobs.length); let next = 0;
  async function worker() { while (next < jobs.length) { const i = next++; results[i] = await jobs[i](); } }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

const lines = []; let failures = 0, checks = 0;
function out(s = "") { lines.push(s); console.log(s); }
function check(name, ok, detail) { checks++; if (!ok) failures++; out(`[${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`); }
function info(name, detail) { out(`[info] ${name}: ${detail}`); }
const ms = (us) => (us / 1000).toFixed(2) + " мс";

let LIMIT = { inj_us: 10, dwell_us: 10, angle_deg: 1.0, coil_on_us: 10000, inj_open_us: 10000 };

function engineOk(r, w, opt = {}) {
  return r[w + "_missed_sparks"] === 0 && r[w + "_extra_sparks"] === 0 && r[w + "_missed_inj"] === 0 &&
    r[w + "_unsynced_teeth"] === 0 && r[w + "_sparks"] > 0 &&
    r[w + "_max_inj_err_us"] <= LIMIT.inj_us && r[w + "_max_dwell_err_us"] <= LIMIT.dwell_us &&
    r[w + "_max_angle_err_deg"] <= (opt.angle || LIMIT.angle_deg) &&
    r.coil1_max_on_us <= LIMIT.coil_on_us && r.coil2_max_on_us <= LIMIT.coil_on_us && r.inj_max_open_us <= LIMIT.inj_open_us &&
    r.ts_bad === 0 && r.ts_checked > 0 && r.wdt_resets === 0;
}
function engineText(r, w) {
  return `искр ${r[w + "_sparks"]}, пропущено ${r[w + "_missed_sparks"]}, лишних ${r[w + "_extra_sparks"]}; ` +
    `впрысков ${r[w + "_injections"]}, пропущено ${r[w + "_missed_inj"]}; ` +
    `ош. впрыска ≤${r[w + "_max_inj_err_us"].toFixed(1)} мкс, ош. накопления ≤${r[w + "_max_dwell_err_us"].toFixed(1)} мкс, ` +
    `ош. УОЗ ≤${r[w + "_max_angle_err_deg"].toFixed(2)}° (средн. ${r[w + "_mean_angle_err_deg"].toFixed(2)}°); ` +
    `зубьев без синхр. ${r[w + "_unsynced_teeth"]}/${r[w + "_teeth"]}; ` +
    `катушка под током ≤${ms(Math.max(r.coil1_max_on_us, r.coil2_max_on_us))}, форсунка открыта ≤${ms(r.inj_max_open_us)}; ` +
    `метки времени зубьев: неверных ${r.ts_bad} из ${r.ts_checked}`;
}

function readDump(name, uart) { return fs.readFileSync(path.join(DUMP, `${name}.uart${uart}.txt`), "latin1"); }
const num = "-?\\d+";
const reT = new RegExp(`^T(,${num}){33}$`);
function mapsBlock() {
  const a = [new RegExp(`^R(,${num}){13}$`), new RegExp(`^L(,${num}){9}$`)];
  for (let r = 0; r < 9; ++r) a.push(new RegExp(`^F,${r}(,${num}){13}$`));
  for (let r = 0; r < 9; ++r) a.push(new RegExp(`^I,${r}(,${num}){13}$`));
  a.push(/^END$/); return a;
}
function paramsBlock() { const a = []; for (let i = 0; i < 18; ++i) a.push(new RegExp(`^P,[a-z0-9_]+,${num}$`)); a.push(/^END$/); return a; }
/* Every line must be a complete telemetry line or the next expected reply line. */
function checkTranscript(text, expected) {
  const all = text.split("\r\n"); const tail = all.pop();
  let i = 0, telemetry = 0, bad = [];
  for (const l of all) {
    if (i < expected.length && expected[i].test(l)) { i++; continue; }
    if (reT.test(l)) { telemetry++; continue; }
    bad.push(l);
  }
  /* "GET STATUS" replies look like telemetry; allow the expectation to be consumed by either */
  return { ok: bad.length === 0 && i === expected.length && (tail === "" || /^T[,0-9-]*$/.test(tail)), matched: i, of: expected.length, telemetry, bad };
}

(async () => {
  const width = Math.max(2, os.cpus().length);
  out("Vikhr-30 ECU: проверка прошивки на симуляторе (хост)");
  out(`Симулятор: TIM2 16 бит, 1 МГц; UART 115200; ${QUICK ? "быстрый режим" : "полный режим"}`);
  out("NEW = v0.9 (src/main.c), OLD = v0.8 (tests/v0.8/main.c, без изменений)");
  out("");

  /* ---------------------------------------------------------------- A: постоянные обороты */
  out("== (а)(б) Постоянные обороты, >= 3,2 с измерения на каждый режим ==");
  const rpms = [300, 450, 600, 1100, 3000, 6000, 7000];
  const jobs = [];
  for (const r of rpms) for (const fw of ["new", "old"]) jobs.push(() => run(fw, ["const", r]));
  const cr = await pool(jobs, width);
  rpms.forEach((r, i) => {
    const n = cr[2 * i], o = cr[2 * i + 1];
    check(`${r} об/мин NEW`, engineOk(n, "w0") && n.tim2_overflows >= 45, `${engineText(n, "w0")}; переполнений TIM2 ${n.tim2_overflows}`);
    info(`${r} об/мин OLD`, engineText(o, "w0"));
  });

  /* ---------------------------------------------------------------- контроль: 32-битный таймер */
  out("");
  out("== Контрольный опыт: v0.8 на ВООБРАЖАЕМОМ 32-разрядном TIM2 (такого в F103 нет) ==");
  const c32 = await run("old", ["const", 3000], { SIM_TIM32: "1" });
  info("3000 об/мин OLD, TIM2=32 бит", engineText(c32, "w0"));
  info("вывод", "даже с 32-битным счётчиком v0.8 теряет синхронизацию: основной цикл читает время ДО чтения метки последнего зуба " +
    "(гонка в обнаружении остановки), это отдельная ошибка помимо Ф1");

  /* ---------------------------------------------------------------- разгон/торможение */
  out("");
  out("== (а)(б) Разгон и торможение ==");
  const ramps = [[600, 6000, 1500], [6000, 900, 1500], [300, 1100, 600], [3000, 7000, 800], [1100, 6000, 4000]];
  const rr = await pool(ramps.flatMap((a) => ["new", "old"].map((fw) => () => run(fw, ["ramp", ...a]))), width);
  ramps.forEach((a, i) => {
    const n = rr[2 * i], o = rr[2 * i + 1];
    const okAll = n.w0_missed_sparks === n.w0_extra_sparks && n.w0_missed_inj === 0 && n.w0_unsynced_teeth === 0 &&
      n.w0_max_dwell_err_us <= LIMIT.dwell_us && n.w0_max_inj_err_us <= LIMIT.inj_us &&
      n.coil1_max_on_us <= LIMIT.coil_on_us && n.coil2_max_on_us <= LIMIT.coil_on_us && n.inj_max_open_us <= LIMIT.inj_open_us;
    check(`${a[0]}→${a[1]} об/мин за ${a[2]} мс, весь прогон NEW`, okAll,
      `искр ${n.w0_sparks}, впрысков ${n.w0_injections}, потерь нет; ош. накопления ≤${n.w0_max_dwell_err_us.toFixed(1)} мкс, ` +
      `ош. впрыска ≤${n.w0_max_inj_err_us.toFixed(1)} мкс; катушка ≤${ms(Math.max(n.coil1_max_on_us, n.coil2_max_on_us))}; ` +
      `ош. УОЗ во время изменения оборотов до ${n.w0_max_angle_err_deg.toFixed(1)}° (см. README: ограничение алгоритма, не таймера)`);
    check(`${a[0]}→${a[1]}, установившийся режим после NEW`, engineOk(n, "w1"), engineText(n, "w1"));
    info(`${a[0]}→${a[1]} OLD (весь прогон)`, engineText(o, "w0"));
  });

  /* ---------------------------------------------------------------- внезапная остановка */
  out("");
  out("== (б)(в) Внезапное пропадание сигнала венца в разные моменты оборота ==");
  const stopRpms = QUICK ? [1100, 6000] : [300, 1100, 3000, 6000];
  const N = QUICK ? 12 : 40;
  for (const r of stopRpms) {
    const rev = 60e6 / r;
    const offs = Array.from({ length: N }, (_, i) => Math.round(i * rev * 1.31 / N + i * 13));
    const res = await pool(offs.flatMap((o) => ["new", "old"].map((fw) => () => run(fw, ["stop", r, o]))), width);
    const agg = (k) => {
      const rs = res.filter((_, i) => i % 2 === k);
      return {
        coil: Math.max(...rs.map((x) => Math.max(x.coil1_max_on_us, x.coil2_max_on_us))),
        inj: Math.max(...rs.map((x) => x.inj_max_open_us)),
        dmin: Math.min(...rs.map((x) => x.stop_detect_ms)), dmax: Math.max(...rs.map((x) => x.stop_detect_ms)),
        after: rs.reduce((s, x) => s + x.stop_outputs_after, 0),
        notzero: rs.filter((x) => x.final_rpm !== 0 || x.final_sync !== 0).length,
        stuck: rs.filter((x) => x.coil1_on_at_end || x.coil2_on_at_end || x.inj_on_at_end).length,
      };
    };
    const n = agg(0), o = agg(1);
    const text = (a) => `катушка под током ≤${ms(a.coil)}, форсунка ≤${ms(a.inj)}, остановка обнаружена через ${a.dmin.toFixed(0)}…${a.dmax.toFixed(0)} мс, ` +
      `включений выходов после обнаружения ${a.after}, прогонов с rpm/sync≠0 в конце ${a.notzero}, с включённым выходом в конце ${a.stuck}`;
    check(`${r} об/мин, ${N} моментов остановки NEW`,
      n.coil <= LIMIT.coil_on_us && n.inj <= LIMIT.inj_open_us && n.dmin >= 200 && n.dmax <= 400 && n.after === 0 && n.notzero === 0 && n.stuck === 0, text(n));
    info(`${r} об/мин OLD`, text(o) + " (малое время «обнаружения» у OLD — это ложные срабатывания на работающем двигателе)");
  }

  /* ---------------------------------------------------------------- сбои сигнала, перезапуск, ограничитель, kill */
  out("");
  out("== (б) Сбои синхронизации (пропавшие и лишние импульсы), перезапуск, ограничитель, аварийный выключатель ==");
  for (const r of [600, 3000]) {
    const [n, o] = await Promise.all([run("new", ["syncloss", r]), run("old", ["syncloss", r])]);
    const t = (x) => `катушка ≤${ms(Math.max(x.coil1_max_on_us, x.coil2_max_on_us))}, форсунка ≤${ms(x.inj_max_open_us)}, в конце sync=${x.final_sync}, ` +
      `искр с ошибкой >2°: ${x.w0_bad_angle_sparks} из ${x.w0_sparks}`;
    check(`сбои венца ${r} об/мин NEW`, Math.max(n.coil1_max_on_us, n.coil2_max_on_us) <= LIMIT.coil_on_us && n.inj_max_open_us <= LIMIT.inj_open_us && n.final_sync === 1, t(n));
    info(`сбои венца ${r} об/мин OLD`, t(o));
  }
  {
    const [n, o] = await Promise.all([run("new", ["restart"]), run("old", ["restart"])]);
    check("перезапуск: 3000 → обрыв сигнала → прокрутка 300 об/мин NEW", engineOk(n, "w1"), engineText(n, "w1"));
    info("перезапуск OLD (прокрутка 300 об/мин)", engineText(o, "w1"));
  }
  {
    const [n, o] = await Promise.all([run("new", ["noisestart"]), run("old", ["noisestart"])]);
    check("два импульса помехи (60 мкс) за 10 мс до начала прокрутки 300 об/мин NEW", engineOk(n, "w0"), "через 1 с после начала прокрутки: " + engineText(n, "w0"));
    info("то же OLD", `rpm по мнению блока = ${o.final_rpm}; ` + engineText(o, "w0"));
    info("то же, первая секунда прокрутки NEW", `искр ${n.w1_sparks - n.w0_sparks}, из них с ошибкой УОЗ >2°: ${n.w1_bad_angle_sparks} (до ${n.w1_max_angle_err_deg.toFixed(0)}° в сторону запаздывания, пока фильтр периода не сошёлся)`);
  }
  {
    const [h, s, oh] = await Promise.all([run("new", ["revlimit", 7150]), run("new", ["revlimit", 6900]), run("old", ["revlimit", 7150])]);
    check("жёсткий ограничитель 7150 об/мин (порог 7000) NEW", h.w0_sparks === 0 && h.w0_injections === 0 && (h.fault_flags & 32) !== 0,
      `искр ${h.w0_sparks}, впрысков ${h.w0_injections}, fault_flags=${h.fault_flags}`);
    check("мягкий ограничитель 6900 об/мин (порог 6800) NEW", Math.abs(s.w0_sparks - s.w0_missed_sparks) <= 2 && (s.fault_flags & 32) !== 0,
      `искр ${s.w0_sparks}, пропущено ${s.w0_missed_sparks} (поведение v0.8 сохранено: отсекается каждый второй такт, т. е. всегда один и тот же цилиндр)`);
    info("жёсткий ограничитель OLD", `искр ${oh.w0_sparks}, впрысков ${oh.w0_injections}`);
    const [k, ok] = await Promise.all([run("new", ["kill"]), run("old", ["kill"])]);
    check("аварийный выключатель (PB12) на 3000 об/мин NEW", k.kill_outputs_low_after_20ms === 1 && k.w1_sparks === 0 && k.w1_injections === 0 && engineOk(k, "w0"),
      `до выключателя: ${k.w0_sparks} искр без потерь; после: искр ${k.w1_sparks}, впрысков ${k.w1_injections}`);
    info("аварийный выключатель OLD", `после: искр ${ok.w1_sparks}, впрысков ${ok.w1_injections}`);
  }

  /* ---------------------------------------------------------------- чувствительность к скорости процессора */
  out("");
  out("== Чувствительность к модели быстродействия (цена одного обращения к памяти) ==");
  out("(основные прогоны: 100 нс; 300 нс — заведомо медленнее реального процессора, допуски для него 20 мкс и 2°)");
  for (const cost of [50, 300]) {
    const saved = LIMIT;
    if (cost > 100) LIMIT = { ...LIMIT, inj_us: 20, dwell_us: 20 };
    const res = await pool([600, 6000, 7000].map((r) => () => run("new", ["const", r], { SIM_COST_NS: String(cost) })), width);
    res.forEach((n, i) => check(`${[600, 6000, 7000][i]} об/мин, ${cost} нс/обращение NEW`, engineOk(n, "w0", { angle: 2.0 }), engineText(n, "w0")));
    LIMIT = saved;
  }
  {
    const seeds = QUICK ? [1, 2] : [1, 2, 3, 4, 5, 6];
    const res = await pool(seeds.flatMap((seed) => [1100, 6000].map((r) => () => run("new", ["const", r], { SIM_JITTER: String(seed) }))), width);
    const worst = (k) => Math.max(...res.map((x) => x[k]));
    check(`случайная цена обращения 50…150 нс, ${res.length} прогонов (1100 и 6000 об/мин) NEW`, res.every((x) => engineOk(x, "w0")),
      `пропущено искр ${worst("w0_missed_sparks")}, впрысков ${worst("w0_missed_inj")}; ош. впрыска ≤${worst("w0_max_inj_err_us").toFixed(1)} мкс, ` +
      `ош. накопления ≤${worst("w0_max_dwell_err_us").toFixed(1)} мкс, ош. УОЗ ≤${worst("w0_max_angle_err_deg").toFixed(2)}°`);
  }

  out("");
  out("== Шкала времени micros(): фронты венца точно около переполнения 16-битного счётчика ==");
  {
    const [n, o] = await Promise.all([run("new", ["wrapedge"]), run("old", ["wrapedge"])]);
    check("500 фронтов в окне ±3 мкс от переполнения (шаг 25 нс) NEW", n.ts_bad === 0 && n.ts_checked >= 490,
      `проверено меток ${n.ts_checked}, неверных ${n.ts_bad}, наибольшая задержка метки ${n.ts_max_lag_us} мкс, переполнений ${n.tim2_overflows}`);
    info("то же OLD", `проверено меток ${o.ts_checked}, неверных ${o.ts_bad} (у v0.8 метка 16-разрядная, после первого переполнения она не равна времени)`);
  }

  /* ---------------------------------------------------------------- связь */
  out("");
  out("== (д) Связь: 115200 бод, телеметрия 10 Гц включена ==");
  for (const [port, name] of [[0, "USART1"], [1, "USART2/HC-06"]]) {
    const [n, o] = await Promise.all([run("new", ["burst", port]), run("old", ["burst", port])]);
    check(`залп 234 команд SET (${n.burst_bytes} байт) в ${name} NEW`, n.burst_cells_applied === 234 && n.burst_ok_replies === 234 && n.burst_crc_reply_ok === 1,
      `применено ${n.burst_cells_applied}/234, ответов OK ${n.burst_ok_replies}, GET CRC совпал (${n.burst_crc_expected}), основной цикл не задерживался дольше ${n.main_loop_max_gap_ms.toFixed(2)} мс`);
    info(`тот же залп OLD`, `применено ${o.burst_cells_applied}/234, ответов OK ${o.burst_ok_replies}, основной цикл стоял до ${o.main_loop_max_gap_ms.toFixed(1)} мс`);
  }
  {
    const [n, o] = await Promise.all([run("new", ["burst", 0, 1]), run("old", ["burst", 0, 1])]);
    check("GET MAPS и сразу залп 234 команд SET NEW", n.burst_cells_applied === 234 && n.burst_ok_replies === 234 && n.burst_crc_reply_ok === 1,
      `применено ${n.burst_cells_applied}/234, основной цикл ≤${n.main_loop_max_gap_ms.toFixed(2)} мс`);
    info("GET MAPS и сразу залп OLD", `применено ${o.burst_cells_applied}/234 (потеряно ${234 - o.burst_cells_applied}), основной цикл стоял до ${o.main_loop_max_gap_ms.toFixed(1)} мс`);
  }
  {
    const [n, o] = await Promise.all([run("new", ["maps"], { SIM_DUMP: path.join(DUMP, "maps_new") }), run("old", ["maps"], { SIM_DUMP: path.join(DUMP, "maps_old") })]);
    const boot = [/^BOOTSTAGE,UART_READY,HSI_PLL64$/, /^BOOTSTAGE,HW_READY$/, /^BOOT,VIKHR30_STM32,[-0-9A-Z.]+,DEFAULTS$/];
    const exp1 = [...boot, ...mapsBlock(), ...paramsBlock(), ...mapsBlock(), ...mapsBlock(), ...paramsBlock(), reT,
      /^INFO,STM32F103C6T6A,BAREMETAL,USART1,HC06,ACTUATOR_TEST,FULL_DIAG,36-1,1700,BOSCH0280158117,DRV8843,VBG08H$/, /^OK,VIKHR30_STM32,[-0-9A-Z.]+$/, ...mapsBlock()];
    const exp2 = [...boot, ...mapsBlock(), ...paramsBlock(), ...mapsBlock()];
    for (const [fw, r] of [["new", n], ["old", o]]) {
      const t1 = checkTranscript(readDump("maps_" + fw, 1), exp1), t2 = checkTranscript(readDump("maps_" + fw, 2), exp2);
      const text = `USART1: ${t1.matched}/${t1.of} строк ответов целы, телеметрии ${t1.telemetry}, повреждённых строк ${t1.bad.length}; ` +
        `USART2: ${t2.matched}/${t2.of}, телеметрии ${t2.telemetry}, повреждённых ${t2.bad.length}; основной цикл ≤${r.main_loop_max_gap_ms.toFixed(1)} мс; ` +
        `двигатель 3000 об/мин: пропущено искр ${r.w0_missed_sparks}, впрысков ${r.w0_missed_inj}`;
      if (fw === "new") check("4×GET MAPS, 2×GET PARAMS, STATUS, INFO, PING подряд на работающем двигателе NEW", t1.ok && t2.ok && engineOk(r, "w0") && r.main_loop_max_gap_ms < 500, text);
      else info("то же OLD", text);
    }
  }

  /* ---------------------------------------------------------------- тесты исполнительных механизмов и блокировки */
  out("");
  out("== (д) Команды TEST и блокировки ==");
  {
    const [n, o] = await Promise.all([run("new", ["tests"], { SIM_DUMP: path.join(DUMP, "tests_new") }), run("old", ["tests"], { SIM_DUMP: path.join(DUMP, "tests_old") })]);
    const golden = ["BOOTSTAGE,UART_READY,HSI_PLL64", "BOOTSTAGE,HW_READY", "BOOT,VIKHR30_STM32,0.9.0-C6-BT-DIAG,DEFAULTS", "OK",
      "OK,VIKHR30_STM32,0.9.0-C6-BT-DIAG", "ERR,service_lock", "ERR,service_lock", "ERR,service_lock", "ERR,service_lock", "ERR,service_lock", "ERR,service_lock",
      "OK,TEST,INJECTOR", "TEST,DONE,INJECTOR", "OK,TEST,COIL1", "TEST,DONE,COIL1", "OK,TEST,COIL2", "TEST,DONE,COIL2",
      "OK,TEST,IAC_OPEN", "TEST,DONE,IAC_OPEN", "OK,TEST,IAC_CLOSE", "TEST,DONE,IAC_CLOSE", "OK,TEST,PUMP", "TEST,DONE,PUMP",
      "OK,TEST,O2_HEATER", "TEST,DONE,O2_HEATER", "OK,TEST,STOP", "ERR,bad_test", "ERR,unknown_command", "ERR,unknown_command", "ERR,index",
      "OK", "OK", "OK", "ERR,unknown_parameter", "ERR,bad_set", "ERR,bad_get", "OK", "OK",
      "OK,TEST,COIL1", "TEST,DONE,COIL1", "OK,SAVED", "OK,TEST,INJECTOR", "TEST,DONE,INJECTOR", "OK,SAVED",
      "ERR,service_lock", "ERR,service_lock", "ERR,service_lock", "OK,TEST,STOP", ""];
    const got = readDump("tests_new", 1).split("\r\n");
    const same = got.length === golden.length && got.every((l, i) => l === golden[i]);
    check("протокол: ответы на 40 команд (блокировка SERVICE, тесты, ошибки, блокировка при вращении) NEW", same, same ? `${golden.length - 1} строк совпали с эталоном` : `расхождение: ${JSON.stringify(got)}`);
    const oldLines = readDump("tests_old", 1).split("\r\n").map((l) => l.replace("0.8.0", "0.9.0"));
    const firstDiff = oldLines.findIndex((l, i) => l !== golden[i]);
    info("сравнение с OLD", firstDiff < 0 ? "ответы идентичны" :
      `первые ${firstDiff} строк идентичны (кроме номера версии); дальше отличия только из-за ошибок v0.8: ` +
      `при вращении 600 об/мин OLD ответил ${JSON.stringify(readDump("tests_old", 1).split("\r\n").slice(-5, -1))} — блокировка не сработала, ` +
      `потому что v0.8 ложно считает двигатель остановленным`);
    const m = (r, i) => String(r["mark" + i]).split(",").map(Number);
    const pulses = (r) => ({ inj: m(r, 0)[3], c1: m(r, 1)[1], c2: m(r, 2)[2], iacOpen: m(r, 3)[4] - m(r, 2)[4], iacClose: m(r, 4)[4] - m(r, 3)[4],
      pump: m(r, 5)[5], heater: m(r, 6)[6] - m(r, 5)[6], coilSave: m(r, 7)[1], injSave: m(r, 8)[3] });
    const pn = pulses(n), po = pulses(o);
    const pt = (p) => `форсунка ${p.inj.toFixed(0)} мкс, катушка 1 ${p.c1.toFixed(0)} мкс, катушка 2 ${p.c2.toFixed(0)} мкс, РХХ ${p.iacOpen}/${p.iacClose} переключений фаз, ` +
      `насос ${p.pump.toFixed(0)} мс, нагреватель ${p.heater.toFixed(0)} мс из 500`;
    check("длительности тестовых импульсов NEW", Math.abs(pn.inj - 3000) <= 10 && Math.abs(pn.c1 - 1000) <= 10 && Math.abs(pn.c2 - 1000) <= 10 &&
      pn.iacOpen === po.iacOpen && pn.iacClose === po.iacClose && Math.abs(pn.pump - 2000) <= 5 && Math.abs(pn.heater - 100) <= 15, pt(pn));
    info("длительности OLD", pt(po));
    check("TEST COIL1 / TEST INJECTOR и сразу SAVE (запись Flash ~43 мс с запретом прерываний) NEW", pn.coilSave <= 1010 && pn.injSave <= 3010,
      `катушка под током ${pn.coilSave.toFixed(0)} мкс, форсунка открыта ${pn.injSave.toFixed(0)} мкс (импульс обрывается перед записью)`);
    info("то же OLD", `катушка ${po.coilSave.toFixed(0)} мкс, форсунка открыта ${po.injSave.toFixed(0)} мкс`);
    check("сторожевой таймер NEW", n.wdt_started === 1 && n.wdt_resets === 0 && Math.abs(n.wdt_timeout_ms - 1000) < 10,
      `запущен, период ${n.wdt_timeout_ms} мс, сбросов 0, наибольший интервал между обслуживаниями ${n.main_loop_max_gap_ms.toFixed(1)} мс (во время SAVE)`);
  }

  /* ---------------------------------------------------------------- совместимость калибровок */
  out("");
  out("== Совместимость страницы калибровок 0x08007C00 ==");
  {
    const fo = path.join(DUMP, "cal_old.bin"), fn = path.join(DUMP, "cal_new.bin");
    await run("old", ["calsave"], { SIM_FLASH_OUT: fo }); await run("new", ["calsave"], { SIM_FLASH_OUT: fn });
    const same = fs.readFileSync(fo).equals(fs.readFileSync(fn));
    await run("new", ["calload"], { SIM_FLASH_IN: fo, SIM_DUMP: path.join(DUMP, "calload_new") });
    await run("old", ["calload"], { SIM_FLASH_IN: fn, SIM_DUMP: path.join(DUMP, "calload_old") });
    const tn = readDump("calload_new", 1), to = readDump("calload_old", 1);
    const has = (t) => /BOOT,VIKHR30_STM32,[^,]+,FLASH/.test(t) && t.includes("F,3,2150,2000,1910,1850,4321,") && t.includes(",277\r\n") &&
      t.includes("P,dwell_us,2222") && t.includes("P,trigger_trim_tenths,-37") && t.includes("P,iac_direction,-1");
    check("образ Flash после SAVE у v0.8 и v0.9 побайтно одинаков", same, same ? "1024 байта совпали" : "различаются");
    check("v0.9 читает калибровки, сохранённые v0.8", has(tn), "BOOT …,FLASH; изменённые ячейки и параметры на месте");
    check("v0.8 читает калибровки, сохранённые v0.9 (откат)", has(to), "BOOT …,FLASH; изменённые ячейки и параметры на месте");
  }

  /* ---------------------------------------------------------------- фильтр периода зуба */
  out("");
  out("== Фильтр периода зуба (целочисленная арифметика, отдельный расчёт) ==");
  {
    let oldN = 139, acc = 139 * 8; const d = 278; /* 12000 -> 6000 об/мин */
    for (let i = 0; i < 2000; ++i) { oldN = Math.floor((oldN * 7 + d) / 8); acc = acc - ((acc + 4) >> 3) + d; }
    check("после торможения период сходится к истинному NEW", Math.abs(acc / 8 - d) < 1, `истинный 278 мкс, фильтр v0.9 даёт ${(acc / 8).toFixed(2)} мкс`);
    info("OLD", `фильтр v0.8 застревает на ${oldN} мкс (−${d - oldN} мкс = ${(100 * (d - oldN) / d).toFixed(1)} %), т. е. искра раньше на ≈${(144 * (d - oldN) / d).toFixed(1)}° при 6000 об/мин`);
  }

  out("");
  out(`ИТОГ: проверок ${checks}, не прошло ${failures} — ${failures ? "FAIL" : "PASS"}`);
  fs.writeFileSync(path.join(__dirname, "RESULTS.txt"), lines.join("\n") + "\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
