// Страница «Схема»: обычная принципиальная схема блока управления по листам, с измерением цепей.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BLOCKS, NETS, probeNet, schemeBom, schemePart, type Probe } from '../core/hardware';
import { load, save, selectNet, setPage, useApp } from '../core/store';
import { PageHead, fmt } from '../ui/kit';
import { ProbePanel, css as netCss, useChecked } from './ProbePanel';
import { LOCAL_NETS, bodyOf, junctions, type El, type Sheet } from './scheme2d/model';
import { SHEETS, homeSheet, sheetHasNet } from './scheme2d/sheets';
import { ElView, svgCss, tagBox, type DrawCtx } from './scheme2d/symbols';
import './Scheme2D.css';

const UNNAMED = '#7d90a5';
/** Цвет цепи на тёмном фоне: тёмные цвета осветляются, «масса» — светло-серая. */
function wireColor(id: string | null): string {
  if (!id) return UNNAMED;
  if (id === 'GND') return '#c3ccd6';
  const local = LOCAL_NETS[id];
  if (local) return local.color;
  const n = NETS.find((x) => x.id === id);
  if (!n) return UNNAMED;
  const [r, g, b] = n.color, lum = 0.2126 * r + 0.7152 * g + 0.0722 * b, t = lum < 0.5 ? (0.5 - lum) / (1 - lum) : 0;
  return netCss([r + (1 - r) * t, g + (1 - g) * t, b + (1 - b) * t]);
}
const netName = (id: string) => NETS.find((n) => n.id === id)?.name ?? LOCAL_NETS[id]?.name ?? id;
const netTitle = (id: string) => NETS.find((n) => n.id === id)?.title ?? LOCAL_NETS[id]?.title ?? '';
const measureId = (id: string) => (NETS.some((n) => n.id === id) ? id : LOCAL_NETS[id]?.measureAs ?? null);
const voltText = (v: number) => fmt(v, Math.abs(v) >= 10 ? 1 : 2) + ' В';
const money = (v: number) => fmt(v, v % 1 ? 1 : 0) + ' ₽';
const BOM_STATUS = { shop: 'есть в магазине', 'shop-unverified': 'в магазине — уточнить', elsewhere: 'заказывать отдельно' } as const;

interface View { s: number; tx: number; ty: number }
type Tip = { x: number; y: number; head: string; text?: string } | null;

function partsOf(sheet: Sheet) {
  const seen = new Set<string>();
  const out: { ref: string; value: string; role: string; verify?: string }[] = [];
  for (const e of sheet.els) {
    if (!e.ref) continue;
    const p = schemePart(e.ref);
    if (!p || seen.has(p.ref)) continue;
    seen.add(p.ref);
    out.push(p);
  }
  const key = (r: string) => r.replace(/\d+/, (d) => d.padStart(3, '0'));
  return out.sort((a, b) => key(a.ref).localeCompare(key(b.ref)));
}

