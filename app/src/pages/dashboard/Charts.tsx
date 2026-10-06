// Вид «Графики»: карточки показателей с историей за последние 10–60 с.
import { useEffect, useRef, useState } from 'react';
import { historyMeta, historySeries, load, save, toggleRecording, useApp } from '../../core/store';
import type { Telemetry } from '../../core/types';
import { DASH, Seg, fmt } from '../../ui/kit';
import { METRICS, TONE_COLOR, type Ctx, type Metric, type Mode } from './metrics';

const RATE = 10; // кадров телеметрии в секунду
const MONO = '11px "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace';
const PAD = { l: 6, r: 6, t: 6, b: 17 };

type Modes = Record<string, Mode>;
const defaultModes = (): Modes => Object.fromEntries(METRICS.map((m) => [m.id, m.def]));
function loadModes(): Modes {
  const saved = load<Record<string, unknown>>('dash.modes', {}), out = defaultModes();
  if (saved && typeof saved === 'object')
    for (const m of METRICS) { const v = saved[m.id]; if (v === 'hide' || v === 'num' || v === 'graph') out[m.id] = v; }
  return out;
}

/** Значения показателя за окно, от старых к новым (последнее — самое свежее). */
function windowSeries(m: Metric, windowS: number): number[] {
  const all = historySeries(m.base), n = windowS * RATE + 1;
  return (all.length > n ? all.slice(all.length - n) : all).map(m.conv);
}

