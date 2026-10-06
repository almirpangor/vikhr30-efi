import { useEffect, useState, type ReactNode } from 'react';
import { FAULTS } from './core/types';
import { canRedo, canUndo, connectDemo, connectSerial, disconnect, dismissToast, getEmulator, isSerialSupported, redo, setPage, undo, useApp } from './core/store';
import { ConfirmHost, fmt } from './ui/kit';
import DashboardPage from './pages/Dashboard';
import Engine3DPage from './pages/Engine3D';
import { FuelMapPage, IgnMapPage } from './pages/Maps';
import ParamsPage from './pages/Params';
import DiagnosticsPage from './pages/Diagnostics';
import TestsPage from './pages/Tests';
import Scheme2DPage from './pages/Scheme2D';
import Scheme3DPage from './pages/Scheme3D';
import BomPage from './pages/Bom';
import GuidePage from './pages/Guide';
import LogPage from './pages/Log';

const I = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

interface PageDef { id: string; title: string; group: string; icon: ReactNode; view: () => ReactNode }
export const PAGES: PageDef[] = [
  { id: 'dashboard', title: 'Приборы', group: 'Наблюдение', icon: I('M4 15a8 8 0 1 1 16 0M12 15l4-5M3 19h18'), view: () => <DashboardPage /> },
  { id: 'engine', title: 'Двигатель 3D', group: 'Наблюдение', icon: I('M4 10h3l2-3h6l2 3h3v7h-3l-2 2H9l-2-2H4zM9 4h6'), view: () => <Engine3DPage /> },
  { id: 'diag', title: 'Диагностика', group: 'Наблюдение', icon: I('M3 12h4l2-6 4 12 2-6h6'), view: () => <DiagnosticsPage /> },
  { id: 'fuel', title: 'Карта топлива', group: 'Калибровки', icon: I('M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.500 6-11 6-11z'), view: () => <FuelMapPage /> },
  { id: 'ign', title: 'Карта зажигания', group: 'Калибровки', icon: I('M13 2 5 14h6l-1 8 8-12h-6z'), view: () => <IgnMapPage /> },
  { id: 'params', title: 'Параметры', group: 'Калибровки', icon: I('M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4'), view: () => <ParamsPage /> },
  { id: 'scheme2d', title: 'Схема', group: 'Железо', icon: I('M2 12h4l1.500-3 3 6 3-6 3 6 1.500-3h4M12 3v3M12 18v3'), view: () => <Scheme2DPage /> },
  { id: 'scheme', title: '3D-схема', group: 'Железо', icon: I('M4 6h16v12H4zM8 10h3v4H8zM14 9v6M17 9v6M2 9h2M2 15h2M20 9h2M20 15h2'), view: () => <Scheme3DPage /> },
  { id: 'tests', title: 'Тест устройств', group: 'Железо', icon: I('M9 3v6l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3M8 3h8M7 15h10'), view: () => <TestsPage /> },
  { id: 'bom', title: 'Комплектующие', group: 'Железо', icon: I('M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10'), view: () => <BomPage /> },
  { id: 'guide', title: 'Настройка по шагам', group: 'Справка', icon: I('M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h3'), view: () => <GuidePage /> },
  { id: 'log', title: 'Журнал', group: 'Справка', icon: I('M4 5h16M4 10h16M4 15h10M4 20h7'), view: () => <LogPage /> },
];

function StatusChips() {
  const status = useApp((s) => s.status), demo = useApp((s) => s.demo), fw = useApp((s) => s.fwVersion), port = useApp((s) => s.portName);
  const t = useApp((s) => s.telemetry), live = useApp((s) => s.live), unsaved = useApp((s) => s.unsaved);
  const linkText = { disconnected: 'Не подключено', opening: 'Открытие порта…', waiting: 'Ожидание ответа ECU…', online: demo ? 'Демо-режим' : 'ECU на связи', lost: 'Нет ответа ECU' }[status];
  const linkCls = status === 'online' ? 'ok' : status === 'lost' ? 'danger' : status === 'disconnected' ? '' : 'warn';
  const faults = live && t ? FAULTS.filter((f) => t.flags & (1 << f.bit) && f.bit !== 8) : [];
  return (
    <>
      <span className={'chip ' + linkCls} title={port ? `${port}${fw ? ' · прошивка ' + fw : ''}` : ''}><i className="dot" />{linkText}{status === 'online' && fw ? <span className="faint">· {fw.split('-')[0]}</span> : null}</span>
      {live && t && (
        <>
          <span className="chip"><span className="muted">об/мин</span><b>{t.rpm}</b></span>
          <span className="chip opt"><span className="muted">бортсеть</span><b>{fmt(t.batteryMv / 1000, 1)} В</b></span>
          <span className={'chip ' + (t.service ? 'ok' : '')} title="Запись настроек и тесты разрешены, когда двигатель стоит и установлена перемычка SERVICE"><i className="dot" />{t.service ? 'Запись разрешена' : 'Запись закрыта'}</span>
          {t.kill ? <span className="chip danger"><i className="dot" />STOP: чека</span> : null}
          {faults.length ? <span className="chip warn" title={faults.map((f) => f.title).join('; ')}><i className="dot" />Ошибок: {faults.length}</span> : null}
          {unsaved ? <span className="chip warn" title="В RAM ECU есть изменения, не сохранённые во Flash"><i className="dot" />Не сохранено во Flash</span> : null}
        </>
      )}
    </>
  );
}

