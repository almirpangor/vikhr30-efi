// Извлечение списка цепей на уровне выводов из модели листов принципиальной схемы.
// Запуск: NODE_PATH=/opt/npm-tools/node_modules /opt/npm-tools/node_modules/.bin/tsx pcb/netlist.ts
import { writeFileSync } from 'node:fs';
import { SHEETS } from '../src/pages/scheme2d/sheets';
import { pinsOf, isK2, isK3, isLoad, type Pt, type El } from '../src/pages/scheme2d/model';
import { NETS, BOM, SCHEME_PARTS, schemePart, schemeBom } from '../src/core/hardware';

const OUT = '/home/claude/vikhr30/pcb';
/** Элементы вне платы: вместо них разъёмы/клеммы. */
const OFFBOARD = new Set(['GB1', 'RP1', 'B1', 'B2', 'B3', 'RT1', 'RT2', 'S1', 'S2', 'T1', 'T2', 'Y1', 'K1', 'M1', 'M2', 'A3', 'A4', 'F1', 'F2']);
const base = (r: string) => r.replace(/\.\d+$/, '');
const log: string[] = [];
const eq = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
const onSeg = (p: Pt, a: Pt, b: Pt) => a[0] === b[0] ? p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]) : p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]);

/** Имена выводов элемента в том же порядке, что pinsOf(). Может вернуть несколько номеров на точку (U3 «4…7»). */
function pinNames(e: El): string[][] {
  if (isK2(e)) {
    if (e.k === 'D' || e.k === 'DS' || e.k === 'DZ') return [['A'], ['K']];
    if (e.k === 'CP') return [['+'], ['-']];
    return [['1'], ['2']];
  }
  if (isK3(e)) return (e.pn ?? ['G', 'D', 'S']).map((n) => [n]);
  if (isLoad(e)) return [['1'], ['2']];
  if (e.k === 'POT') return [['1'], ['2'], ['3']];
  if (e.k === 'ic') {
    const nm = (p: { num?: string; name: string }, side: string) => {
      if (e.ref === 'A1') return [(p.num!.startsWith('S') ? 'SWD' + p.num!.slice(1) : (side === 'l' ? 'JL' : 'JR') + p.num) + ':' + p.name];
      if (!p.num) return [p.name];
      const m = p.num.match(/^(\d+)…(\d+)$/);
      if (m) return Array.from({ length: +m[2] - +m[1] + 1 }, (_, i) => String(+m[1] + i) + ':' + p.name);
      return [p.num + ':' + p.name];
    };
    return [...e.left.filter(Boolean).map((p) => nm(p!, 'l')), ...e.right.filter(Boolean).map((p) => nm(p!, 'r'))];
  }
  if (e.k === 'conn') return e.rows.flatMap((r, i) => [[`${i + 1}:${r}`], [`${i + 1}:${r}`]]);
  return [];
}

interface Grp { sheet: string; wireNets: Set<string>; tags: Set<string>; pins: { ref: string; pin: string }[]; nc: boolean }
const groups: Grp[] = [];
const ncPins: string[] = [];

