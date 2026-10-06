// Условные графические обозначения (в привычном по ГОСТ виде) и отрисовка элементов листа.
import { icH, isK2, isK3, isLoad, type El } from './model';

/** Оценка ширины текста, px (шрифт без засечек). */
export const tw = (s: string, size = 12) => s.length * size * 0.56;

export interface DrawCtx {
  netName: (id: string) => string;
  /** Текст ожидаемого напряжения цепи или null, если напряжения скрыты/неизвестны. */
  volt: (id: string) => string | null;
}

/** Стили схемы: общие для экрана, печати и сохранённого SVG. */
export function svgCss(paper: boolean): string {
  const ink = paper ? '#000' : 'var(--text)', soft = paper ? '#000' : '#aab9c9', faint = paper ? '#333' : 'var(--muted)';
  return `
.s2-sheet text { font-family: Arial, "Segoe UI", sans-serif; font-size: 12px; fill: ${ink}; stroke: none; }
.s2-sym { fill: none; stroke: ${soft}; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.s2-sym.thick { stroke-width: 2.4; }
.s2-solid { fill: ${soft}; stroke: ${soft}; stroke-width: 1; stroke-linejoin: round; }
.s2-body { fill: ${paper ? '#fff' : '#131d28'}; stroke: ${soft}; stroke-width: 1.4; }
.s2-sheet text.s2-ref { font-weight: 700; }
.s2-sheet text.s2-val { font-size: 11.5px; fill: ${faint}; }
.s2-sheet text.s2-pin { font-size: 9.5px; fill: ${faint}; }
.s2-sheet text.s2-pname { font-size: 11px; }
.s2-sheet text.s2-note { font-size: 12px; fill: ${faint}; }
.s2-sheet text.s2-h { font-size: 13.5px; font-weight: 700; }
.s2-sheet text.s2-small { font-size: 11px; fill: ${faint}; }
.s2-sheet .s2-tagname { font-weight: 700; ${paper ? '' : 'fill: var(--nc);'} }
.s2-sheet .s2-volt { font-size: 11.5px; fill: ${paper ? '#000' : 'var(--vc)'}; }
.s2-sheet .s2-desc { font-size: 11.5px; fill: ${faint}; }
.s2-wire { fill: none; stroke: ${paper ? '#000' : 'var(--nc)'}; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.s2-wire.dash, .s2-link { stroke-dasharray: 5 4; }
.s2-link { fill: none; stroke: ${faint}; stroke-width: 1; }
.s2-dot { fill: ${paper ? '#000' : 'var(--nc)'}; stroke: none; }
.s2-netsym { fill: none; stroke: ${paper ? '#000' : 'var(--nc)'}; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.s2-frame { fill: none; stroke: ${paper ? '#777' : '#3a4d61'}; stroke-width: 1; stroke-dasharray: 7 4; }
.s2-border { fill: none; stroke: ${paper ? '#000' : '#3a4d61'}; stroke-width: 1.2; }
.s2-block { fill: ${paper ? '#fff' : '#17212c'}; stroke: ${soft}; stroke-width: 1.4; }
.s2-block.ext { stroke-dasharray: 6 3; }
.s2-hit { fill: none; stroke: transparent; stroke-width: 10; }
.s2-hitbox { fill: transparent; stroke: none; }
`;
}

const P = ({ d, c = 's2-sym' }: { d: string; c?: string }) => <path d={d} className={c} />;

