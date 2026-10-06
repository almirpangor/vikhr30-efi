// Общие элементы интерфейса.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Viewer } from '../gl/viewer';

/** Диалог подтверждения. Возвращает true, если пользователь согласился. */
let openConfirm: ((q: ConfirmQuery) => void) | null = null;
interface ConfirmQuery { title: string; text: string; okLabel: string; danger?: boolean; resolve: (v: boolean) => void }
export function confirmDialog(title: string, text: string, okLabel = 'Продолжить', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    if (!openConfirm) { resolve(false); return; }
    openConfirm({ title, text, okLabel, danger, resolve });
  });
}

export function ConfirmHost() {
  const [q, setQ] = useState<ConfirmQuery | null>(null);
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // запоминаем, где был фокус, и возвращаем его туда после закрытия диалога
    openConfirm = (query) => { back.current = document.activeElement as HTMLElement | null; setQ(query); };
    return () => { openConfirm = null; };
  }, []);
  useEffect(() => {
    if (q) return;
    const el = back.current;
    back.current = null;
    if (el && el.isConnected && document.activeElement === document.body) el.focus();
  }, [q]);
  useEffect(() => {
    if (!q) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { q.resolve(false); setQ(null); return; }
      if (e.key !== 'Tab') return;
      // модальный диалог: Tab ходит только по его кнопкам и не уходит на страницу под затемнением
      const btns = Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"] button'));
      if (!btns.length) return;
      const i = btns.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [q]);
  if (!q) return null;
  const done = (v: boolean) => { q.resolve(v); setQ(null); };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) done(false); }}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={q.title}>
        <h2>{q.title}</h2>
        <p>{q.text}</p>
        <div className="row">
          <button className="btn" autoFocus onClick={() => done(false)}>Отмена</button>
          <button className={'btn ' + (q.danger ? 'solid-danger' : 'primary')} onClick={() => done(true)}>{q.okLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      <div className="spacer" />
      {children}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'active' : ''} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/**
 * Область с 3D-сценой. setup получает готовый Viewer и возвращает функцию очистки.
 * children рисуются поверх (подписи, кнопки) в слое .hud.
 */
export function Viewport3D({ setup, children, className, style }: { setup: (v: Viewer, host: HTMLDivElement) => void | (() => void); children?: ReactNode; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const host = ref.current!;
    let viewer: Viewer | null = null, cleanup: void | (() => void);
    try {
      viewer = new Viewer(host);
      cleanup = setup(viewer, host);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => { if (cleanup) cleanup(); viewer?.dispose(); };
    // сцена создаётся один раз
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={'viewport3d ' + (className ?? '')} style={style}>
      <div ref={ref} style={{ position: 'absolute', inset: 0 }} />
      {error ? <div className="empty" style={{ position: 'absolute', inset: 0 }}><b>3D недоступно</b><span>{error}</span></div> : <div className="hud">{children}</div>}
    </div>
  );
}

/** Число с запятой как десятичным разделителем. */
export function fmt(v: number, digits = 0): string {
  return v.toFixed(digits).replace('.', ',').replace('-', '−');
}

/** Значок «нет данных». */
export const DASH = '—';