for (const sh of SHEETS) {
  if (sh.id === 'overview') continue;
  const parent = new Map<string, string>();
  const find = (k: string): string => { const p = parent.get(k) ?? k; if (p === k) return k; const r = find(p); parent.set(k, r); return r; };
  const uni = (a: string, b: string) => { parent.set(find(a), find(b)); };
  const segs: { a: Pt; b: Pt; wi: number }[] = [];
  sh.wires.forEach((w, wi) => { for (let i = 1; i < w.pts.length; i++) if (!eq(w.pts[i - 1], w.pts[i])) segs.push({ a: w.pts[i - 1], b: w.pts[i], wi }); });
  // провода: общие точки концов на отрезках
  sh.wires.forEach((w, wi) => { for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) { uni('w' + wi, 'p' + p); for (const s of segs) if (s.wi !== wi && onSeg(p, s.a, s.b)) uni('w' + wi, 'w' + s.wi); } });
  const ncs = sh.els.filter((e) => e.k === 'nc').map((e) => [e.x, e.y] as Pt);
  interface PinRec { key: string; ref?: string; names: string[]; tag?: string }
  const recs: PinRec[] = [];
  for (const e of sh.els) {
    if (e.k === 'nc') continue;
    const pts = pinsOf(e), names = pinNames(e);
    pts.forEach((p, i) => {
      const key = 'p' + p;
      for (const s of segs) if (onSeg(p, s.a, s.b)) uni(key, 'w' + s.wi);
      if (e.k === 'gnd') recs.push({ key, names: [], tag: 'GND' });
      else if (e.k === 'pwr') recs.push({ key, names: [], tag: e.net });
      else if (e.k === 'tag') recs.push({ key, names: [], tag: e.net === 'IAC_IN' ? e.text! : e.net });
      else if (e.ref) recs.push({ key, ref: e.ref, names: names[i] });
    });
    // разъём: левая и правая точки одной строки — один контакт
    if (e.k === 'conn') for (let i = 0; i < pts.length; i += 2) uni('p' + pts[i], 'p' + pts[i + 1]);
  }
  const map = new Map<string, Grp>();
  const get = (k: string) => { const r = find(k); if (!map.has(r)) map.set(r, { sheet: sh.id, wireNets: new Set(), tags: new Set(), pins: [], nc: false }); return map.get(r)!; };
  sh.wires.forEach((w, wi) => { if (w.net) get('w' + wi).wireNets.add(w.net); else get('w' + wi); });
  for (const r of recs) {
    const g = get(r.key);
    if (r.tag) g.tags.add(r.tag);
    else for (const n of r.names) if (!g.pins.some((q) => q.ref === r.ref && q.pin === n)) g.pins.push({ ref: r.ref!, pin: n });
  }
  for (const p of ncs) { const g = get('p' + p); g.nc = true; }
  for (const g of map.values()) {
    if (g.tags.size > 1) throw new Error(`${sh.id}: в одной группе несколько меток: ${[...g.tags]}`);
    groups.push(g);
  }
}

// ── имена цепей: глобальные — по меткам (tag/pwr/gnd); остальные — локальные
const tagNames = new Set(groups.flatMap((g) => [...g.tags]));
const localCount = new Map<string, number>();
for (const g of groups) if (!g.tags.size) for (const n of g.wireNets) localCount.set(g.sheet + '/' + n, (localCount.get(g.sheet + '/' + n) ?? 0) + 1);
const nets = new Map<string, { pins: { ref: string; pin: string }[]; src: string[] }>();
const addTo = (name: string, g: Grp, why: string) => { if (!nets.has(name)) nets.set(name, { pins: [], src: [] }); const n = nets.get(name)!; n.pins.push(...g.pins); n.src.push(`${g.sheet}:${why}`); };
for (const g of groups) {
  if (g.nc && !g.tags.size && !g.wireNets.size) { for (const p of g.pins) ncPins.push(`${p.ref}.${p.pin}`); continue; }
  if (g.tags.size) { addTo([...g.tags][0], g, 'метка'); continue; }
  const wn = [...g.wireNets][0] as string | undefined;
  const conn = g.pins.find((p) => /^X\d+$/.test(p.ref)), anyIc = g.pins.find((p) => /^[AU]\d+$/.test(p.ref)), first = [...g.pins].sort((a, b) => (a.ref + a.pin).localeCompare(b.ref + b.pin))[0];
  let name: string;
  if (!wn) name = `N_${first.ref.replace('.', '_')}_${first.pin.split(':')[0]}`;
  else if (tagNames.has(wn) || nets.has(wn) && !tagNames.has(wn) && (localCount.get(g.sheet + '/' + wn) ?? 0) > 1 || (localCount.get(g.sheet + '/' + wn) ?? 0) > 1) {
    // цвет провода совпадает с именем другой цепи (участок до защитного резистора и т. п.) — отдельная цепь
    const k = conn ?? anyIc ?? first;
    name = wn === 'IAC_OUT' && conn ? `IAC_${conn.pin.split(':')[1]}` : `${wn}_${k.ref}`;
    log.push(`Участок с цветом цепи «${wn}» без метки на листе ${g.sheet} (${g.pins.map((p) => p.ref + '.' + p.pin).join(', ')}) — отдельная цепь ${name}`);
  } else name = wn;
  if (nets.has(name)) throw new Error('повтор локального имени ' + name);
  addTo(name, g, 'локальная');
}