export default function Scheme2DPage() {
  const telemetry = useApp((s) => s.telemetry), live = useApp((s) => s.live), dwell = useApp((s) => s.params.dwell_us), selected = useApp((s) => s.selectedNet);
  const [sheetId, setSheetId] = useState<string>(() => { const id = load('scheme2d.sheet', 'overview'); return SHEETS.some((s) => s.id === id) ? id : 'overview'; });
  const [showV, setShowV] = useState<boolean>(() => load('scheme2d.volts', true));
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null), [tip, setTip] = useState<Tip>(null);
  const [card, setCard] = useState<{ ref: string; x: number; y: number } | null>(null);
  const [listOpen, setListOpen] = useState(false), [localSel, setLocalSel] = useState<string | null>(null);
  const [checked, toggle] = useChecked();
  const host = useRef<HTMLDivElement>(null), svgRef = useRef<SVGSVGElement>(null);
  const wasDrag = useRef(false);
  const auto = useRef(true), drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null), viewRef = useRef(view);
  viewRef.current = view;

  const sheet = SHEETS.find((s) => s.id === sheetId)!;
  const t = live ? telemetry : null;
  const probes = useMemo(() => Object.fromEntries(NETS.map((n) => [n.id, probeNet(n.id, t, dwell)])) as Record<string, Probe>, [t, dwell]);
  const net = NETS.find((n) => n.id === selected) ?? null;
  const done = NETS.filter((n) => checked[n.id]).length;
  const dots = useMemo(() => junctions(sheet), [sheet]);
  const parts = useMemo(() => partsOf(sheet), [sheet]);

  const ctx: DrawCtx = {
    netName,
    volt: (id) => { const m = measureId(id); return showV && m ? voltText(probes[m].volts) : null; },
  };

  const openSheet = (id: string) => { auto.current = true; setSheetId(id); save('scheme2d.sheet', id); setCard(null); setTip(null); setHover(null); };
  const fit = () => {
    auto.current = true;
    if (!size.w || !size.h) return;
    const s = Math.min((size.w - 20) / sheet.w, (size.h - 20) / sheet.h, 2.5);
    setView({ s, tx: (size.w - sheet.w * s) / 2, ty: (size.h - sheet.h * s) / 2 });
  };
  const zoom = (k: number, cx = size.w / 2, cy = size.h / 2) => {
    auto.current = false;
    setView((v) => { const s = Math.max(0.25, Math.min(8, v.s * k)), r = s / v.s; return { s, tx: cx - (cx - v.tx) * r, ty: cy - (cy - v.ty) * r }; });
  };

  // размер области и вписывание
  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (auto.current) fit(); }, [size.w, size.h, sheetId]);

  // колесо — масштаб к курсору
  useEffect(() => {
    const el = host.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [size.w, size.h]);

  // клавиши
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') zoom(1.25);
      else if (e.key === '-' || e.key === '−') zoom(0.8);
      else if (e.key === '0') fit();
      else if (e.key === 'Escape') { setCard(null); setListOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // выбранная цепь: перейти на лист, где она есть
  useEffect(() => {
    if (!selected) { setLocalSel(null); return; }
    if (localSel && LOCAL_NETS[localSel]?.measureAs !== selected) setLocalSel(null);
    if (!sheetHasNet(sheetId, selected)) { const home = homeSheet(selected); if (home) openSheet(home); }
  }, [selected]);

  // печать: лист целиком, чёрным по белому
  useEffect(() => {
    const paper = (on: boolean) => {
      const svg = svgRef.current;
      if (!svg) return;
      const g = svg.querySelector('.s2-sheet')!, st = svg.querySelector('style')!, v = viewRef.current;
      if (on) { svg.setAttribute('viewBox', `0 0 ${sheet.w} ${sheet.h}`); g.setAttribute('transform', ''); st.textContent = svgCss(true); svg.classList.add('paper'); }
      else { svg.removeAttribute('viewBox'); g.setAttribute('transform', `translate(${v.tx} ${v.ty}) scale(${v.s})`); st.textContent = svgCss(false); svg.classList.remove('paper'); }
    };
    const before = () => paper(true), after = () => paper(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, [sheet]);

  const saveSvg = () => {
    const src = svgRef.current?.querySelector('.s2-sheet');
    if (!src) return;
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${sheet.w} ${sheet.h}`);
    svg.setAttribute('width', String(sheet.w));
    svg.setAttribute('height', String(sheet.h));
    const st = document.createElementNS(NS, 'style');
    st.textContent = svgCss(true);
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', String(sheet.w)); bg.setAttribute('height', String(sheet.h)); bg.setAttribute('fill', '#fff');
    const g = src.cloneNode(true) as SVGGElement;
    g.removeAttribute('transform');
    g.querySelectorAll('.s2-hit, .s2-hitbox').forEach((n) => n.remove());
    g.querySelectorAll('[class]').forEach((n) => n.setAttribute('class', (n.getAttribute('class') ?? '').replace(/\b(sel|hov|click)\b/g, '').trim()));
    g.querySelectorAll('[style]').forEach((n) => n.removeAttribute('style'));
    svg.append(st, bg, g);
    const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
    a.download = `vikhr30-shema-${sheet.id}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // перемещение
  const local = (e: { clientX: number; clientY: number }) => { const r = host.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onDown = (e: React.PointerEvent) => { if (e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false }; };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) { d.moved = true; try { host.current!.setPointerCapture(e.pointerId); } catch { /* указатель уже отпущен */ } setTip(null); }
    auto.current = false;
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
  };
  const onUp = () => { const d = drag.current; drag.current = null; wasDrag.current = !!d?.moved; if (d?.moved) setTimeout(() => { wasDrag.current = false; }, 0); };
  const clicked = (fn: (e: React.MouseEvent) => void) => (e: React.MouseEvent) => { e.stopPropagation(); if (!wasDrag.current) fn(e); };

  const pickNet = (id: string | null) => {
    if (!id) return;
    const m = measureId(id);
    setCard(null);
    if (!m) return;
    setLocalSel(m === id ? null : id);
    selectNet(m);
  };
  const netTip = (id: string | null, e: React.MouseEvent) => {
    const p = local(e);
    if (!id) { setTip({ ...p, head: 'Внутренний узел', text: 'Отдельного имени у этого соединения нет.' }); return; }
    const m = measureId(id);
    setTip({ ...p, head: `Цепь ${netName(id)}`, text: netTitle(id) + (m ? ` · ожидается ${voltText(probes[m].volts)}${live ? '' : ' (двигатель стоит)'} · щелчок — измерить` : '') });
  };
  const netProps = (id: string | null) => ({
    onPointerEnter: (e: React.PointerEvent) => { if (!drag.current?.moved) { setHover(id ?? '?'); netTip(id, e); } },
    onPointerMove: (e: React.PointerEvent) => { if (!drag.current?.moved) netTip(id, e); },
    onPointerLeave: () => { setHover(null); setTip(null); },
    onClick: clicked(() => pickNet(id)),
  });
  const isSel = (id: string | null) => !!id && (id === selected ? !localSel : id === localSel);
  const cls = (id: string | null) => 's2-net' + (isSel(id) ? ' sel' : '') + (id && hover === id ? ' hov' : '') + (id && measureId(id) ? ' click' : '');

  const elProps = (e: El) => {
    if (e.k === 'block') {
      const b = BLOCKS.find((x) => x.id === e.block)!;
      return {
        className: 's2-el click',
        onPointerEnter: (ev: React.PointerEvent) => setTip({ ...local(ev), head: b.title, text: b.how + ' Щелчок — открыть лист «' + SHEETS.find((s) => s.id === e.sheet)!.title + '».' }),
        onPointerLeave: () => setTip(null),
        onClick: clicked(() => openSheet(e.sheet)),
      };
    }
    if (!e.ref) return { className: 's2-el' };
    const p = schemePart(e.ref);
    return {
      className: 's2-el click' + (card?.ref === e.ref ? ' sel' : ''),
      onPointerEnter: (ev: React.PointerEvent) => setTip({ ...local(ev), head: `${e.ref} · ${p?.value ?? ''}`, text: (p?.role ?? '') + ' · щелчок — подробнее' }),
      onPointerLeave: () => setTip(null),
      onClick: clicked((ev) => { setTip(null); setCard({ ref: e.ref!, ...local(ev) }); }),
    };
  };

  const cardPart = card ? schemePart(card.ref) : undefined, cardBom = schemeBom(cardPart);
  const place = (x: number, y: number, w: number, h: number) => ({ left: Math.max(6, Math.min(size.w - w - 6, x + 14)), top: Math.max(6, Math.min(size.h - h - 6, y + 14)) });

  return (
    <div className="page fill s2">
      <PageHead title="Схема" sub="Щёлкните провод — что на нём должно быть; щёлкните деталь — что это и где купить">
        <label className="s2-pick">
          <span>Цепь</span>
          <select className="input" value={selected ?? ''} onChange={(e) => { setLocalSel(null); selectNet(e.target.value || null); }} aria-label="Выбрать цепь">
            <option value="">не выбрана</option>
            {NETS.map((n) => <option key={n.id} value={n.id}>{n.name} — {n.title}</option>)}
          </select>
        </label>
      </PageHead>

      <div className="s2-bar">
        <div className="seg s2-tabs" role="tablist" aria-label="Листы схемы">
          {SHEETS.map((s) => <button key={s.id} role="tab" aria-selected={s.id === sheetId} className={s.id === sheetId ? 'active' : ''} onClick={() => openSheet(s.id)}>{s.title}</button>)}
        </div>
        <div className="s2-tools">
          <span className="s2-done muted" title="Отметки общие с 3D-схемой и сохраняются между запусками">Проверено <b className="num">{done}</b> из <b className="num">{NETS.length}</b></span>
          <button className={'btn sm' + (showV ? ' on' : '')} aria-pressed={showV} onClick={() => { setShowV(!showV); save('scheme2d.volts', !showV); }} title="Ожидаемые сейчас напряжения рядом с контрольными точками">Показывать напряжения</button>
          <div className="seg" role="group" aria-label="Масштаб">
            <button onClick={() => zoom(0.8)} aria-label="Уменьшить" title="Уменьшить (клавиша −)">−</button>
            <button onClick={() => zoom(1.25)} aria-label="Увеличить" title="Увеличить (клавиша +)">+</button>
            <button onClick={fit} title="Показать лист целиком (клавиша 0)">Вписать</button>
          </div>
          <button className={'btn sm' + (listOpen ? ' on' : '')} aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>Перечень элементов</button>
          <button className="btn sm" onClick={saveSvg} title="Скачать текущий лист: белый фон, чёрные линии">Сохранить SVG</button>
          <button className="btn sm" onClick={() => window.print()}>Печать листа</button>
        </div>
      </div>

      <div className={'s2-main' + (net ? ' with-panel' : '')}>
        <div className="s2-center">
          <div className="s2-canvas" ref={host} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClick={() => { if (!wasDrag.current) setCard(null); }}>
            <svg ref={svgRef} className={'s2-svg' + (live ? ' live' : '')} role="img" aria-label={`Лист «${sheet.title}»`}>
              <style>{svgCss(false)}</style>
              <g className="s2-sheet" transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
                <rect x={4} y={4} width={sheet.w - 8} height={sheet.h - 8} className="s2-border" />
                <text x={20} y={26} className="s2-h">Вихрь-30 EFI · блок управления · лист {SHEETS.indexOf(sheet) + 1} из {SHEETS.length}: {sheet.title}</text>
                {sheet.els.filter((e) => e.k === 'frame').map((e, i) => <ElView key={'f' + i} e={e} ctx={ctx} />)}
                {sheet.wires.map((w, i) => {
                  const d = 'M' + w.pts.map((p) => p.join(' ')).join('L');
                  return (
                    <g key={'w' + i} className={cls(w.net)} style={{ '--nc': wireColor(w.net) }} {...netProps(w.net)}>
                      <path d={d} className={'s2-wire' + (w.dash ? ' dash' : '')} />
                      <path d={d} className="s2-hit" />
                    </g>
                  );
                })}
                {dots.map((d, i) => <circle key={'d' + i} cx={d.p[0]} cy={d.p[1]} r={2.9} className="s2-dot" style={{ '--nc': wireColor(d.net) }} />)}
                {sheet.els.map((e, i) => {
                  if (e.k === 'frame') return null;
                  if (e.k === 'tag' || e.k === 'pwr' || e.k === 'gnd') {
                    const id = e.k === 'gnd' ? 'GND' : e.net, box = e.k === 'gnd' ? [e.x - 11, e.y - 2, 22, 13] : tagBox(e, ctx);
                    return <g key={i} className={cls(id)} style={{ '--nc': wireColor(id) }} {...netProps(id)}><ElView e={e} ctx={ctx} /><rect x={box[0]} y={box[1]} width={box[2]} height={box[3]} className="s2-hitbox" /></g>;
                  }
                  const body = e.ref || e.k === 'block' ? bodyOf(e) : null;
                  return <g key={i} {...elProps(e)}><ElView e={e} ctx={ctx} />{body && <rect x={body[0]} y={body[1]} width={body[2] - body[0]} height={body[3] - body[1]} className="s2-hitbox" />}</g>;
                })}
                {sheet.notes.map((n, i) => <text key={'n' + i} x={20} y={sheet.h - 12 - (sheet.notes.length - 1 - i) * 15} className="s2-note" style={{ whiteSpace: 'pre' }}>{n}</text>)}
              </g>
            </svg>
            {tip && !card && <div className="s2-tip" style={place(tip.x, tip.y, 300, 70)}><b>{tip.head}</b>{tip.text && <span>{tip.text}</span>}</div>}
            {card && cardPart && (
              <div className="s2-card card" style={place(card.x, card.y, 320, 230)} role="dialog" aria-label={`Элемент ${card.ref}`} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                <div className="s2-card-head"><b className="num">{cardPart.ref}</b><span>{cardPart.value}</span><button className="btn sm ghost" onClick={() => setCard(null)} aria-label="Закрыть карточку">✕</button></div>
                <p>{cardPart.role}.</p>
                <p className="muted">Узел: {BLOCKS.find((b) => b.id === cardPart.block)?.title}</p>
                {cardPart.verify && <p className="s2-verify"><b>Сверить с даташитом.</b> {cardPart.verify}</p>}
                {cardBom
                  ? <p className="s2-buy">{cardBom.url ? <a href={cardBom.url} target="_blank" rel="noopener noreferrer" title="Открыть страницу магазина в новой вкладке">{cardBom.title}</a> : <span>{cardBom.title}</span>}<span className="muted"> — {cardBom.price !== undefined ? money(cardBom.price) + ' за штуку, ' : ''}{BOM_STATUS[cardBom.status]}</span></p>
                  : <p className="muted">В перечне комплектующих отдельной строки нет.</p>}
                {cardBom?.note && <p className="muted">{cardBom.note}</p>}
              </div>
            )}
            {listOpen && (
              <div className="s2-list card flush" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                <div className="s2-list-head"><h2>Перечень элементов листа «{sheet.title}»</h2><span className="muted">{parts.length} поз.</span><button className="btn sm ghost" onClick={() => setListOpen(false)}>Закрыть</button></div>
                <div className="s2-list-body">
                  {parts.length ? (
                    <table className="tbl">
                      <thead><tr><th>Обозначение</th><th>Тип, номинал</th><th>Назначение</th></tr></thead>
                      <tbody>{parts.map((p) => <tr key={p.ref}><td className="num">{p.ref}{p.verify ? '*' : ''}</td><td>{p.value}</td><td>{p.role}{p.verify && <span className="s2-verify"> * {p.verify}</span>}</td></tr>)}</tbody>
                    </table>
                  ) : <div className="empty">На этом листе только блоки — элементы показаны на остальных листах.</div>}
                </div>
              </div>
            )}
          </div>
          <div className="s2-foot">
            <span>Схема составлена по документации и на железе не испытана.</span>
            <span>Колесо — масштаб · перетаскивание — сдвиг · <span className="kbd">+</span> <span className="kbd">−</span> <span className="kbd">0</span></span>
          </div>
        </div>

        {net && (
          <aside className="card sch-panel s2-side" aria-label="Измерение">
            <ProbePanel net={net} probe={probes[net.id]} live={live} checked={!!checked[net.id]} onCheck={() => toggle(net.id)}
              actions={<>
                <button className="btn sm" onClick={() => setPage('scheme')} title="Открыть 3D-схему с этой цепью">Показать в 3D</button>
                <button className="btn sm ghost" onClick={() => { setLocalSel(null); selectNet(null); }}>Закрыть</button>
              </>} />
            {localSel && <p className="muted">Выбран участок «{netName(localSel)}»: {netTitle(localSel)}.</p>}
            <p className="sch-foot">Схема составлена по документации и на железе не испытана — проверяйте каждую цепь на стенде с ограничением тока.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
