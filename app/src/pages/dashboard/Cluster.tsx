// Вид «Щиток»: векторная приборная панель.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { fuelFlowMlMin } from '../../core/calc';
import { clearFaults, useApp } from '../../core/store';
import { FAULTS, type Telemetry } from '../../core/types';
import { DASH, fmt } from '../../ui/kit';
import { advanceTone, chtTone, dutyTone, mapTone, mixture, rpmTone, tpsTone, vbatTone, CHT_COLD, CHT_HOT, TONE_COLOR, type Ctx, type Tone } from './metrics';

const NODATA = 'var(--nodata)';
const W = 1160, H = 440;
const TACH = { cx: 222, cy: 222, r: 190, max: 8000 };
const TEMP = { cx: 978, cy: 228, r: 160, max: 120 };
const SWEEP0 = -135, SWEEP = 270;

/** Угол стрелки в градусах от вертикали по часовой: 0 шкалы = −135°, конец шкалы = +135°. */
export const gaugeAngle = (v: number, max: number) => SWEEP0 + (Math.max(0, Math.min(max, v)) / max) * SWEEP;
const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
};
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 < 0.01) return '';
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Стрелка: угол догоняет цель в requestAnimationFrame, чтобы 10 Гц данных не давали рывков. */
function Needle({ cx, cy, r0, r1, angle, animate, color }: { cx: number; cy: number; r0: number; r1: number; angle: number; animate: boolean; color: string }) {
  const ref = useRef<SVGGElement>(null);
  const cur = useRef(angle), target = useRef(angle), raf = useRef(0);
  const apply = () => ref.current?.setAttribute('transform', `rotate(${cur.current.toFixed(2)} ${cx} ${cy})`);
  useLayoutEffect(apply, []);
  useEffect(() => {
    target.current = angle;
    if (!animate || reducedMotion()) {
      if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
      cur.current = angle; apply();
      return;
    }
    if (raf.current) return; // цикл уже идёт и сам подхватит новую цель
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const d = target.current - cur.current;
      if (Math.abs(d) < 0.05) { cur.current = target.current; apply(); raf.current = 0; return; }
      cur.current += d * (1 - Math.exp(-dt / 0.085));
      apply();
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [angle, animate]);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0; }, []);
  return (
    <g ref={ref} className="dash-needle" data-target={angle.toFixed(2)}>
      <line x1={cx} y1={cy - r0} x2={cx} y2={cy - r1} stroke={color} strokeWidth={9} strokeLinecap="round" opacity={0.22} filter="url(#dash-glow)" />
      <line x1={cx} y1={cy - r0} x2={cx} y2={cy - r1} stroke={color} strokeWidth={3.2} strokeLinecap="round" />
    </g>
  );
}

function Ticks({ g, major, mid, minor, label, labelR, fontSize }: { g: typeof TACH; major: number; mid: number; minor: number; label: (v: number) => string; labelR: number; fontSize: number }) {
  const lines: React.ReactNode[] = [], texts: React.ReactNode[] = [];
  for (let v = 0; v <= g.max + 1e-6; v += minor) {
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6, isMid = Math.abs(v / mid - Math.round(v / mid)) < 1e-6;
    const a = gaugeAngle(v, g.max), len = isMajor ? 17 : isMid ? 11 : 6;
    const [x0, y0] = polar(g.cx, g.cy, g.r - 9, a), [x1, y1] = polar(g.cx, g.cy, g.r - 9 - len, a);
    lines.push(<line key={v} x1={x0} y1={y0} x2={x1} y2={y1} stroke={isMajor ? 'var(--text)' : 'var(--faint)'} strokeWidth={isMajor ? 2 : 1} opacity={isMajor ? 0.9 : 0.75} />);
    if (isMajor) {
      const [tx, ty] = polar(g.cx, g.cy, labelR, a);
      texts.push(<text key={'t' + v} className="num dash-scale-num" data-v={v} x={tx} y={ty} fontSize={fontSize} textAnchor="middle" dominantBaseline="central">{label(v)}</text>);
    }
  }
  return <g>{lines}{texts}</g>;
}