// ── элементы
interface Comp { ref: string; value: string; pkg: string; onboard: boolean; bom?: string; url?: string; pins: Record<string, string> }
const comps = new Map<string, Comp>();
const PKG: [RegExp, string][] = [
  [/^R\d/, 'R_AXIAL_10.16'], [/^C(1)$/, 'CP_D8_P3.5'], [/^C(2|16|17)$/, 'CP_D6.3_P2.5'], [/^C\d/, 'C_DISC_5.08'],
  [/^D1$/, 'DO-201AD_15.24'], [/^D2$/, 'DO-218AB'], [/^D[345]$/, 'DO-41_10.16'], [/^D(6|7|8|9|11)$/, 'SOT-23'],
  [/^Q[12]$/, 'TO-263-2'], [/^Q[3456]$/, 'SOT-23'], [/^Q[78]$/, 'TO-220_V'], [/^Q9$/, 'TO-92'],
  [/^U3$/, 'SO-20W'], [/^L1$/, 'CDRH125'], [/^A1$/, 'BLUEPILL_2x20'], [/^A2$/, 'HDR_1x6'], [/^A5$/, 'LM2596_MODULE'],
  [/^X(2|3|7)$/, 'JST_XH_3'], [/^X(4|5|6|8|9)$/, 'JST_XH_2'], [/^X15$/, 'TERM_5.08_4'], [/^X16$/, 'JST_XH_4'], [/^X(F?\d+)$/, 'TERM_5.08_2'],
];
const pkgOf = (ref: string) => PKG.find(([re]) => re.test(ref))?.[1] ?? '?';
const comp = (ref: string): Comp => {
  if (!comps.has(ref)) {
    const sp = schemePart(ref), b = schemeBom(sp);
    comps.set(ref, { ref, value: sp?.value ?? '', pkg: pkgOf(ref), onboard: !OFFBOARD.has(ref), bom: b?.title, url: b?.url, pins: {} });
  }
  return comps.get(ref)!;
};
const netOfPin = new Map<string, string>();
const BAR = /^D(6|7|8|9|11)\.[12]$/;
for (const [name, n] of nets) {
  for (const p of n.pins) {
    let ref = base(p.ref), pin = p.pin;
    if (BAR.test(p.ref)) { // BAR43S: .1 — нижний диод (анод=выв.1, катод=выв.3), .2 — верхний (анод=выв.3, катод=выв.2)
      const sec = p.ref.endsWith('.1') ? 1 : 2;
      pin = sec === 1 ? (p.pin === 'A' ? '1' : '3') : (p.pin === 'A' ? '3' : '2');
    } else if (/^[DC]\d/.test(ref)) pin = ({ A: '2', K: '1', '+': '1', '-': '2' } as Record<string, string>)[pin] ?? pin;
    else if (p.ref !== ref) { ref = p.ref; }            // K1.1, M2.1, B3.1 — секции внешних устройств
    const c = comp(ref.includes('.') ? base(ref) : ref);
    const key = (p.ref !== base(p.ref) && !BAR.test(p.ref) ? p.ref.split('.')[1] + '/' : '') + pin;
    if (c.pins[key] && c.pins[key] !== name) throw new Error(`${c.ref}.${key}: цепи ${c.pins[key]} и ${name}`);
    c.pins[key] = name;
  }
}
for (const q of ncPins) { const [r, ...rest] = q.split('.'); comp(base(r)).pins[rest.join('.')] = '(NC)'; }