/** Двухвыводной элемент в горизонтальном положении: a слева (−30), b справа (30). */
function Two({ k }: { k: string }) {
  switch (k) {
    case 'R': return <><P d="M-30 0H-20M20 0H30" /><rect x={-20} y={-8} width={40} height={16} className="s2-sym" /></>;
    case 'RT': return <><P d="M-30 0H-20M20 0H30M-17 14H-11L11 -14" /><rect x={-20} y={-8} width={40} height={16} className="s2-sym" /><text x={16} y={-11} className="s2-pin">t°</text></>;
    case 'F': return <><P d="M-30 0H30" /><rect x={-20} y={-6} width={40} height={12} className="s2-sym" /></>;
    case 'C': return <P d="M-30 0H-4M4 0H30M-4 -12V12M4 -12V12" />;
    case 'CP': return <><P d="M-30 0H-4M4 0H30M-4 -12V12M4 -12V12M-17 -9H-11M-14 -12V-6" /></>;
    case 'D': return <><P d="M-30 0H30M9 -9V9" /><path d="M-9 -9V9L9 0Z" className="s2-sym" /></>;
    case 'DS': return <><P d="M-30 0H30M9 -9V9M9 -9H13V-5M9 9H5V5" /><path d="M-9 -9V9L9 0Z" className="s2-sym" /></>;
    case 'DZ': return <><P d="M-30 0H30M9 -9V9M9 -9H4" /><path d="M-9 -9V9L9 0Z" className="s2-sym" /></>;
    case 'L': return <P d="M-30 0H-20a5 5 0 0 1 10 0a5 5 0 0 1 10 0a5 5 0 0 1 10 0a5 5 0 0 1 10 0H30" />;
    case 'SW': return <P d="M-30 0H-11M-11 0L10 -11M11 0H30" />;
    case 'M': return <><P d="M-30 0H-14M14 0H30" /><circle r={14} className="s2-sym" /></>;
    case 'BAT': return <><P d="M-30 0H-3M3 0H30M-3 -12V12M-19 -9H-13M-16 -12V-6" /><P d="M3 -6V6" c="s2-sym thick" /></>;
  }
  return null;
}

function Three({ k }: { k: string }) {
  if (k === 'NMOS')
    return <><circle cx={2} r={19} className="s2-sym" /><P d="M-30 0H-8M-8 -10V10M-2 -14V-6M-2 -4V4M-2 6V14M-2 -10H10V-30M-2 10H10V30M3 0H10V10" /><path d="M-2 0L4 -3V3Z" className="s2-solid" /></>;
  if (k === 'IGBT')
    return <><circle cx={2} r={19} className="s2-sym" /><P d="M-30 0H-9M-9 -10V10M-3 -12V12M-3 -6L10 -14V-30M-3 6L10 14V30" /><path d="M10 14L3.5 13.2L6.5 8.4Z" className="s2-solid" /></>;
  return <><circle cx={2} r={19} className="s2-sym" /><P d="M-30 0H-4M-4 -12V12M-4 -6L10 -15V-30M-4 6L10 15V30" /><path d="M10 15L3.6 14.3L6.6 9.3Z" className="s2-solid" /><P d="M-4 -12V12" c="s2-sym thick" /></>;
}

function Load({ k }: { k: string }) {
  const leads = 'M0 -10H10V-16H24M0 10H10V16H24';
  if (k === 'WIND') return <P d={leads + 'M24 -16a4 4 0 0 1 0 8a4 4 0 0 1 0 8a4 4 0 0 1 0 8a4 4 0 0 1 0 8'} />;
  if (k === 'HEAT') return <><P d={leads} /><rect x={17} y={-16} width={14} height={32} className="s2-sym" /></>;
  if (k === 'KCOIL') return <><P d="M0 -10H14M0 10H14" /><rect x={14} y={-16} width={22} height={32} className="s2-sym" /></>;
  return (
    <>
      <P d={leads + 'M24 -16a4 4 0 0 1 0 8a4 4 0 0 1 0 8a4 4 0 0 1 0 8a4 4 0 0 1 0 8M33 -18V18M36 -18V18'} />
      <P d="M45 -16a4 4 0 0 0 0 8a4 4 0 0 0 0 8a4 4 0 0 0 0 8a4 4 0 0 0 0 8M45 -16V-22H66M45 16V22H52" />
      <path d="M72 -22L65 -25V-19Z" className="s2-solid" />
    </>
  );
}

const star = (e: El) => (e.ref ?? '') + (e.verify ? '*' : '');

function Labels({ x, y, anchor, ref, val, dy = 13 }: { x: number; y: number; anchor: string; ref: string; val?: string; dy?: number }) {
  return <>{ref && <text x={x} y={y} textAnchor={anchor} className="s2-ref">{ref}</text>}{val && <text x={x} y={y + (ref ? dy : 0)} textAnchor={anchor} className="s2-val">{val}</text>}</>;
}

