#!/usr/bin/env node
/* Static checks of the linked image.  Usage: verify_image.cjs release/<name> <llvm-bin-dir> */
"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");
const base = process.argv[2], llvm = process.argv[3] || "/usr/lib/llvm-18/bin";
const bin = fs.readFileSync(base + ".bin");
const report = []; let failed = 0;
function check(name, ok, detail) { if (!ok) failed++; const s = `[${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`; report.push(s); console.log(s); }
const hex32 = (v) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");

/* symbols */
const sym = {};
for (const l of execFileSync(llvm + "/llvm-nm", [base + ".elf"], { encoding: "utf8" }).split("\n")) {
  const m = l.match(/^([0-9a-f]+) (\w) (\S+)$/); if (m) sym[m[3]] = { addr: parseInt(m[1], 16), type: m[2] };
}
const undef = execFileSync(llvm + "/llvm-nm", ["-u", base + ".elf"], { encoding: "utf8" }).trim();
check("неразрешённые символы", undef === "", undef === "" ? "нет" : undef);

/* vector table */
const vec = (i) => bin.readUInt32LE(4 * i);
check("начальный SP", vec(0) === 0x20002800, hex32(vec(0)));
check("вектор сброса", vec(1) === (sym.Reset_Handler.addr | 1), `${hex32(vec(1))} = Reset_Handler ${hex32(sym.Reset_Handler.addr)} + бит Thumb`);
const expected = { 15: "SysTick_Handler", [16 + 23]: "EXTI9_5_IRQHandler", [16 + 28]: "TIM2_IRQHandler", [16 + 37]: "USART1_IRQHandler", [16 + 38]: "USART2_IRQHandler" };
for (const [i, name] of Object.entries(expected)) {
  const ok = sym[name] && sym[name].type === "T" && vec(+i) === (sym[name].addr | 1);
  check(`вектор ${i}${+i >= 16 ? ` (IRQ ${i - 16})` : ""} = ${name}`, ok, `${hex32(vec(+i))}, функция по адресу ${sym[name] ? hex32(sym[name].addr) : "?"}`);
}
let other = true; const def = sym.Default_Handler.addr | 1; const strays = [];
for (let i = 2; i < 59; ++i) if (!(i in expected)) { const v = vec(i); if (v !== 0 && v !== def) { other = false; strays.push(i); } }
check("остальные векторы", other, other ? "Default_Handler или 0" : "неожиданные: " + strays.join(","));
const ends = sym.vector_table ? sym.vector_table.addr : -1;
check("таблица векторов в начале Flash", ends === 0x08000000, hex32(ends));

/* sizes */
const limit = 0x7C00;
check("размер образа", bin.length <= limit, `${bin.length} байт (${(bin.length / 1024).toFixed(2)} КБ) из ${limit}; свободно ${limit - bin.length}; страница калибровок 0x08007C00 не затронута`);
const ram = sym._ebss.addr - 0x20000000, stack = 0x20002800 - sym._ebss.addr;
check("ОЗУ", ram + 2048 <= 10240, `.data+.bss = ${ram} байт, под стек остаётся ${stack} байт из 10240`);
const sizeText = execFileSync(llvm + "/llvm-size", ["-A", base + ".elf"], { encoding: "utf8" });
const sec = (n) => { const m = sizeText.match(new RegExp("^\\" + n + "\\s+(\\d+)\\s+(\\d+)", "m")); return m ? { size: +m[1], addr: +m[2] } : { size: 0, addr: 0 }; };
check("секции", sec(".isr_vector").addr === 0x08000000 && sec(".isr_vector").size === 236 && sec(".data").addr === 0x20000000,
  `.isr_vector ${sec(".isr_vector").size}, .text ${sec(".text").size}, .data ${sec(".data").size}, .bss ${sec(".bss").size}`);

/* version string */
check("строка версии", bin.includes(Buffer.from("0.9.0-C6-BT-DIAG")), "0.9.0-C6-BT-DIAG присутствует в образе");

/* Intel HEX -> bytes, compare with BIN */
const mem = new Map(); let upper = 0, eof = false, hexOk = true, start = null;
for (const line of fs.readFileSync(base + ".hex", "latin1").split(/\r?\n/)) {
  if (!line) continue;
  if (line[0] !== ":") { hexOk = false; break; }
  const b = Buffer.from(line.slice(1), "hex");
  if (b.reduce((a, x) => (a + x) & 0xFF, 0) !== 0 || b[0] !== b.length - 5) { hexOk = false; break; }
  const addr = b.readUInt16BE(1), type = b[3], data = b.subarray(4, b.length - 1);
  if (type === 0) data.forEach((v, i) => mem.set(upper + addr + i, v));
  else if (type === 4) upper = data.readUInt16BE(0) * 65536;
  else if (type === 5 || type === 3) start = data.readUInt32BE(0);
  else if (type === 1) eof = true;
  else hexOk = false;
}
let same = hexOk && eof && mem.size === bin.length;
if (same) for (let i = 0; i < bin.length; ++i) if (mem.get(0x08000000 + i) !== bin[i]) { same = false; break; }
const addrs = [...mem.keys()]; const lo = Math.min(...addrs), hi = Math.max(...addrs);
check("HEX = BIN", same, `${mem.size} байт данных, адреса ${hex32(lo)}…${hex32(hi)}, контрольные суммы записей верны, побайтно совпадает с BIN` +
  (start !== null ? `, запись точки входа ${hex32(start)}` : ""));
check("HEX не трогает страницу калибровок", hi < 0x08007C00, `последний адрес ${hex32(hi)} < 0x08007C00`);

fs.writeFileSync(base + ".verify.txt", report.join("\n") + "\n");
process.exit(failed ? 1 : 0);