// ── преобразования «схема → плата»
const dec: string[] = [];
// F1, F2: держатели вне платы → клеммы XF1, XF2
for (const f of ['F1', 'F2']) {
  const c = comps.get(f)!;
  comps.set('X' + f, { ref: 'X' + f, value: `Клеммник 2 конт. к держателю ${f} (${c.value})`, pkg: 'TERM_5.08_2', onboard: true, bom: 'Клеммник разъёмный 5,08 мм 2 контакта', pins: { '1': c.pins['1'], '2': c.pins['2'] } });
  dec.push(`${f}: держатель ножевого предохранителя вне платы; на плате клеммник X${f}: 1 → ${c.pins['1']}, 2 → ${c.pins['2']}.`);
}
// A3: USB-UART вне платы → X16 (JST XH 4)
{ const a = comps.get('A3')!; const g = (k: string) => Object.entries(a.pins).find(([n]) => n.endsWith(k))?.[1] ?? '(NC)';
  comps.set('X16', { ref: 'X16', value: 'JST XH 4 конт. (USB-UART A3)', pkg: 'JST_XH_4', onboard: true, bom: 'Набор разъёмов JST XH 2,54 (2–5 контактов)', pins: { '1': g('GND'), '2': g('RXD'), '3': g('TXD'), '4': '(NC)' } });
  dec.push(`A3 (USB-UART) на плату не ставится: разъём X16 JST XH 4 конт.: 1 GND, 2 → RXD адаптера (${g('RXD')}), 3 ← TXD адаптера (${g('TXD')}), 4 не подключён (3V3 адаптера).`); }
// A2: гнездо 1×6 в порядке выводов модуля HC-06
{ const a = comps.get('A2')!; const p = a.pins;
  a.pins = { '1': p['STATE'], '2': p['RXD'], '3': p['TXD'], '4': p['GND'], '5': p['VCC'], '6': '(NC)' };
  dec.push('A2 (HC-06): гнездо 1×6, порядок как на модуле: 1 STATE, 2 RXD, 3 TXD, 4 GND, 5 VCC, 6 EN (не подключён).'); }
// A1: контакты SWD — на самой плате Blue Pill, на нашу плату не выводятся
{ const a = comps.get('A1')!; const np: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.pins)) { if (k.startsWith('SWD')) continue; np[k.split(':')[0]] = v; }
  a.pins = np; dec.push('A1: контакты SWD (S1…S4) находятся на торце самой Blue Pill и на плату не выводятся; A4 (ST-Link) подключается прямо к ним. Цепи SWDIO/SWCLK на плате отсутствуют.'); }
// микросхемы: «номер:имя» → номер
for (const c of comps.values()) if (/^(U\d|X\d+|A5)$/.test(c.ref) && !['X16', 'XF1', 'XF2'].includes(c.ref)) {
  const np: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.pins)) np[c.ref === 'A5' ? ({ 'IN+': '1', 'IN−': '2', 'OUT+': '3', 'OUT−': '4' } as Record<string, string>)[k] : k.split(':')[0]] = v;
  c.pins = np;
}

// ── итоговый список цепей по элементам на плате
const board = [...comps.values()].filter((c) => c.onboard);
const boardNets = new Map<string, string[]>();
for (const c of board) for (const [pin, net] of Object.entries(c.pins)) { if (net === '(NC)') continue; if (!boardNets.has(net)) boardNets.set(net, []); boardNets.get(net)!.push(`${c.ref}.${pin}`); }
const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