function drawChart(canvas: HTMLCanvasElement, m: Metric, data: number[], windowS: number, hoverBack: number | null) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w < 20 || h < 20) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const x0 = PAD.l, x1 = w - PAD.r, y0 = PAD.t, y1 = h - PAD.b, pw = x1 - x0, ph = y1 - y0;
  let lo = m.min, hi = m.max;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const X = (back: number) => x1 - (back / (windowS * RATE)) * pw;
  const Y = (v: number) => y1 - ((v - lo) / (hi - lo)) * ph;

  // сетка
  g.lineWidth = 1; g.font = MONO; g.textBaseline = 'alphabetic';
  g.strokeStyle = 'rgba(143,161,181,0.13)';
  g.beginPath();
  for (let i = 0; i <= 4; i++) { const y = Math.round(y0 + (ph * i) / 4) + 0.5; g.moveTo(x0, y); g.lineTo(x1, y); }
  const stepS = windowS <= 10 ? 2 : windowS <= 30 ? 5 : 10;
  for (let s = 0; s <= windowS; s += stepS) { const x = Math.round(X(s * RATE)) + 0.5; g.moveTo(x, y0); g.lineTo(x, y1); }
  g.stroke();
  g.fillStyle = '#5e7186';
  const everyLabel = pw / (windowS / stepS) < 34 ? 2 : 1;
  for (let s = 0, i = 0; s <= windowS; s += stepS, i++) {
    if (i % everyLabel) continue;
    const x = X(s * RATE);
    g.textAlign = s === 0 ? 'right' : s === windowS ? 'left' : 'center';
    g.fillText(s === 0 ? '0 с' : '−' + s, s === 0 ? x1 : s === windowS ? x0 : x, h - 4);
  }

  // линия
  const n = data.length;
  if (n > 1) {
    g.beginPath();
    for (let i = 0; i < n; i++) { const x = X(n - 1 - i), y = Y(data[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.strokeStyle = m.color; g.lineWidth = 1.6; g.lineJoin = 'round';
    g.stroke();
    g.lineTo(X(0), y1); g.lineTo(X(n - 1), y1); g.closePath();
    g.globalAlpha = 0.1; g.fillStyle = m.color; g.fill(); g.globalAlpha = 1;
  }

  // подписи пределов оси
  g.textAlign = 'left'; g.fillStyle = '#8fa1b5';
  const dg = hi - lo >= 100 ? 0 : m.digits;
  g.fillText(fmt(hi, dg), x0 + 3, y0 + 10);
  g.fillText(fmt(lo, dg), x0 + 3, y1 - 4);

  // курсор
  if (hoverBack !== null && n > 0 && hoverBack <= n - 1) {
    const v = data[n - 1 - hoverBack], x = X(hoverBack), y = Y(v);
    g.strokeStyle = 'rgba(231,238,246,0.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(Math.round(x) + 0.5, y0); g.lineTo(Math.round(x) + 0.5, y1); g.stroke();
    g.fillStyle = m.color; g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill();
    const label = `${fmt(v, m.digits)} ${m.unit} · ${hoverBack === 0 ? '0,0' : '−' + fmt(hoverBack / RATE, 1)} с`;
    const tw = g.measureText(label).width + 12;
    let bx = x + 8; if (bx + tw > x1) bx = x - 8 - tw; if (bx < x0) bx = x0;
    const by = y0 + 16;
    g.fillStyle = 'rgba(10,15,21,0.92)'; g.strokeStyle = '#33475a';
    g.beginPath(); g.roundRect(bx, by, tw, 19, 5); g.fill(); g.stroke();
    g.fillStyle = '#e7eef6'; g.textAlign = 'left';
    g.fillText(label, bx + 6, by + 13.5);
  }
}

function GraphCard({ m, t, ctx, windowS, hoverBack, setHover, tick }: { m: Metric; t: Telemetry | null; ctx: Ctx; windowS: number; hoverBack: number | null; setHover: (v: number | null) => void; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(0);
  const data = windowSeries(m, windowS);
  useEffect(() => {
    const c = ref.current;
    if (!c || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setSize((s) => s + 1));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (ref.current) drawChart(ref.current, m, data, windowS, hoverBack); });
  void tick; void size;
  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), pw = r.width - PAD.l - PAD.r;
    const back = Math.round(((r.right - PAD.r - e.clientX) / pw) * windowS * RATE);
    setHover(Math.max(0, Math.min(windowS * RATE, back)));
  };
  const tone = t && m.tone ? m.tone(t, ctx) : 'plain';
  return (
    <div className="card dash-card dash-graph" data-metric={m.id}>
      <div className="dash-card-head">
        <span className="dash-swatch" style={{ background: m.color }} aria-hidden="true" />
        <span className="dash-card-title" title={m.title}>{m.title}</span>
        <span className="num dash-graph-value" style={{ color: t ? TONE_COLOR[tone] : 'var(--nodata)' }}>
          {t ? fmt(m.conv(t[m.base]), m.digits) : DASH}<small>{m.unit}</small>
        </span>
      </div>
      <canvas ref={ref} className="dash-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        role="img" aria-label={`График: ${m.title}, последние ${windowS} с`} />
      <div className="num dash-minmax">
        {data.length ? <>мин {fmt(lo, m.digits)} · макс {fmt(hi, m.digits)}</> : 'история пуста'}
        {t && m.note && <span>{m.note(t)}</span>}
      </div>
    </div>
  );
}

function NumCard({ m, t, ctx }: { m: Metric; t: Telemetry | null; ctx: Ctx }) {
  const tone = t && m.tone ? m.tone(t, ctx) : 'plain';
  return (
    <div className="card dash-card dash-numcard" data-metric={m.id}>
      <div className="dash-card-head">
        <span className="dash-swatch" style={{ background: m.color }} aria-hidden="true" />
        <span className="dash-card-title" title={m.title}>{m.title}</span>
      </div>
      <div className="num dash-num-value" style={{ color: t ? TONE_COLOR[tone] : 'var(--nodata)' }}>
        {t ? fmt(m.conv(t[m.base]), m.digits) : DASH}<small>{m.unit}</small>
      </div>
      <div className="num dash-minmax">{t && m.note ? m.note(t) : ' '}</div>
    </div>
  );
}

const MODE_OPTIONS: { value: Mode; label: string }[] = [{ value: 'hide', label: 'Скрыть' }, { value: 'num', label: 'Число' }, { value: 'graph', label: 'График' }];
const WINDOW_OPTIONS = [{ value: '10', label: '10 с' }, { value: '30', label: '30 с' }, { value: '60', label: '60 с' }];

export function Charts() {
  const frames = useApp((s) => s.frames);
  const telemetry = useApp((s) => s.telemetry);
  const live = useApp((s) => s.live);
  const recording = useApp((s) => s.recording);
  const recordedRows = useApp((s) => s.recordedRows);
  const params = useApp((s) => s.ecuParams);
  const ecuIgn = useApp((s) => s.ecuIgn);
  const mapsLoaded = useApp((s) => s.mapsLoaded);
  const [modes, setModes] = useState<Modes>(loadModes);
  const [windowS, setWindowS] = useState<number>(() => { const v = load<number>('dash.window', 30); return v === 10 || v === 60 ? v : 30; });
  const [paused, setPaused] = useState(historyMeta.paused);
  const [setup, setSetup] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const setupBtn = useRef<HTMLButtonElement>(null);

  // пауза — общая для программы, поэтому при уходе со страницы снимается
  useEffect(() => () => { historyMeta.paused = false; }, []);
  useEffect(() => {
    if (!setup) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSetup(false); setupBtn.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setup]);

  const t = live ? telemetry : null;
  const ctx: Ctx = { params, ecuIgn, mapsLoaded };
  const setMode = (id: string, mode: Mode) => { const next = { ...modes, [id]: mode }; setModes(next); save('dash.modes', next); };
  const togglePause = () => { historyMeta.paused = !paused; setPaused(!paused); };
  const shown = METRICS.filter((m) => modes[m.id] !== 'hide');

  return (
    <div className="dash-charts">
      <div className="dash-toolbar">
        <span className="muted">Окно</span>
        <Seg label="Окно времени графиков" value={String(windowS)} options={WINDOW_OPTIONS} onChange={(v) => { setWindowS(Number(v)); save('dash.window', Number(v)); }} />
        <button className={'btn sm ' + (paused ? 'on' : '')} aria-pressed={paused} onClick={togglePause} title="Остановить обновление графиков, чтобы рассмотреть участок">{paused ? 'Продолжить' : 'Пауза'}</button>
        {paused && <span className="tag warn">графики на паузе</span>}
        {!live && <span className="tag">нет данных от ECU — графики застыли</span>}
        <span style={{ flex: 1 }} />
        {recording && <span className="tag danger num" aria-live="off">● запись: {recordedRows} строк</span>}
        <button className={'btn sm ' + (recording ? 'danger' : '')} disabled={!live && !recording} onClick={toggleRecording}
          title={recording ? 'Остановить запись и сохранить файл CSV' : live ? 'Записывать каждую строку телеметрии в файл CSV' : 'ECU не подключён'}>
          {recording ? 'Остановить и сохранить' : 'Запись в CSV'}
        </button>
        <button ref={setupBtn} className={'btn sm ' + (setup ? 'on' : '')} aria-expanded={setup} onClick={() => setSetup(!setup)}>Настроить</button>
      </div>

      <div className="dash-charts-body">
        {shown.length === 0
          ? <div className="empty"><b>Все показатели скрыты</b><span>Нажмите «Настроить» и выберите, что показывать.</span></div>
          : (
            <div className="dash-grid">
              {shown.map((m) => modes[m.id] === 'graph'
                ? <GraphCard key={m.id} m={m} t={t} ctx={ctx} windowS={windowS} hoverBack={hover} setHover={setHover} tick={frames} />
                : <NumCard key={m.id} m={m} t={t} ctx={ctx} />)}
            </div>
          )}
        {setup && (
          <aside className="dash-setup" role="dialog" aria-label="Настройка показателей">
            <div className="dash-setup-head">
              <h2>Показатели</h2>
              <span style={{ flex: 1 }} />
              <button className="btn sm ghost" onClick={() => { const d = defaultModes(); setModes(d); save('dash.modes', d); }}>По умолчанию</button>
              <button className="btn sm" autoFocus onClick={() => { setSetup(false); setupBtn.current?.focus(); }}>Закрыть</button>
            </div>
            <ul>
              {METRICS.map((m) => (
                <li key={m.id}>
                  <span className="dash-swatch" style={{ background: m.color }} aria-hidden="true" />
                  <span className="dash-setup-name">{m.title}<small>{m.unit}</small></span>
                  <Seg label={m.title} value={modes[m.id]} options={MODE_OPTIONS} onChange={(v) => setMode(m.id, v)} />
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}
