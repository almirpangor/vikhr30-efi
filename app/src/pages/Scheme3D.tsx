// Страница «3D-схема»: любая цепь блока управления — что на ней должно быть при проверке мультиметром и осциллографом.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BLOCKS, NETS, probeNet, type BlockId, type NetDef, type Probe } from '../core/hardware';
import { selectNet, setPage, useApp } from '../core/store';
import { PageHead, Seg, Viewport3D } from '../ui/kit';
import { ProbePanel, css, useChecked, volts } from './ProbePanel';
import { buildBoardScene, type BoardScene } from '../scenes/board';
import type { Viewer } from '../gl/viewer';
import './Scheme3D.css';

type Group = 'all' | 'pwr' | 'sens' | 'ctl' | 'link';
const GROUPS: { value: Group; label: string }[] = [
  { value: 'all', label: 'Все' }, { value: 'pwr', label: 'Питание' }, { value: 'sens', label: 'Датчики' }, { value: 'ctl', label: 'Управление' }, { value: 'link', label: 'Связь' },
];
function groupOf(n: NetDef): Group {
  if (n.kind === 'power' || n.kind === 'ground') return 'pwr';
  if (n.path.includes('bt') || n.path.includes('x_pc')) return 'link';
  if (n.path.some((b) => b.startsWith('in_'))) return 'sens';
  return 'ctl';
}

function Help() {
  return (
    <div className="sch-help">
      <h2>Как пользоваться</h2>
      <p>Щёлкните любой провод на схеме или выберите цепь в списке слева. Программа покажет, куда поставить щупы, что должен показать мультиметр и какую картинку — осциллограф. Значения пересчитываются по текущим показаниям ECU.</p>
      <p>Щелчок по детали или устройству открывает описание блока и список его цепей.</p>
      <h3>Порядок проверки новой платы</h3>
      <ol>
        <li><b>Питание.</b> BAT+, +12V_PROT, затем +5V_ECU — <b>без Blue Pill</b> в панельке, пока на выходе LM2596 не будет ровно 5,00 В. После этого +3V3.</li>
        <li><b>Датчики.</b> Питание +5V_SENS, сигналы TPS, MAP, термисторов, датчик коленвала, перемычка SERVICE и чека STOP.</li>
        <li><b>Выходы — без нагрузок.</b> Катушки, форсунка, насос и РХХ отключены; смотрите сигналы на контактах Blue Pill и на затворах ключей. Нагрузки подключайте по одной.</li>
      </ol>
      <p className="muted">Проверенную цепь отмечайте галочкой — отметки сохраняются между запусками.</p>
    </div>
  );
}