export function ElView({ e, ctx }: { e: El; ctx: DrawCtx }) {
  if (isK2(e)) {
    const vert = e.rot % 2 === 1, lp = e.lp ?? (vert ? 'r' : 'tb');
    const half = e.k === 'C' || e.k === 'CP' || e.k === 'BAT' || e.k === 'M' ? 16 : 13;
    let lab;
    if (vert) lab = <Labels x={lp === 'l' ? e.x - half - 2 : e.x + half + 2} y={e.y + (e.val ? -2 : 4)} anchor={lp === 'l' ? 'end' : 'start'} ref={star(e)} val={e.val} />;
    else if (lp === 't1' || lp === 'b1') lab = <text x={e.x} y={e.y + (lp === 't1' ? -13 : 22)} textAnchor="middle"><tspan className="s2-ref" fontWeight={700}>{star(e)}</tspan><tspan className="s2-val" dx={5}>{e.val}</tspan></text>;
    else if (lp === 't') lab = <Labels x={e.x} y={e.y - 26} anchor="middle" ref={star(e)} val={e.val} />;
    else if (lp === 'b') lab = <Labels x={e.x} y={e.y + 22} anchor="middle" ref={star(e)} val={e.val} dy={12} />;
    else lab = <><text x={e.x} y={e.y - 13} textAnchor="middle" className="s2-ref">{star(e)}</text>{e.val && <text x={e.x} y={e.y + 22} textAnchor="middle" className="s2-val">{e.val}</text>}</>;
    const pn = e.pn && (vert
      ? <><text x={e.x - 5} y={e.y + (e.rot === 1 ? -22 : 28)} textAnchor="end" className="s2-pin">{e.pn[0]}</text><text x={e.x - 5} y={e.y + (e.rot === 1 ? 28 : -22)} textAnchor="end" className="s2-pin">{e.pn[1]}</text></>
      : <><text x={e.x + (e.rot === 0 ? -25 : 25)} y={e.y - 4} textAnchor="middle" className="s2-pin">{e.pn[0]}</text><text x={e.x + (e.rot === 0 ? 25 : -25)} y={e.y - 4} textAnchor="middle" className="s2-pin">{e.pn[1]}</text></>);
    return <><g transform={`translate(${e.x} ${e.y}) rotate(${e.rot * 90})`}><Two k={e.k} />{e.k === 'M' && <text y={4} textAnchor="middle" transform={`rotate(${-e.rot * 90})`} className="s2-ref">M</text>}</g>{lab}{pn}</>;
  }
  if (isK3(e)) {
    const f = e.flip ? -1 : 1, lp = e.lp ?? (e.flip ? 'l' : 'r'), right = lp === 'r';
    const lx = f === 1 ? (right ? e.x + 25 : e.x - 14) : (right ? e.x + 14 : e.x - 25), ly = (f === 1) === right ? e.y - 2 : e.y - 24;
    return (
      <>
        <g transform={`translate(${e.x} ${e.y}) scale(${f} 1)`}><Three k={e.k} /></g>
        <Labels x={lx} y={ly} anchor={right ? 'start' : 'end'} ref={star(e)} val={e.val} dy={12} />
        {e.pn && <><text x={e.x - 24 * f} y={e.y + 10} textAnchor="middle" className="s2-pin">{e.pn[0]}</text><text x={e.x + 5 * f} y={e.y - 22} textAnchor={f === 1 ? 'end' : 'start'} className="s2-pin">{e.pn[1]}</text><text x={e.x + 5 * f} y={e.y + 28} textAnchor={f === 1 ? 'end' : 'start'} className="s2-pin">{e.pn[2]}</text></>}
      </>
    );
  }
  if (isLoad(e)) {
    const lx = e.x + (e.k === 'IGN' ? 12 : 44);
    return (
      <>
        <g transform={`translate(${e.x} ${e.y})`}><Load k={e.k} /></g>
        {e.k === 'IGN'
          ? <><text x={lx} y={e.y + 40} className="s2-ref">{star(e)}</text><text x={lx + tw(star(e)) + 6} y={e.y + 40} className="s2-val">{e.val}</text><text x={e.x + 76} y={e.y - 18} className="s2-small">{e.note}</text></>
          : <><text x={lx} y={e.y - (e.note ? 8 : 2)} className="s2-ref">{star(e)}</text><text x={lx} y={e.y + (e.note ? 4 : 10)} className="s2-val">{e.val}</text>{e.note && <text x={lx} y={e.y + 16} className="s2-small">{e.note}</text>}</>}
      </>
    );
  }
  switch (e.k) {
    case 'POT': {
      const f = e.flip ? -1 : 1;
      return (
        <>
          <g transform={`translate(${e.x} ${e.y}) scale(${f} 1)`}><P d="M0 -20V-14M0 14V20M20 0H10" /><rect x={-7} y={-14} width={14} height={28} className="s2-sym" /><path d="M7 0L13 -3V3Z" className="s2-solid" /></g>
          <text x={e.x - f * 11} y={e.y - 24} textAnchor="middle" className="s2-ref">{star(e)}</text>
        </>
      );
    }
    case 'ic': {
      const h = icH(e);
      return (
        <>
          <rect x={e.x} y={e.y} width={e.w} height={h} className="s2-body" />
          <text x={e.x} y={e.y - 6}><tspan className="s2-ref" fontWeight={700}>{star(e)}</tspan><tspan className="s2-val" dx={6}>{e.val}</tspan></text>
          {e.left.map((p, i) => p && <g key={'l' + i}><path d={`M${e.x - 20} ${e.y + 20 + 20 * i}H${e.x}`} className="s2-sym" />{p.num && <text x={e.x - 4} y={e.y + 16 + 20 * i} textAnchor="end" className="s2-pin">{p.num}</text>}<text x={e.x + 5} y={e.y + 23.5 + 20 * i} className="s2-pname">{p.name}</text></g>)}
          {e.right.map((p, i) => p && <g key={'r' + i}><path d={`M${e.x + e.w} ${e.y + 20 + 20 * i}H${e.x + e.w + 20}`} className="s2-sym" />{p.num && <text x={e.x + e.w + 4} y={e.y + 16 + 20 * i} className="s2-pin">{p.num}</text>}<text x={e.x + e.w - 5} y={e.y + 23.5 + 20 * i} textAnchor="end" className="s2-pname">{p.name}</text></g>)}
        </>
      );
    }
    case 'conn':
      return (
        <>
          <rect x={e.x} y={e.y} width={e.w} height={20 * e.rows.length} className="s2-body" />
          <path d={`M${e.x + 15} ${e.y}V${e.y + 20 * e.rows.length}` + e.rows.slice(1).map((_, i) => `M${e.x} ${e.y + 20 * (i + 1)}H${e.x + e.w}`).join('')} className="s2-sym" style={{ strokeWidth: 0.8 }} />
          <text x={e.x + e.w / 2} y={e.y - 6} textAnchor="middle" className="s2-ref">{star(e)}</text>
          {e.rows.map((r, i) => <g key={i}><text x={e.x + 7.5} y={e.y + 13.5 + 20 * i} textAnchor="middle" className="s2-pin">{i + 1}</text><text x={e.x + 19} y={e.y + 13.5 + 20 * i} className="s2-pname">{r}</text></g>)}
        </>
      );
    case 'pwr': {
      const v = e.v ? ctx.volt(e.net) : null, name = ctx.netName(e.net);
      return (
        <>
          <path d={`M${e.x} ${e.y}V${e.y - 13}M${e.x - 4.5} ${e.y - 7.5}L${e.x} ${e.y - 14}L${e.x + 4.5} ${e.y - 7.5}`} className="s2-netsym" />
          {e.lbl
            ? <text x={e.x + (e.lbl === 'r' ? 8 : -8)} y={e.y - 8} textAnchor={e.lbl === 'r' ? 'start' : 'end'}><tspan className="s2-tagname">{name}</tspan>{v && <tspan className="s2-volt" dx={5}>{v}</tspan>}</text>
            : <><text x={e.x} y={e.y - 18} textAnchor="middle"><tspan className="s2-tagname">{name}</tspan></text>{v && <text x={e.x} y={e.y - 30} textAnchor="middle" className="s2-volt">{v}</text>}</>}
        </>
      );
    }
    case 'gnd':
      return <><path d={`M${e.x} ${e.y}V${e.y + 6}`} className="s2-netsym" /><path d={`M${e.x - 9} ${e.y + 6}H${e.x + 9}`} className="s2-netsym" style={{ strokeWidth: 2.6 }} /></>;
    case 'tag': {
      const name = e.text ?? ctx.netName(e.net), v = e.v ? ctx.volt(e.net) : null;
      const horiz = e.side === 'l' || e.side === 'r', d = e.side === 'r' ? 1 : -1;
      const x = horiz ? e.x + d * 11 : e.x, y = horiz ? e.y + 4 : e.side === 't' ? e.y - 6 : e.y + 15;
      const anchor = e.anchor ?? (e.side === 'r' ? 'start' : e.side === 'l' ? 'end' : 'middle');
      return (
        <>
          {horiz && !e.plain && <path d={`M${e.x} ${e.y - 4.5}L${e.x + d * 6} ${e.y}L${e.x} ${e.y + 4.5}Z`} className="s2-netsym" />}
          <text x={x} y={y} textAnchor={anchor}>
            <tspan className="s2-tagname">{name}</tspan>
            {v && <tspan className="s2-volt" dx={5}>{v}</tspan>}
            {e.desc && <tspan className="s2-desc" dx={6}>{e.desc}</tspan>}
          </text>
        </>
      );
    }
    case 'nc':
      return <><path d={`M${e.x - 3.5} ${e.y - 3.5}L${e.x + 3.5} ${e.y + 3.5}M${e.x - 3.5} ${e.y + 3.5}L${e.x + 3.5} ${e.y - 3.5}`} className="s2-sym" />{e.text && <text x={e.x + (e.side === 'l' ? -11 : 11)} y={e.y + 4} textAnchor={e.side === 'l' ? 'end' : 'start'} className="s2-desc">{e.text}</text>}</>;
    case 'text':
      return <text x={e.x} y={e.y} textAnchor={e.anchor ?? 'start'} className={e.cls ?? 's2-note'}>{e.text}</text>;
    case 'frame':
      return <><rect x={e.x} y={e.y} width={e.w} height={e.h} rx={4} className="s2-frame" /><text x={e.x + 8} y={e.y + 15} className="s2-h">{e.title}</text></>;
    case 'block':
      return (
        <>
          <rect x={e.x} y={e.y} width={e.w} height={e.h} rx={5} className={'s2-block' + (e.ext ? ' ext' : '')} />
          <text x={e.x + e.w / 2} y={e.y + e.h / 2 + (e.sub ? -2 : 4)} textAnchor="middle" className="s2-ref">{e.title}</text>
          {e.sub && <text x={e.x + e.w / 2} y={e.y + e.h / 2 + 11} textAnchor="middle" className="s2-val">{e.sub}</text>}
        </>
      );
    case 'line':
      return <path d={`M${e.x} ${e.y}L${e.to[0]} ${e.to[1]}`} className="s2-link" />;
  }
  return null;
}

