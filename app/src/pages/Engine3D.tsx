// Страница «Двигатель 3D»: только управление сценой src/scenes/engine.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHead, Seg, Viewport3D, fmt, DASH } from '../ui/kit';
import { useApp, getState, selectNet, setPage, load, save } from '../core/store';
import { NETS } from '../core/hardware';
import type { Telemetry } from '../core/types';
import type { Viewer, Node3, Camera } from '../gl/viewer';
import { createEngineScene, slowdown, type EngineScene, type PartInfo, type ValueKey, type ViewMode } from '../scenes/engine';
import './Engine3D.css';

const HOME: Partial<Camera> = { target: [4.5, 0.5, 0], yaw: 0.34, pitch: 0.27, dist: 74 };
const VIEWS: { id: string; label: string; cam: Partial<Camera> }[] = [
  { id: 'front', label: 'Спереди', cam: { yaw: 0, pitch: 0.04 } },
  { id: 'side', label: 'Сбоку', cam: { yaw: Math.PI / 2, pitch: 0.04 } },
  { id: 'top', label: 'Сверху', cam: { yaw: 0, pitch: 1.45 } },
  { id: 'iso', label: 'Изометрия', cam: { yaw: 0.34, pitch: 0.27 } },
];
const MODES: { value: ViewMode; label: string }[] = [
  { value: 'solid', label: 'Целиком' }, { value: 'ghost', label: 'Прозрачный корпус' }, { value: 'section', label: 'Разрез' },
];

/** Узкое окно — отодвигаем камеру, чтобы модель не уходила под панель с цифрами. */
const baseDist = (v: Viewer) => 74 * Math.min(1.4, Math.max(1, 860 / Math.max(1, v.canvas.clientWidth)));
const framing = (v: Viewer, e: number): Partial<Camera> => ({ dist: baseDist(v) * (1 + 1.12 * e), target: [4.5 + 11 * e, 0.5 + 1.5 * e, 0] });

/** Живое значение для подписи/карточки: [название, текст, пояснение]. */
function liveValue(key: ValueKey, t: Telemetry): [string, string, string?] {
  switch (key) {
    case 'rpm': return ['Обороты', fmt(t.rpm) + ' об/мин'];
    case 'tps': return ['Открытие дросселя', fmt(t.tps10 / 10, 1) + ' %'];
    case 'map': return ['Давление во впуске', fmt(t.map10 / 10, 1) + ' кПа'];
    case 'cht': return ['Температура головки', fmt(t.cht10 / 10, 1) + ' °C'];
    case 'iat': return ['Температура воздуха', fmt(t.iat10 / 10, 1) + ' °C'];
    case 'o2': {
      const dir = t.lambdaDir === -1 ? 'богато' : t.lambdaDir === 1 ? 'бедно' : t.lambdaDir === 0 ? 'норма' : 'датчик не готов';
      return ['Лямбда-зонд', t.lambdaMilli > 0 ? 'λ ' + fmt(t.lambdaMilli / 1000, 2) : fmt(t.o2Mv) + ' мВ', dir];
    }
    case 'pw': return ['Длительность впрыска', t.fuelCut ? 'отсечка' : fmt(t.pwUs / 1000, 2) + ' мс'];
    case 'adv': return ['Угол опережения', fmt(t.advance10 / 10, 1) + '° до ВМТ'];
    case 'iac': return ['Положение РХХ', fmt(t.iacPos) + ' шаг'];
    case 'heater': return ['Нагреватель лямбды', fmt(t.heater) + ' %'];
  }
}
const SHORT: Record<string, (t: Telemetry) => string> = {
  rpm: (t) => fmt(t.rpm) + ' об/мин', tps: (t) => fmt(t.tps10 / 10, 1) + ' %', map: (t) => fmt(t.map10 / 10, 1) + ' кПа',
  cht: (t) => fmt(t.cht10 / 10, 1) + ' °C', iat: (t) => fmt(t.iat10 / 10, 1) + ' °C',
  o2: (t) => (t.lambdaMilli > 0 ? 'λ ' + fmt(t.lambdaMilli / 1000, 2) : fmt(t.o2Mv) + ' мВ'),
  pw: (t) => (t.fuelCut ? 'отсечка' : fmt(t.pwUs / 1000, 2) + ' мс'), adv: (t) => fmt(t.advance10 / 10, 1) + '°', iac: (t) => fmt(t.iacPos) + ' шаг',
};
const LABELS: { id: ValueKey; title: string }[] = [
  { id: 'rpm', title: 'Обороты' }, { id: 'adv', title: 'УОЗ' }, { id: 'cht', title: 'CHT' }, { id: 'o2', title: 'Лямбда' }, { id: 'pw', title: 'Впрыск' },
  { id: 'tps', title: 'TPS' }, { id: 'map', title: 'MAP' }, { id: 'iat', title: 'IAT' }, { id: 'iac', title: 'РХХ' },
];

