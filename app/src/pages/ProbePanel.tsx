// Общая панель измерения цепи: мультиметр, осциллограф, ввод своего измерения, отметка «проверено».
// Используется на страницах «Схема» и «3D-схема».
import { useEffect, useState, type ReactNode } from 'react';
import type { NetDef, Probe, Waveform } from '../core/hardware';
import { load, save } from '../core/store';
import { fmt } from '../ui/kit';
import './ProbePanel.css';

export const css = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(Math.min(1, v * 1.05) * 255)).join(',')})`;
export const volts = (v: number, d = 2) => fmt(v, d) + ' В';
const isFlat = (w: Waveform | null) => !w || w.points.every((p) => Math.abs(p[1] - w.points[0][1]) < 1e-6);

/** Отметки «цепь проверена» — общие для обеих схем, хранятся между запусками. */
export function useChecked(): [Record<string, boolean>, (id: string) => void] {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => load('scheme.checked', {}));
  const toggle = (id: string) => setChecked((c) => { const n = { ...c, [id]: !c[id] }; save('scheme.checked', n); return n; });
  return [checked, toggle];
}

/** Экран осциллографа: 10×8 делений, 2–3 периода сигнала, подписи уровней и времени. */
function Scope({ wave }: { wave: Waveform }) {
  const W = 400, H = 320, flat = isFlat(wave);
  let lo = Math.min(wave.vMin, 0), hi = wave.vMax;
  for (const p of wave.points) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  // «красивая» цена деления по вертикали
  const raw = (hi - lo) / 7.2, pow = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const bottom = lo < 0 ? -4 * step : 0;
  const Y = (v: number) => H - Math.max(0, Math.min(1, (v - bottom) / (8 * step))) * H;
  const periods = flat ? 1 : wave.points.length > 12 ? 2 : 3, total = wave.periodMs * periods;
  const X = (t: number) => (t / total) * W;
  const pts: string[] = [];
  for (let k = 0; k < periods; k++) for (const [t, v] of wave.points) pts.push(`${X(t + k * wave.periodMs).toFixed(1)},${Y(v).toFixed(1)}`);
  const perDiv = total / 10, micro = perDiv < 1;
  const tLabel = (ms: number) => (micro ? fmt(ms * 1000, 0) : fmt(ms, ms < 10 && ms % 1 ? 1 : 0));
  const vDigits = step < 1 ? 1 : 0;
  return (
    <div className="sch-scope">
      <div className="sch-scope-screen">
      <div className="sch-scope-y num" aria-hidden="true">
        {[8, 6, 4, 2, 0].map((d) => <span key={d} style={{ top: `${(1 - d / 8) * 100}%` }}>{fmt(bottom + d * step, vDigits)}</span>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={'Осциллограмма: ' + wave.caption}>
        <rect width={W} height={H} fill="#06120f" />
        {Array.from({ length: 11 }, (_, i) => <line key={'v' + i} x1={i * 40} x2={i * 40} y1={0} y2={H} className={i === 5 ? 'axis' : 'grid'} />)}
        {Array.from({ length: 9 }, (_, i) => <line key={'h' + i} y1={i * 40} y2={i * 40} x1={0} x2={W} className={i === 4 ? 'axis' : 'grid'} />)}
        <line x1={0} x2={W} y1={Y(0)} y2={Y(0)} className="zero" />
        <polyline points={pts.join(' ')} className="trace" vectorEffect="non-scaling-stroke" />
      </svg>
      </div>
      <div className="sch-scope-x num" aria-hidden="true">
        {flat ? <span style={{ left: '50%' }}>время</span> : [0, 2, 4, 6, 8, 10].map((d) => <span key={d} style={{ left: `${d * 10}%` }}>{tLabel(d * perDiv)}</span>)}
      </div>
      <div className="sch-scope-units">
        <span>по вертикали — В, {fmt(step, vDigits)} В/дел</span>
        {!flat && <span>по горизонтали — {micro ? 'мкс' : 'мс'}, {micro ? fmt(perDiv * 1000, 0) + ' мкс' : fmt(perDiv, perDiv < 10 ? 2 : 0) + ' мс'}/дел</span>}
      </div>
    </div>
  );
}

export function ProbePanel({ net, probe, live, checked, onCheck, actions }: { net: NetDef; probe: Probe; live: boolean; checked: boolean; onCheck: () => void; actions?: ReactNode }) {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [net.id]);
  const dc = isFlat(probe.wave);
  const value = Number(text.trim().replace(',', '.').replace('−', '-')), has = text.trim() !== '', valid = has && Number.isFinite(value);
  const tol = Math.max(0.15, Math.abs(probe.volts) * 0.1);
  const inRange = valid && value >= probe.lo && value <= probe.hi, near = !dc || (probe.levels ?? [probe.volts]).some((lv) => Math.abs(value - lv) <= Math.max(0.15, Math.abs(lv) * 0.1));
  const ok = inRange && near;
  return (
    <>
      {probe.danger && <div className="banner danger" role="alert"><b>Опасно.</b><span>{probe.danger}</span></div>}
      {!live && <div className="banner info">Нет связи с ECU: показаны значения для включённого питания и стоящего двигателя.</div>}
      <div className="sch-title">
        <div>
          <span className="sch-name"><i className="sch-swatch" style={{ background: css(net.color) }} /><b className="num">{net.name}</b></span>
          <h2>{net.title}</h2>
          {net.mcuPin && <span className="muted">Вывод контроллера: <b className="num">{net.id === 'IAC_IN' ? 'PB6…PB9' : net.mcuPin}</b></span>}
        </div>
      </div>
      {actions && <div className="sch-actions">{actions}</div>}
      <div className="sch-probes">
        <h3>Куда ставить щупы</h3>
        <div><i className="sch-dot red" /><span><b>Красный</b> — {net.probeAt}.</span></div>
        <div><i className="sch-dot black" /><span><b>Чёрный</b> — масса платы (клемма GND).</span></div>
      </div>

      <section>
        <h3>Мультиметр</h3>
        <div className="sch-meter">
          <div className="sch-lcd"><span className="num">{fmt(probe.volts, 2)}</span><small>В</small></div>
          <div className="sch-meter-info">
            <span>{probe.meterMode}</span>
            <span className="muted">Допустимо: <b className="num">{fmt(probe.lo, 2)} … {fmt(probe.hi, 2)} В</b></span>
          </div>
        </div>
        <p className="sch-now">{probe.now}</p>
        <label className="sch-input">
          <span>Ваше измерение, В</span>
          <input className={'input' + (has && !valid ? ' invalid' : '')} inputMode="decimal" placeholder="например 4,98" value={text} onChange={(e) => setText(e.target.value)} aria-label="Ваше измерение, вольт" />
        </label>
        {has && !valid && <div className="sch-verdict muted">Введите число, например 4,98.</div>}
        {valid && (ok
          ? <div className="sch-verdict ok" role="status"><b>В норме.</b> {volts(value)} — совпадает с расчётом.</div>
          : <div className="sch-verdict bad" role="status"><b>Не сходится.</b> {inRange ? `${volts(value)} в допустимых пределах, но отличается от расчётных ${volts(probe.volts)} больше чем на ${volts(tol)}.` : `${volts(value)} вне допустимых ${fmt(probe.lo, 2)} … ${fmt(probe.hi, 2)} В.`} {probe.ifWrong}</div>)}
        <button className={'btn sm ' + (checked ? 'on' : ok ? 'primary' : '')} onClick={onCheck} aria-pressed={checked}>{checked ? '✓ Проверена — снять отметку' : 'Отметить проверенной'}</button>
      </section>

      <section>
        <h3>Осциллограф</h3>
        {probe.wave ? (
          <>
            <Scope wave={probe.wave} />
            <p className="sch-now">{probe.wave.caption}.</p>
            <div className="sch-settings"><span className="muted">Настройки прибора:</span><span className="tag">{probe.wave.vDiv}</span><span className="tag">{probe.wave.tDiv}</span></div>
          </>
        ) : <p className="sch-now">Сигнал постоянный: осциллограф покажет ровную линию на уровне {volts(probe.volts)}.</p>}
      </section>

      {probe.states.length > 0 && (
        <section>
          <h3>Типовые значения</h3>
          <table className="tbl"><tbody>{probe.states.map((s) => <tr key={s.label}><td className="muted">{s.label}</td><td className="num">{s.value}</td></tr>)}</tbody></table>
        </section>
      )}
      {probe.ifWrong && <section><h3>Если не сходится</h3><p className="sch-now">{probe.ifWrong}</p></section>}
    </>
  );
}