function BlockCard({ id, onClose }: { id: BlockId; onClose: () => void }) {
  const b = BLOCKS.find((x) => x.id === id)!, nets = NETS.filter((n) => n.path.includes(id));
  return (
    <div className="sch-block">
      <div className="sch-title">
        <div><span className="tag">{b.where === 'board' ? 'На плате' : 'Внешнее устройство'}</span><h2>{b.title}</h2></div>
        <button className="btn sm ghost" onClick={onClose}>Закрыть</button>
      </div>
      {b.parts && <p><span className="muted">Детали: </span>{b.parts}</p>}
      <p>{b.how}</p>
      <h3>Цепи блока</h3>
      <div className="sch-block-nets">
        {nets.map((n) => (
          <button key={n.id} className="sch-netbtn" onClick={() => { onClose(); selectNet(n.id); }}>
            <i className="sch-swatch" style={{ background: css(n.color) }} /><b className="num">{n.name}</b><span>{n.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}


export default function Scheme3DPage() {
  const telemetry = useApp((s) => s.telemetry), live = useApp((s) => s.live), dwell = useApp((s) => s.params.dwell_us), selected = useApp((s) => s.selectedNet);
  const [query, setQuery] = useState(''), [group, setGroup] = useState<Group>('all');
  const [checked, toggle] = useChecked();
  const [labelsOn, setLabelsOn] = useState(false), [block, setBlock] = useState<BlockId | null>(null);
  const scene = useRef<BoardScene | null>(null), labelsRef = useRef(false), setBlockRef = useRef(setBlock);
  setBlockRef.current = setBlock;
  labelsRef.current = labelsOn;

  const t = live ? telemetry : null;
  const probes = useMemo(() => Object.fromEntries(NETS.map((n) => [n.id, probeNet(n.id, t, dwell)])) as Record<string, Probe>, [t, dwell]);
  const net = NETS.find((n) => n.id === selected) ?? null;
  const done = NETS.filter((n) => checked[n.id]).length;
  const q = query.trim().toLowerCase();
  const shown = NETS.filter((n) => (group === 'all' || groupOf(n) === group) && (!q || (n.name + ' ' + n.title + ' ' + (n.mcuPin ?? '')).toLowerCase().includes(q)));

  useEffect(() => { scene.current?.select(selected); if (selected) setBlock(null); }, [selected]);
  useEffect(() => { if (selected) document.querySelector('.sch-row.active')?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  const setup = (viewer: Viewer, host: HTMLDivElement) => {
    const layer = document.createElement('div');
    layer.className = 'sch-layer';
    host.appendChild(layer);
    const tip = document.createElement('div');
    tip.className = 'label3d sch-tip';
    tip.hidden = true;
    layer.appendChild(tip);
    const sc = buildBoardScene(viewer, {
      onNet: (id) => { setBlockRef.current(null); selectNet(id); },
      onBlock: (id) => setBlockRef.current(id),
      onHover: (label, x, y) => { tip.hidden = !label; if (label) { tip.textContent = label; tip.style.left = x + 'px'; tip.style.top = y - 14 + 'px'; } },
    });
    const els = sc.labels.map((l) => { const el = document.createElement('div'); el.className = 'label3d sch-label'; el.textContent = l.title; el.hidden = true; layer.appendChild(el); return el; });
    // подписи: сначала устройства и модули, затем узлы на плате; наезжающие друг на друга скрываются до приближения
    const order = sc.labels.map((l, i) => i).sort((a, b) => Number(sc.labels[a].id.startsWith('in_') || sc.labels[a].id.startsWith('out_')) - Number(sc.labels[b].id.startsWith('in_') || sc.labels[b].id.startsWith('out_')));
    const widths: number[] = [];
    sc.afterFrame = () => {
      const w = viewer.canvas.clientWidth, h = viewer.canvas.clientHeight, placed: [number, number, number, number][] = [];
      for (const i of order) {
        const el = els[i];
        if (!labelsRef.current) { el.hidden = true; continue; }
        const p = viewer.project(sc.labels[i].pos);
        if (!p.visible || p.x < 0 || p.x > w || p.y < 20 || p.y > h) { el.hidden = true; continue; }
        if (!widths[i]) { el.hidden = false; widths[i] = el.offsetWidth; }
        const half = widths[i] / 2, x = Math.max(half + 3, Math.min(w - half - 3, p.x)), r: [number, number, number, number] = [x - half, p.y - 19, x + half, p.y];
        el.hidden = placed.some((q) => r[0] < q[2] + 3 && r[2] > q[0] - 3 && r[1] < q[3] + 1 && r[3] > q[1] - 1);
        if (!el.hidden) { placed.push(r); el.style.left = x.toFixed(1) + 'px'; el.style.top = p.y.toFixed(1) + 'px'; }
      }
    };
    viewer.canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
    scene.current = sc;
    sc.select(selected, false);
    return () => { scene.current = null; layer.remove(); };
  };

  return (
    <div className="page fill sch">
      <PageHead title="3D-схема" sub="Выберите провод — и увидите, что на нём должно быть при проверке мультиметром и осциллографом">
        <div className="sch-progress" title="Отметки сохраняются между запусками">
          <span>Проверено <b className="num">{done}</b> из <b className="num">{NETS.length}</b></span>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={NETS.length} aria-valuenow={done}><i style={{ width: `${(done / NETS.length) * 100}%` }} /></div>
        </div>
      </PageHead>
      <div className="sch-grid">
        <aside className="card flush sch-list" aria-label="Список цепей">
          <div className="sch-list-head">
            <input className="input" type="search" placeholder="Поиск: PA0, TPS, катушка…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск цепи по имени" />
            <Seg value={group} options={GROUPS} onChange={setGroup} label="Вид цепей" />
          </div>
          <div className="sch-rows">
            {shown.map((n) => (
              <div key={n.id} className={'sch-row' + (n.id === selected ? ' active' : '')} data-net={n.id}>
                <button className="sch-row-main" onClick={() => { setBlock(null); selectNet(n.id); }} aria-pressed={n.id === selected} title={n.title}>
                  <i className="sch-swatch" style={{ background: css(n.color) }} />
                  <span className="sch-row-text"><b className="num">{n.name}</b><span>{n.title}</span></span>
                  <span className={'num sch-row-v' + (live ? '' : ' nodata')} title={live ? 'Ожидается сейчас' : 'Нет связи: значение для включённого питания и стоящего двигателя'}>{volts(probes[n.id].volts)}</span>
                </button>
                <button className={'sch-check' + (checked[n.id] ? ' on' : '')} onClick={() => toggle(n.id)} aria-pressed={!!checked[n.id]} aria-label={(checked[n.id] ? 'Снять отметку «проверено»: ' : 'Отметить проверенной: ') + n.name} title={checked[n.id] ? 'Проверена' : 'Отметить проверенной'}>✓</button>
              </div>
            ))}
            {!shown.length && <div className="empty">Ничего не найдено</div>}
          </div>
        </aside>

        <div className="sch-center">
          <div className="sch-tools">
            <div className="seg" role="group" aria-label="Ракурс">
              <button onClick={() => scene.current?.view('top')}>Сверху</button>
              <button onClick={() => scene.current?.view('iso')}>Изометрия</button>
              <button onClick={() => scene.current?.view('board')}>К плате</button>
            </div>
            <button className={'btn sm' + (labelsOn ? ' on' : '')} aria-pressed={labelsOn} onClick={() => setLabelsOn(!labelsOn)}>Подписи</button>
            <button className="btn sm" disabled={!selected && !block} onClick={() => { selectNet(null); setBlock(null); }}>Сбросить выбор</button>
          </div>
          <Viewport3D setup={setup} className="sch-view" />
          <div className="sch-hint">Вращать — левая кнопка мыши · двигать — правая или Shift · масштаб — колесо · щелчок по проводу или детали — выбрать</div>
        </div>

        <aside className="card sch-panel" aria-label="Измерение">
          {block ? <BlockCard id={block} onClose={() => setBlock(null)} /> : net ? <ProbePanel net={net} probe={probes[net.id]} live={live} checked={!!checked[net.id]} onCheck={() => toggle(net.id)} actions={<button className="btn sm" onClick={() => setPage('scheme2d')} title="Открыть принципиальную схему на листе с этой цепью">Показать на схеме</button>} /> : <Help />}
          <p className="sch-foot">Схема составлена по документации и на железе не испытана — проверяйте каждую цепь на стенде с ограничением тока.</p>
        </aside>
      </div>
    </div>
  );
}