export default function Engine3DPage() {
  const telemetry = useApp((s) => s.telemetry), live = useApp((s) => s.live), iacMax = useApp((s) => s.params.iac_max_steps);
  const t = live ? telemetry : null;
  const [mode, setMode] = useState<ViewMode>(() => load<ViewMode>('engine.mode', 'solid'));
  const [explode, setExplode] = useState(0);
  const [labels, setLabels] = useState(() => load('engine.labels', true));
  const [heat, setHeat] = useState(() => load('engine.heat', false));
  const [selected, setSelected] = useState<Node3 | null>(null);
  const sceneRef = useRef<EngineScene | null>(null), viewerRef = useRef<Viewer | null>(null);
  const labelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tipRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<Node3 | null>(null), selRef = useRef<Node3 | null>(null);

  const setup = useCallback((viewer: Viewer, host: HTMLDivElement) => {
    const scene = createEngineScene(viewer);
    sceneRef.current = scene; viewerRef.current = viewer;
    Object.assign(viewer.cam, { ...HOME, dist: baseDist(viewer), minDist: 18, maxDist: 340, fov: 0.6 });
    scene.setMode(load<ViewMode>('engine.mode', 'solid'));
    scene.setHeat(load('engine.heat', false));
    viewer.onFrame = (dt) => {
      const s = getState();
      scene.update(dt, s.live ? s.telemetry : null, s.live);
      const w = viewer.canvas.clientWidth, h = viewer.canvas.clientHeight, eye = viewer.eye();
      for (const a of scene.anchors) {
        const el = labelRefs.current[a.id];
        if (!el) continue;
        const p = viewer.project(a.pos), ok = p.visible && p.x > 8 && p.x < w - 8 && p.y > 28 && p.y < h - 4;
        el.style.display = ok ? '' : 'none';
        if (ok) { el.style.left = p.x.toFixed(1) + 'px'; el.style.top = (p.y - 8).toFixed(1) + 'px'; }
        const n = a.normal;
        el.classList.toggle('eng-behind', n[0] * (eye[0] - a.pos[0]) + n[1] * (eye[1] - a.pos[1]) + n[2] * (eye[2] - a.pos[2]) < 0);
      }
    };
    const tip = () => tipRef.current;
    viewer.onHover = (hit, ev) => {
      hoverRef.current = hit;
      scene.highlight(hit, selRef.current);
      host.style.cursor = hit ? 'pointer' : '';
      const el = tip();
      if (!el) return;
      if (!hit) { el.style.display = 'none'; return; }
      const r = host.getBoundingClientRect();
      el.textContent = hit.label;
      el.style.display = '';
      el.style.left = Math.min(r.width - 12, ev.clientX - r.left + 14) + 'px';
      el.style.top = ev.clientY - r.top + 16 + 'px';
    };
    viewer.onPick = (hit) => {
      selRef.current = hit;
      scene.highlight(hoverRef.current, hit);
      setSelected(hit);
    };
    const leave = () => { hoverRef.current = null; scene.highlight(null, selRef.current); const el = tip(); if (el) el.style.display = 'none'; };
    viewer.canvas.addEventListener('pointerleave', leave);
    const dbg = window as unknown as { __engine?: unknown };
    dbg.__engine = { scene, viewer };
    return () => { viewer.canvas.removeEventListener('pointerleave', leave); viewer.onFrame = null; sceneRef.current = null; viewerRef.current = null; delete dbg.__engine; };
  }, []);

  useEffect(() => { sceneRef.current?.setMode(mode); save('engine.mode', mode); }, [mode]);
  useEffect(() => { sceneRef.current?.setHeat(heat); save('engine.heat', heat); }, [heat]);
  useEffect(() => { save('engine.labels', labels); }, [labels]);
  useEffect(() => { sceneRef.current?.setIacMax(iacMax); }, [iacMax]);
  const onExplode = (v: number) => {
    setExplode(v);
    const e = v / 100, vw = viewerRef.current;
    sceneRef.current?.setExplode(e);
    if (vw) vw.flyTo(framing(vw, e), 0.25);
  };
  const fly = (cam: Partial<Camera>) => {
    const e = explode / 100, v = viewerRef.current;
    if (v) v.flyTo({ ...cam, ...framing(v, e) }, 0.6);
  };
  const deselect = () => { selRef.current = null; sceneRef.current?.highlight(hoverRef.current, null); setSelected(null); };

  const info = selected?.data.info as PartInfo | undefined;
  const net = info?.net ? NETS.find((n) => n.id === info.net) : undefined;
  const lv = info?.value && t ? liveValue(info.value, t) : null;
  const running = !!t && t.rpm > 0;
  const sd = slowdown(t?.rpm ?? 0);
  const num = (s: string | null) => (s === null ? <b className="num nodata">{DASH}</b> : <b className="num">{s}</b>);

  return (
    <div className="page fill">
      <PageHead title="Двигатель 3D" sub="Силовая головка «Вихрь-30»: двухтактный, два цилиндра, вертикальный коленвал. Движение — по телеметрии блока." />
      <div className="eng-bar">
        <Seg value={mode} options={MODES} onChange={setMode} label="Режим вида" />
        <label className="eng-explode">
          <span>Разобрать</span>
          <input type="range" min={0} max={100} value={explode} onChange={(e) => onExplode(Number(e.target.value))} aria-label="Разобрать модель, проценты" />
          <b className="num">{explode} %</b>
        </label>
        <div className="eng-views" role="group" aria-label="Ракурс">
          {VIEWS.map((v) => <button key={v.id} className="btn sm" onClick={() => fly(v.cam)}>{v.label}</button>)}
        </div>
        <button className={'btn sm ' + (labels ? 'on' : '')} aria-pressed={labels} onClick={() => setLabels(!labels)}>Подписи датчиков</button>
        <button className={'btn sm ' + (heat ? 'on' : '')} aria-pressed={heat} onClick={() => setHeat(!heat)}>Тепловая карта</button>
      </div>
      <div className="eng-main">
        <Viewport3D setup={setup} className="eng-view">
          {labels && LABELS.map((l) => (
            <div key={l.id} className="label3d eng-label" ref={(el: HTMLDivElement | null) => { labelRefs.current[l.id] = el; }} style={{ display: 'none' }}>
              <span>{l.title}</span>{t ? <b className="num">{SHORT[l.id](t)}</b> : <b className="num nodata">{DASH}</b>}
            </div>
          ))}
          <div className="label3d eng-tip" ref={tipRef} style={{ display: 'none' }} />
          <div className="eng-hud" aria-label="Основные показания">
            <div><span>Обороты</span>{num(t ? fmt(t.rpm) : null)}<i>об/мин</i></div>
            <div><span>УОЗ</span>{num(t ? fmt(t.advance10 / 10, 1) : null)}<i>°</i></div>
            <div><span>Впрыск</span>{num(t ? (t.fuelCut ? 'отсечка' : fmt(t.pwUs / 1000, 2)) : null)}<i>{t && t.fuelCut ? '' : 'мс'}</i></div>
            <div><span>Замедление</span>{num(running ? '×' + fmt(sd.factor < 10 ? sd.factor : Math.round(sd.factor), sd.factor < 10 ? 1 : 0) : null)}<i /></div>
            <p>{!t ? 'Нет связи с блоком — механизм стоит' : !running ? 'Двигатель остановлен' : t.kill ? 'Чека выдернута: искры и впрыска нет' : (t.flags & 32) ? 'Отсечка по оборотам: искра через раз' : t.fuelCut ? 'Отсечка топлива: распыла нет' : `Показано в ${fmt(Math.round(sd.factor))} раз медленнее`}</p>
          </div>
          {heat && (
            <div className="eng-legend" aria-label="Шкала тепловой карты">
              <b>Тепловая карта</b>
              <div className="eng-grad" />
              <div className="eng-grad-ticks num"><span>20</span><span>60</span><span>90</span><span>110 °C</span></div>
              <p>{t ? 'Головка — по датчику CHT, впуск — по датчику IAT.' : 'Нет данных от блока — цвет серый.'}</p>
            </div>
          )}
          <div className="eng-help">
            <span className="kbd">ЛКМ</span> вращать <span className="kbd">ПКМ</span>/<span className="kbd">Shift</span> двигать <span className="kbd">колесо</span> масштаб · щелчок по детали — описание
          </div>
        </Viewport3D>
        <aside className="card eng-card" aria-live="polite">
          {selected && info ? (
            <>
              <div className="eng-card-head">
                <h2>{selected.label}</h2>
                <button className="btn sm ghost" onClick={deselect} aria-label="Снять выбор">✕</button>
              </div>
              <p className="eng-desc">{info.desc}</p>
              {info.value && (
                <div className="eng-val">
                  <span>{lv ? lv[0] : liveValue(info.value, EMPTY)[0]}</span>
                  {lv ? <b className="num">{lv[1]}</b> : <b className="num nodata">{DASH}</b>}
                  {lv?.[2] && <i>{lv[2]}</i>}
                  {!lv && <i>нет связи с блоком</i>}
                </div>
              )}
              {net && (
                <>
                  <div className="eng-net"><span className="tag">Цепь {net.name}</span> {net.title}</div>
                  <button className="btn primary" onClick={() => { selectNet(net.id); setPage('scheme'); }}>Показать на схеме</button>
                </>
              )}
            </>
          ) : (
            <div className="eng-card-empty">
              <h2>Деталь не выбрана</h2>
              <p>Наведите указатель на деталь, чтобы увидеть название. Щёлкните — здесь появится описание, живое значение и переход к цепи на схеме.</p>
              <ul>
                <li><b>Прозрачный корпус</b> — видны поршни, шатуны и коленвал.</li>
                <li><b>Разрез</b> — плоскость через оси цилиндров: видны искра, вспышка в камере и факел форсунки.</li>
                <li><b>Разобрать</b> — детали разъезжаются вдоль осей сборки.</li>
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

const EMPTY = { rpm: 0, tps10: 0, map10: 0, cht10: 0, iat10: 0, o2Mv: 0, lambdaMilli: 0, lambdaDir: 2, pwUs: 0, advance10: 0, iacPos: 0, heater: 0, fuelCut: 0 } as Telemetry;