// ── проверки
const problems: string[] = [];
for (const [n, pins] of boardNets) if (pins.length < 2) problems.push(`цепь ${n} с одним выводом на плате: ${pins}`);
const EXPECT: Record<string, number> = { R_AXIAL: 2, C_DISC: 2, CP_D8: 2, 'CP_D6.3': 2, 'DO-': 2, 'SOT-23': 3, 'TO-263': 3, 'TO-220': 3, 'TO-92': 3, 'SO-20W': 20, CDRH125: 2, BLUEPILL: 40, HDR_1x6: 6, LM2596: 4, JST_XH_3: 3, JST_XH_2: 2, JST_XH_4: 4, 'TERM_5.08_4': 4, 'TERM_5.08_2': 2 };
for (const c of board) {
  if (c.pkg === '?') problems.push(`${c.ref}: не задан корпус`);
  const want = Object.entries(EXPECT).find(([k]) => c.pkg.startsWith(k))?.[1];
  const have = Object.keys(c.pins).length;
  if (want !== undefined && have !== want) problems.push(`${c.ref} (${c.pkg}): выводов ${have}, ожидалось ${want}: ${Object.keys(c.pins)}`);
}
const refs = new Set([...comps.keys()]);
for (const p of SCHEME_PARTS) if (!refs.has(p.ref)) problems.push(`элемент ${p.ref} из SCHEME_PARTS не найден на листах`);
// двухвыводной элемент с обоими выводами в одной цепи
for (const c of board) { const v = Object.values(c.pins).filter((x) => x !== '(NC)'); if (v.length === 2 && v[0] === v[1]) problems.push(`${c.ref}: оба вывода в цепи ${v[0]}`); }

const title = (n: string) => NETS.find((x) => x.id === n)?.name ?? ({ F2: '+12V_F2' } as Record<string, string>)[n] ?? n;
const json = {
  generated: 'pcb/netlist.ts из src/pages/scheme2d/sheets.ts',
  components: board.sort((a, b) => natural(a.ref, b.ref)).map((c) => ({ ref: c.ref, value: c.value, pkg: c.pkg, bom: c.bom ?? null, url: c.url ?? null, pins: c.pins })),
  offboard: [...comps.values()].filter((c) => !c.onboard).map((c) => ({ ref: c.ref, value: c.value, pins: c.pins })),
  nets: [...boardNets.entries()].sort((a, b) => natural(a[0], b[0])).map(([id, pins]) => ({ id, name: title(id), pins: pins.sort(natural) })),
  decisions: dec, notes: log, problems,
};
writeFileSync(OUT + '/netlist.json', JSON.stringify(json, null, 1));
const L: string[] = [];
L.push('СПИСОК ЦЕПЕЙ ПЛАТЫ «VIKHR-30 EFI rev A» — получен программно из листов схемы (pcb/netlist.ts)', '');
L.push(`Элементов на плате: ${board.length}; цепей: ${boardNets.size}; выводов в цепях: ${[...boardNets.values()].reduce((a, p) => a + p.length, 0)}`, '');
L.push('ЭЛЕМЕНТЫ НА ПЛАТЕ (обозначение | номинал | корпус | вывод=цепь)');
for (const c of json.components) L.push(`${c.ref.padEnd(5)} ${c.value.padEnd(28)} ${c.pkg.padEnd(16)} ${Object.entries(c.pins).sort((a, b) => natural(a[0], b[0])).map(([p, n]) => `${p}=${n}`).join(' ')}`);
L.push('', 'ЦЕПИ (имя | название | выводы)');
for (const n of json.nets) L.push(`${n.id.padEnd(12)} ${n.name.padEnd(11)} ${n.pins.join(' ')}`);
L.push('', 'ВНЕ ПЛАТЫ (подключаются через разъёмы)');
for (const c of json.offboard) L.push(`${c.ref.padEnd(5)} ${c.value.padEnd(30)} ${Object.entries(c.pins).map(([p, n]) => `${p}=${n}`).join(' ')}`);
L.push('', 'ПРЕОБРАЗОВАНИЯ «СХЕМА → ПЛАТА»', ...dec.map((d) => ' - ' + d));
L.push('', 'ЗАМЕЧАНИЯ ПРИ ИЗВЛЕЧЕНИИ', ...log.map((d) => ' - ' + d));
L.push('', 'ПРОВЕРКА', ...(problems.length ? problems.map((p) => ' ! ' + p) : [' Замечаний нет: каждый вывод каждого элемента на плате имеет цепь или явно свободен; цепей с одним выводом нет; все элементы SCHEME_PARTS найдены.']));
writeFileSync(OUT + '/netlist.txt', L.join('\n') + '\n');
console.log(L.join('\n'));