/** Прямоугольник для наведения и щелчка по подписи цепи: [x, y, w, h]. */
export function tagBox(e: Extract<El, { k: 'tag' | 'pwr' }>, ctx: DrawCtx): [number, number, number, number] {
  if (e.k === 'pwr') {
    const w = tw(ctx.netName(e.net)) + 8;
    return e.lbl ? [e.lbl === 'r' ? e.x - 6 : e.x - w - 6, e.y - 20, w + 12, 22] : [e.x - w / 2, e.y - 30, w, 32];
  }
  const v = e.v ? ctx.volt(e.net) : null;
  const w = tw(e.text ?? ctx.netName(e.net)) + (v ? tw(v, 11.5) + 5 : 0) + 6;
  const horiz = e.side === 'l' || e.side === 'r', anchor = e.anchor ?? (e.side === 'r' ? 'start' : e.side === 'l' ? 'end' : 'middle');
  const x0 = horiz ? e.x + (e.side === 'r' ? 0 : -w - 11) : anchor === 'start' ? e.x - 3 : anchor === 'end' ? e.x - w : e.x - w / 2;
  const y0 = horiz ? e.y - 8 : e.side === 't' ? e.y - 17 : e.y + 4;
  return [x0, y0, w + (horiz ? 11 : 3), 16];
}