function Tile({ x, y, w, h, label, value, unit, sub, color, small }: { x: number; y: number; w: number; h: number; label: string; value: string; unit?: string; sub?: string; color: string; small?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={9} className="dash-tile" />
      <text x={x + 12} y={y + 20} className="dash-tile-label">{label}</text>
      {sub && <text x={x + w - 12} y={y + 20} textAnchor="end" className="num dash-tile-sub">{sub}</text>}
      <text x={x + 12} y={y + h - 13} className="num dash-tile-value" fontSize={small ? 21 : 26} fill={color}>
        {value}{unit && <tspan className="dash-tile-unit" dx={5}>{unit}</tspan>}
      </text>
    </g>
  );
}

interface LampDef { label: string; on: boolean; tone: 'ok' | 'warn' | 'danger' | 'accent'; title: string }

export function Cluster() {
  const t = useApp((s) => s.telemetry);
  const live = useApp((s) => s.live);
  const status = useApp((s) => s.status);
  const params = useApp((s) => s.ecuParams);
  const limits = useApp((s) => s.params); // зоны шкалы — по параметрам в программе, как на вкладке «Параметры»
  const ecuIgn = useApp((s) => s.ecuIgn);
  const mapsLoaded = useApp((s) => s.mapsLoaded);
  const d: Telemetry | null = live ? t : null;
  const ctx: Ctx = { params, ecuIgn, mapsLoaded };
  const rpmCtx: Ctx = { ...ctx, params: limits };
  const col = (tone: Tone | 'nodata' | undefined) => (!d || tone === 'nodata' ? NODATA : tone ? TONE_COLOR[tone] : 'var(--text)');
  const val = (f: (t: Telemetry) => string) => (d ? f(d) : DASH);

  // зоны тахометра берутся из параметров ECU и перестраиваются при их изменении
  const soft = Math.min(TACH.max, limits.rev_limit_soft), hard = Math.min(TACH.max, Math.max(soft, limits.rev_limit_hard));
  const aSoft = gaugeAngle(soft, TACH.max), aHard = gaugeAngle(hard, TACH.max), aEnd = SWEEP0 + SWEEP;
  const peak = d ? Math.min(TACH.max, d.peak) : 0;
  const [pk0x, pk0y] = polar(TACH.cx, TACH.cy, TACH.r + 5, gaugeAngle(peak, TACH.max));
  const mix = d ? mixture(d) : null;
  const flow = d ? fuelFlowMlMin(d.duty10) : 0;
  const duty = d ? Math.max(0, Math.min(1000, d.duty10)) / 1000 : 0;

  const DX = 440, DW = 350, TW = (DW - 8) / 2, TH = 62;
  const tiles = [
    { label: 'ДАВЛЕНИЕ MAP', value: val((x) => fmt(x.map10 / 10, 1)), unit: 'кПа', color: col(d ? mapTone(d) : undefined) },
    { label: 'ДРОССЕЛЬ', value: val((x) => fmt(x.tps10 / 10, 1)), unit: '%', color: col(d ? tpsTone(d, ctx) : undefined) },
    { label: 'СМЕСЬ', value: mix ? mix.text : DASH, sub: mix?.sub, color: col(mix?.tone), small: !!mix && mix.text.length > 8 },
    { label: 'БОРТСЕТЬ', value: val((x) => fmt(x.batteryMv / 1000, 2)), unit: 'В', color: col(d ? vbatTone(d) : undefined) },
    { label: 'УОЗ', value: val((x) => fmt(x.advance10 / 10, 1)), unit: '° до ВМТ', color: col(d ? advanceTone(d, ctx) : undefined) },
    { label: 'ВПРЫСК', value: val((x) => fmt(x.pwUs / 1000, 2)), unit: 'мс', color: col(d ? dutyTone(d) : undefined) },
  ];

  const flags = d ? d.flags : 0;
  const lamps: LampDef[] = [
    { label: 'Синхронизация', on: !!d?.sync, tone: 'ok', title: 'ECU распознал венец 36-1 и знает положение коленвала' },
    { label: 'Связь', on: live || status === 'lost', tone: status === 'lost' ? 'danger' : 'ok', title: status === 'lost' ? 'ECU перестал отвечать' : 'Телеметрия приходит' },
    { label: 'SERVICE', on: !!d?.service, tone: 'accent', title: 'Перемычка SERVICE: разрешены запись и тесты' },
    { label: 'STOP', on: !!d?.kill, tone: 'danger', title: 'Аварийная чека: искра и топливо отключены' },
    { label: 'Отсечка', on: !!(flags & 32), tone: 'warn', title: 'Сработало ограничение оборотов' },
    { label: 'Перегрев', on: !!(flags & 16), tone: 'danger', title: 'Головка горячее 85 °C' },
    { label: 'Отсечка топлива', on: !!d?.fuelCut, tone: 'warn', title: 'Подача топлива сейчас отключена' },
    { label: 'Насос', on: !!d && !!(d.outputMask & 8), tone: 'ok', title: 'Реле бензонасоса включено' },
    { label: 'Нагрев λ', on: !!d && d.heater > 0, tone: 'accent', title: d && d.heater > 0 ? `Нагреватель лямбда-зонда: ${d.heater} %` : 'Нагреватель лямбда-зонда выключен' },
  ];
  const faults = FAULTS.filter((f) => flags & (1 << f.bit));
  const rpmColor = d ? (TONE_COLOR[rpmTone(d, rpmCtx)]) : NODATA;
  const zoneOp = d ? 1 : 0.35;

  return (
    <div className="dash-cluster-view">
      <div className="dash-cluster">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img"
          aria-label={d ? `Обороты ${d.rpm} в минуту, температура головки ${fmt(d.cht10 / 10, 0)} градусов` : 'Приборы: нет данных от ECU'}>
          <defs>
            <filter id="dash-glow" x="-300%" y="-50%" width="700%" height="200%"><feGaussianBlur stdDeviation="5" /></filter>
            <radialGradient id="dash-face" cx="50%" cy="42%" r="62%">
              <stop offset="0" stopColor="#16212d" /><stop offset="1" stopColor="#0c131b" />
            </radialGradient>
          </defs>

          {/* тахометр */}
          <g id="dash-tach">
            <circle cx={TACH.cx} cy={TACH.cy} r={TACH.r + 14} fill="url(#dash-face)" stroke="var(--line)" />
            <path d={arc(TACH.cx, TACH.cy, TACH.r, SWEEP0, aEnd)} className="dash-arc-track" />
            <g opacity={zoneOp} fill="none" strokeWidth={6}>
              <path d={arc(TACH.cx, TACH.cy, TACH.r, SWEEP0, aSoft)} stroke="var(--accent)" opacity={0.6} />
              <path id="dash-zone-soft" d={arc(TACH.cx, TACH.cy, TACH.r, aSoft, aHard)} stroke="var(--warn)" />
              <path id="dash-zone-hard" d={arc(TACH.cx, TACH.cy, TACH.r, aHard, aEnd)} stroke="var(--danger)" />
            </g>
            <Ticks g={TACH} major={1000} mid={500} minor={100} label={(v) => String(v / 1000)} labelR={TACH.r - 44} fontSize={23} />
            {d && peak > 0 && (
              <g id="dash-peak" transform={`translate(${pk0x.toFixed(2)} ${pk0y.toFixed(2)}) rotate(${gaugeAngle(peak, TACH.max).toFixed(2)})`}>
                <path d="M0 0L-5.5 -9H5.5Z" fill="var(--text)" opacity={0.85} />
              </g>
            )}
            <Needle cx={TACH.cx} cy={TACH.cy} r0={96} r1={TACH.r - 12} angle={gaugeAngle(d ? d.rpm : 0, TACH.max)} animate={!!d} color={d ? 'var(--accent)' : NODATA} />
            <circle cx={TACH.cx} cy={TACH.cy} r={90} className="dash-hub" />
            <text id="dash-rpm" x={TACH.cx} y={TACH.cy + 12} textAnchor="middle" className="num dash-big" fontSize={56} fill={rpmColor}>{d ? d.rpm : DASH}</text>
            <text x={TACH.cx} y={TACH.cy + 38} textAnchor="middle" className="dash-unit">об/мин</text>
            <text x={TACH.cx} y={TACH.cy - 46} textAnchor="middle" className="dash-unit">× 1000</text>
            <text x={TACH.cx} y={TACH.cy + 64} textAnchor="middle" className="num dash-sub" fill={d ? 'var(--muted)' : NODATA}>пик {d ? d.peak : DASH}</text>
            <text x={TACH.cx} y={TACH.cy + 158} textAnchor="middle" className="dash-unit">отсечка</text>
            <text x={TACH.cx} y={TACH.cy + 178} textAnchor="middle" className="num dash-sub">
              <tspan fill="var(--warn)">{limits.rev_limit_soft}</tspan><tspan fill="var(--faint)"> / </tspan><tspan fill="var(--danger)">{limits.rev_limit_hard}</tspan>
            </text>
          </g>

          {/* дисплей */}
          <g id="dash-display">
            {tiles.map((tl, i) => <Tile key={tl.label} x={DX + (i % 2) * (TW + 8)} y={16 + Math.floor(i / 2) * (TH + 8)} w={TW} h={TH} {...tl} />)}
            <g>
              <rect x={DX} y={226} width={DW} height={62} rx={9} className="dash-tile" />
              <text x={DX + 12} y={246} className="dash-tile-label">РАСХОД ТОПЛИВА</text>
              <text x={DX + 12} y={275} className="num dash-tile-value" fontSize={26} fill={col(d ? dutyTone(d) : undefined)}>
                {d ? fmt(flow, 1) : DASH}<tspan className="dash-tile-unit" dx={5}>мл/мин</tspan>
              </text>
              <text x={DX + DW - 12} y={275} textAnchor="end" className="num dash-tile-value" fontSize={21} fill={d ? 'var(--text)' : NODATA}>
                {d ? fmt(flow * 0.06, 2) : DASH}<tspan className="dash-tile-unit" dx={5}>л/ч</tspan>
              </text>
            </g>
            <g>
              <rect x={DX} y={296} width={DW} height={66} rx={9} className="dash-tile" />
              <text x={DX + 12} y={316} className="dash-tile-label">ЗАГРУЗКА ФОРСУНКИ</text>
              <text x={DX + DW - 12} y={320} textAnchor="end" className="num dash-tile-value" fontSize={21} fill={col(d ? dutyTone(d) : undefined)}>
                {d ? fmt(d.duty10 / 10, 1) : DASH}<tspan className="dash-tile-unit" dx={5}>%</tspan>
              </text>
              <rect x={DX + 12} y={334} width={DW - 24} height={10} rx={5} fill="var(--panel-3)" />
              {d && duty > 0 && <rect x={DX + 12} y={334} width={Math.max(10, (DW - 24) * duty)} height={10} rx={5} fill={TONE_COLOR[dutyTone(d)]} />}
              {[0.75, 0.85].map((p) => <line key={p} x1={DX + 12 + (DW - 24) * p} x2={DX + 12 + (DW - 24) * p} y1={331} y2={347} stroke={p > 0.8 ? 'var(--danger)' : 'var(--warn)'} strokeWidth={1.5} opacity={0.8} />)}
              <text x={DX + 12 + (DW - 24) * 0.75} y={357} textAnchor="middle" className="num dash-tick-label">75</text>
              <text x={DX + 12 + (DW - 24) * 0.85} y={357} textAnchor="middle" className="num dash-tick-label">85</text>
            </g>
            <g>
              <rect x={DX} y={370} width={DW} height={54} rx={9} className="dash-tile" />
              <text x={DX + 12} y={392} className="dash-tile-label">РХХ, ШАГ</text>
              <text x={DX + 12} y={411} className="dash-tile-sub">позиция → цель</text>
              <text x={DX + DW - 12} y={406} textAnchor="end" className="num dash-tile-value" fontSize={26} fill={d ? 'var(--text)' : NODATA}>
                {d ? `${d.iacPos} → ${d.iacTarget}` : DASH}
              </text>
            </g>
          </g>

          {/* температура головки */}
          <g id="dash-temp">
            <circle cx={TEMP.cx} cy={TEMP.cy} r={TEMP.r + 14} fill="url(#dash-face)" stroke="var(--line)" />
            <path d={arc(TEMP.cx, TEMP.cy, TEMP.r, SWEEP0, aEnd)} className="dash-arc-track" />
            <g opacity={zoneOp} fill="none" strokeWidth={6}>
              <path d={arc(TEMP.cx, TEMP.cy, TEMP.r, SWEEP0, gaugeAngle(CHT_COLD, TEMP.max))} stroke="var(--info)" />
              <path d={arc(TEMP.cx, TEMP.cy, TEMP.r, gaugeAngle(CHT_COLD, TEMP.max), gaugeAngle(CHT_HOT, TEMP.max))} stroke="var(--ok)" />
              <path d={arc(TEMP.cx, TEMP.cy, TEMP.r, gaugeAngle(CHT_HOT, TEMP.max), aEnd)} stroke="var(--danger)" />
            </g>
            <Ticks g={TEMP} major={20} mid={10} minor={5} label={(v) => String(v)} labelR={TEMP.r - 42} fontSize={18} />
            <Needle cx={TEMP.cx} cy={TEMP.cy} r0={82} r1={TEMP.r - 12} angle={gaugeAngle(d ? d.cht10 / 10 : 0, TEMP.max)} animate={!!d}
              color={d ? TONE_COLOR[chtTone(d)] : NODATA} />
            <circle cx={TEMP.cx} cy={TEMP.cy} r={76} className="dash-hub" />
            <text x={TEMP.cx} y={TEMP.cy - 34} textAnchor="middle" className="dash-unit">ГОЛОВКА, °C</text>
            <text id="dash-cht" x={TEMP.cx} y={TEMP.cy + 12} textAnchor="middle" className="num dash-big" fontSize={44} fill={d ? TONE_COLOR[chtTone(d)] : NODATA}>{d ? fmt(d.cht10 / 10, 1) : DASH}</text>
            <text x={TEMP.cx} y={TEMP.cy + 40} textAnchor="middle" className="dash-unit">воздух</text>
            <text x={TEMP.cx} y={TEMP.cy + 60} textAnchor="middle" className="num dash-sub" fill={d ? 'var(--text)' : NODATA}>{d ? fmt(d.iat10 / 10, 1) : DASH} °C</text>
          </g>
        </svg>
        {!d && (
          <div className="dash-nolink" role="status">
            {status === 'lost' ? 'Связь с ECU потеряна — показания остановлены, ждём ответа блока'
              : status === 'opening' || status === 'waiting' ? 'Подключение к ECU…'
              : 'Нет данных от ECU — нажмите «Подключить ECU» или «Демо»'}
          </div>
        )}
      </div>

      <ul className="dash-lamps" aria-label="Контрольные лампы">
        {lamps.map((l) => (
          <li key={l.label} className={'dash-lamp ' + (l.on ? 'on ' + l.tone : '')} title={l.title}>
            <i aria-hidden="true" />{l.label}<span className="dash-sr">{l.on ? ' — горит' : ' — не горит'}</span>
          </li>
        ))}
      </ul>

      <section className="card dash-faults" aria-label="Ошибки">
        <div className="dash-faults-head">
          <h3>Ошибки</h3>
          {d && faults.length > 0 && <span className="tag warn num">{faults.length}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn sm" disabled={!d} title={d ? 'Сбросить флаги ошибок и пик оборотов в ECU' : 'ECU не подключён'} onClick={() => { void clearFaults(); }}>Сбросить ошибки</button>
        </div>
        {!d ? <p className="nodata">Нет данных от ECU</p>
          : faults.length === 0 ? <p className="ok">Ошибок нет</p>
          : (
            <ul className="dash-fault-list">
              {faults.map((f) => (
                <li key={f.code} className={f.bit === 4 || f.bit === 9 ? 'danger' : ''}>
                  <b>{f.title}</b><span>{f.hint}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