function DemoPanel() {
  const demo = useApp((s) => s.demo), status = useApp((s) => s.status);
  const [, force] = useState(0);
  const emu = getEmulator();
  if (!demo || !emu || status === 'disconnected') return null;
  const inp = emu.inputs, upd = (fn: () => void) => { fn(); force((n) => n + 1); };
  return (
    <div className="demo-panel" aria-label="Управление эмулятором">
      <button className={'btn sm ' + (inp.running ? 'on' : '')} onClick={() => upd(() => { inp.running = !inp.running; if (!inp.running) inp.throttle = 0; })}>{inp.running ? 'Заглушить' : 'Завести'}</button>
      <label className="row" style={{ gap: 6 }}>Газ
        <input type="range" min={0} max={100} value={Math.round(inp.throttle * 100)} aria-label="Положение дросселя в демо-режиме" onChange={(e) => upd(() => { inp.throttle = Number(e.target.value) / 100; })} />
      </label>
      <button className={'btn sm ' + (inp.service ? 'on' : '')} title="Перемычка SERVICE" onClick={() => upd(() => { inp.service = !inp.service; })}>SERVICE</button>
      <button className={'btn sm ' + (inp.kill ? 'danger' : '')} title="Аварийная чека" onClick={() => upd(() => { inp.kill = !inp.kill; })}>Чека</button>
      <button className={'btn sm ' + (emu.silent ? 'danger' : '')} title="Имитация обрыва провода: блок перестаёт отвечать" onClick={() => upd(() => { emu.silent = !emu.silent; })}>Обрыв</button>
    </div>
  );
}

function ConnectButtons() {
  const status = useApp((s) => s.status);
  const busy = status === 'opening' || status === 'waiting';
  if (status !== 'disconnected')
    return <button className="btn" disabled={status === 'opening'} onClick={() => disconnect()}>Отключить</button>;
  return (
    <>
      <button className="btn" disabled={busy} onClick={() => connectDemo()}>Демо</button>
      <button className="btn primary" disabled={busy} onClick={() => connectSerial()} title={isSerialSupported() ? 'Выбрать COM-порт (USB-UART или Bluetooth), 115200 бод' : 'Нужен браузер Chrome или Edge'}>Подключить ECU</button>
    </>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={'toast ' + t.kind} onClick={() => dismissToast(t.id)}>{t.text}</div>)}
    </div>
  );
}

function BusyOverlay() {
  const busy = useApp((s) => s.busy);
  if (!busy) return null;
  const pct = busy.total ? Math.round((busy.done / busy.total) * 100) : 0;
  return (
    <div className="overlay">
      <div className="dialog" role="alert" aria-busy="true">
        <h2>{busy.label}</h2>
        <p style={{ marginBottom: 0 }}>{busy.done} из {busy.total}. Не отключайте питание ECU.</p>
        <div className="progress"><i style={{ width: pct + '%' }} /></div>
      </div>
    </div>
  );
}

export function App() {
  const page = useApp((s) => s.page);
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) { if (canRedo()) redo(); } else if (canUndo()) undo(); }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); if (canRedo()) redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  let group = '';
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><div className="brand-mark">В30</div><div><b>Вихрь-30 EFI</b><span>настройка впрыска</span></div></div>
        <nav className="nav" aria-label="Разделы">
          {PAGES.map((p) => {
            const head = p.group !== group ? <div className="nav-group" key={'g' + p.group}>{p.group}</div> : null;
            group = p.group;
            return [head, <button key={p.id} className={p.id === current.id ? 'active' : ''} aria-current={p.id === current.id ? 'page' : undefined} title={p.title} onClick={() => setPage(p.id)}>{p.icon}<span>{p.title}</span></button>];
          })}
        </nav>
        <div className="side-foot">Программа 2.0 · прошивки v0.8 и v0.9</div>
      </aside>
      <header className="top">
        <div className="top-chips"><StatusChips /></div>
        <div className="spacer" />
        <div className="top-actions"><DemoPanel /><ConnectButtons /></div>
      </header>
      <main className="app-main" key={current.id}>{current.view()}</main>
      <Toasts />
      <BusyOverlay />
      <ConfirmHost />
    </div>
  );
}
