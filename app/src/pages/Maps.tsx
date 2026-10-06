// Страницы «Карта топлива» и «Карта зажигания»: одна компонента с параметром вида карты.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './Maps.css';
import { clamp, diffCells, lookupMap, mapToCsv, parseMapCsv, workPoint } from '../core/calc';
import { canMutate, canRedo, canUndo, downloadText, editMaps, readAll, redo, revertMaps, saveFlash, toast, undo, useApp, writeMaps } from '../core/store';
import { FUEL_LIMITS, IGN_LIMITS, LOAD_BINS, LOAD_COUNT, RPM_BINS, RPM_COUNT, type MapTable } from '../core/types';
import { PageHead, Viewport3D, confirmDialog, fmt } from '../ui/kit';
import { HEAT_CSS, heatColor, heatInk, heatT, mapRange, setupSurface, type SurfaceHandle, type SurfaceRect } from '../scenes/surface';

interface Kind {
  id: 'fuel' | 'ign';
  title: string;
  sub: string;
  other: string;          // название второй карты (в родительном падеже)
  limits: { min: number; max: number };
  step: number;           // шаг правки в единицах хранения
  fine: number;           // мелкий шаг (0 — нет)
  quant: number;          // к чему округлять результат ввода и расчётов
  scale: number;          // единиц хранения в одной отображаемой
  digits: number;
  unit: string;
  raw: (v: number) => string; // значение в единицах хранения для подсказки
  csvScale: number;
  csvDigits: number;
  file: string;
}
const FUEL: Kind = {
  id: 'fuel', title: 'Карта топлива', other: 'зажигания',
  sub: 'Длительность импульса форсунки, мс (в ECU хранится в микросекундах). Строки — положение дросселя TPS, столбцы — обороты.',
  limits: FUEL_LIMITS, step: 10, fine: 0, quant: 10, scale: 1000, digits: 2, unit: 'мс', raw: (v) => `${v} мкс`, csvScale: 1, csvDigits: 0, file: 'vikhr30-fuel.csv',
};
const IGN: Kind = {
  id: 'ign', title: 'Карта зажигания', other: 'топлива',
  sub: 'Угол опережения зажигания, градусы до ВМТ (в ECU хранится с точностью 0,1°). Строки — положение дросселя TPS, столбцы — обороты.',
  limits: IGN_LIMITS, step: 5, fine: 1, quant: 1, scale: 10, digits: 1, unit: '°', raw: () => '', csvScale: 10, csvDigits: 1, file: 'vikhr30-ign.csv',
};

interface Sel { ar: number; ac: number; fr: number; fc: number } // якорь и текущая ячейка
const rectOf = (s: Sel): SurfaceRect => ({ r0: Math.min(s.ar, s.fr), r1: Math.max(s.ar, s.fr), c0: Math.min(s.ac, s.fc), c1: Math.max(s.ac, s.fc) });
const parseNum = (text: string): number => {
  const t = text.trim().replace(/\s/g, '').replace(',', '.').replace('−', '-');
  return t === '' ? NaN : Number(t);
};
/** Внутренний буфер программы — свой для каждой карты. */
const clipboards: Record<string, number[][] | null> = { fuel: null, ign: null };

function NowLine({ kind }: { kind: Kind }) {
  const live = useApp((s) => s.live), status = useApp((s) => s.status), t = useApp((s) => s.telemetry);
  const map = useApp((s) => s[kind.id]), ecu = useApp((s) => (kind.id === 'fuel' ? s.ecuFuel : s.ecuIgn));
  const u = kind.unit === '°' ? '°' : ' ' + kind.unit;
  if (!live || !t) return <span className="maps-now nodata">{status === 'lost' ? 'Нет ответа ECU' : 'Нет связи'}</span>;
  if (t.rpm <= 0) return <span className="maps-now muted">Двигатель стоит</span>;
  const v = lookupMap(map, t.rpm, t.tps10), e = lookupMap(ecu, t.rpm, t.tps10);
  return (
    <span className="maps-now">
      <span className="muted">Сейчас: </span><b>{t.rpm}</b> об/мин, TPS <b>{fmt(t.tps10 / 10, 1)}</b> % → по карте <b>{fmt(v / kind.scale, kind.digits)}</b>{u}
      {e !== v ? <span className="muted"> (в ECU пока {fmt(e / kind.scale, kind.digits)}{u})</span> : null}
    </span>
  );
}

function MapPage({ kind }: { kind: Kind }) {
  const map = useApp((s) => s[kind.id]);
  const ecu = useApp((s) => (kind.id === 'fuel' ? s.ecuFuel : s.ecuIgn));
  const otherMap = useApp((s) => (kind.id === 'fuel' ? s.ign : s.fuel));
  const otherEcu = useApp((s) => (kind.id === 'fuel' ? s.ecuIgn : s.ecuFuel));
  const status = useApp((s) => s.status), mapsLoaded = useApp((s) => s.mapsLoaded), busy = useApp((s) => !!s.busy);
  const why = useApp(() => canMutate());
  const wpKey = useApp((s) => (s.live && s.telemetry && s.telemetry.rpm > 0
    ? workPoint(s.telemetry.rpm, s.telemetry.tps10).cells.map((c) => c.row + ':' + c.col).join(',') : ''));

  const [sel, setSel] = useState<Sel>({ ar: 0, ac: 0, fr: 0, fc: 0 });
  const [edit, setEdit] = useState<{ r: number; c: number; text: string } | null>(null);
  const [pct, setPct] = useState('3');
  const [setText, setSetText] = useState('');
  const [, bump] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null), fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef(false);
  const editRef = useRef(edit);
  editRef.current = edit;
  const sceneRef = useRef<SurfaceHandle | null>(null);
  const rect = rectOf(sel);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const show = (v: number) => fmt(v / kind.scale, kind.digits);
  const u = kind.unit === '°' ? '°' : ' ' + kind.unit;
  const fit = (v: number) => clamp(Math.round(v), kind.limits.min, kind.limits.max);
  const quant = (v: number) => fit(Math.round(v / kind.quant) * kind.quant);
  const online = status === 'online';

  const diff = useMemo(() => new Set(diffCells(map, ecu).map((d) => d.row + ':' + d.col)), [map, ecu]);
  const otherDiff = useMemo(() => diffCells(otherMap, otherEcu).length, [otherMap, otherEcu]);
  const totalDiff = diff.size + otherDiff;
  const range = useMemo(() => mapRange(map), [map]);
  const wpCells = wpKey ? wpKey.split(',') : [];

  const stats = useMemo(() => {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) { const v = map[r][c]; min = Math.min(min, v); max = Math.max(max, v); sum += v; n++; }
    return { min, max, mean: sum / n, n };
  }, [map, rect.r0, rect.r1, rect.c0, rect.c1]);

  // ---- операции над выделением (каждая — один шаг отмены) ----
  const apply = (fn: (m: MapTable, r: SurfaceRect) => void) => editMaps((f, i) => fn(kind.id === 'fuel' ? f : i, rectRef.current));
  const each = (m: MapTable, r: SurfaceRect, fn: (v: number, row: number, col: number) => number) => {
    for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) m[row][col] = fn(m[row][col], row, col);
  };
  const stepBy = (delta: number) => apply((m, r) => each(m, r, (v) => fit(v + delta)));
  const scaleBy = (sign: number) => {
    const p = parseNum(pct);
    if (!Number.isFinite(p) || p <= 0 || p > 50) { toast('error', 'Процент: введите число больше 0 и не больше 50.'); return; }
    apply((m, r) => each(m, r, (v) => quant(v * (1 + (sign * p) / 100))));
  };
  const setAll = () => {
    const x = parseNum(setText);
    if (!Number.isFinite(x)) { toast('error', `«Задать значение»: введите число, например ${show(stats.min)}.`); return; }
    const v = quant(x * kind.scale);
    if (Math.abs(v - x * kind.scale) > kind.quant) toast('info', `Значение ограничено пределом: ${show(v)}${u} (допустимо от ${show(kind.limits.min)} до ${show(kind.limits.max)}).`);
    apply((m, r) => each(m, r, () => v));
  };
  const smooth = () => apply((m, r) => {
    const src = m.map((row) => row.slice());
    each(m, r, (_v, row, col) => {
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const y = row + dr, x = col + dc;
        if (y >= 0 && y < LOAD_COUNT && x >= 0 && x < RPM_COUNT) { sum += src[y][x]; n++; }
      }
      return quant(sum / n);
    });
  });
  const interpolate = () => apply((m, r) => {
    const a00 = m[r.r0][r.c0], a01 = m[r.r0][r.c1], a10 = m[r.r1][r.c0], a11 = m[r.r1][r.c1];
    each(m, r, (_v, row, col) => {
      const fx = r.c1 === r.c0 ? 0 : (RPM_BINS[col] - RPM_BINS[r.c0]) / (RPM_BINS[r.c1] - RPM_BINS[r.c0]);
      const fy = r.r1 === r.r0 ? 0 : (LOAD_BINS[row] - LOAD_BINS[r.r0]) / (LOAD_BINS[r.r1] - LOAD_BINS[r.r0]);
      const top = a00 + (a01 - a00) * fx, bot = a10 + (a11 - a10) * fx;
      return quant(top + (bot - top) * fy);
    });
  });
  const copy = () => {
    const r = rectRef.current, out: number[][] = [];
    for (let row = r.r0; row <= r.r1; row++) out.push(map[row].slice(r.c0, r.c1 + 1));
    clipboards[kind.id] = out;
    bump((n) => n + 1);
  };
  const paste = () => {
    const buf = clipboards[kind.id];
    if (!buf) return;
    const r0 = rectRef.current.r0, c0 = rectRef.current.c0;
    apply((m) => {
      for (let y = 0; y < buf.length && r0 + y < LOAD_COUNT; y++)
        for (let x = 0; x < buf[y].length && c0 + x < RPM_COUNT; x++) m[r0 + y][c0 + x] = fit(buf[y][x]);
    });
    setSel({ ar: r0, ac: c0, fr: Math.min(LOAD_COUNT - 1, r0 + buf.length - 1), fc: Math.min(RPM_COUNT - 1, c0 + buf[0].length - 1) });
  };
  const buf = clipboards[kind.id];

  // ---- правка в ячейке ----
  const startEdit = (text?: string) => setEdit({ r: sel.fr, c: sel.fc, text: text ?? show(map[sel.fr][sel.fc]) });
  const finishEdit = (commit: boolean) => {
    const e = editRef.current;
    if (!e) return;
    editRef.current = null;
    setEdit(null);
    gridRef.current?.focus();
    if (!commit) return;
    const x = parseNum(e.text);
    if (!Number.isFinite(x)) { toast('error', `«${e.text}» — не число. Значение ячейки не изменено.`); return; }
    const v = quant(x * kind.scale);
    if (Math.abs(v - x * kind.scale) > kind.quant) toast('info', `Значение ограничено пределом: ${show(v)}${u} (допустимо от ${show(kind.limits.min)} до ${show(kind.limits.max)}).`);
    editMaps((f, i) => { (kind.id === 'fuel' ? f : i)[e.r][e.c] = v; });
  };

  // ---- клавиатура ----
  const onKey = (e: React.KeyboardEvent) => {
    if (edit) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const fr = clamp(sel.fr + dr, 0, LOAD_COUNT - 1), fc = clamp(sel.fc + dc, 0, RPM_COUNT - 1);
      setSel(e.shiftKey ? { ...sel, fr, fc } : { ar: fr, ac: fc, fr, fc });
    };
    if (e.key === 'ArrowUp') return move(-1, 0);
    if (e.key === 'ArrowDown') return move(1, 0);
    if (e.key === 'ArrowLeft') return move(0, -1);
    if (e.key === 'ArrowRight') return move(0, 1);
    if (ctrl && e.code === 'KeyA') { e.preventDefault(); setSel({ ar: 0, ac: 0, fr: LOAD_COUNT - 1, fc: RPM_COUNT - 1 }); return; }
    if (ctrl && e.code === 'KeyC') { e.preventDefault(); copy(); return; }
    if (ctrl && e.code === 'KeyV') { e.preventDefault(); paste(); return; }
    if (ctrl || e.altKey && !/^(Equal|Minus|NumpadAdd|NumpadSubtract)$/.test(e.code)) return;
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return; } // стирать ячейки нельзя
    if (e.key === 'Escape') { setSel({ ar: sel.fr, ac: sel.fc, fr: sel.fr, fc: sel.fc }); return; }
    const plus = e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+' || e.key === '=';
    const minus = e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_';
    if (plus || minus) {
      e.preventDefault();
      const size = e.altKey && kind.fine ? kind.fine : kind.step * (e.shiftKey ? 10 : 1);
      stepBy(plus ? size : -size);
      return;
    }
    if (/^[0-9.,]$/.test(e.key)) { e.preventDefault(); startEdit(e.key === '.' ? ',' : e.key); }
  };

  // ---- мышь ----
  useEffect(() => {
    const up = () => { dragRef.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  const cellDown = (r: number, c: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (edit) finishEdit(true);
    gridRef.current?.focus();
    dragRef.current = true;
    setSel((s) => (e.shiftKey ? { ...s, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c }));
  };
  // После щелчка мышью по кнопке панели возвращаем фокус таблице, чтобы клавиши + / − и стрелки продолжали работать.
  // Нажатие кнопки с клавиатуры (detail = 0) фокус не трогает — иначе сбивался бы обход по Tab.
  const refocus = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if ((e.nativeEvent as MouseEvent).detail > 0 && el.closest('button')) gridRef.current?.focus();
  };
  const cellEnter = (r: number, c: number) => { if (dragRef.current) setSel((s) => (s.fr === r && s.fc === c ? s : { ...s, fr: r, fc: c })); };

  // ---- действия с ECU и файлами ----
  const onRead = async () => {
    gridRef.current?.focus(); // диалог после закрытия вернёт фокус сюда, а не на кнопку
    if (totalDiff > 0 && !(await confirmDialog('Прочитать карты из ECU?', `В программе есть правки, не записанные в ECU (ячеек: ${totalDiff}). После чтения обе карты будут заменены значениями из ECU.`, 'Прочитать', true))) return;
    readAll();
  };
  const onFlash = async () => {
    gridRef.current?.focus();
    const extra = totalDiff > 0 ? ` Внимание: в программе есть правки, не записанные в ECU (ячеек: ${totalDiff}), — во Flash они не попадут. Сначала нажмите «Записать в ECU».` : '';
    if (await confirmDialog('Сохранить во Flash?', 'Калибровки, которые сейчас находятся в оперативной памяти ECU, будут записаны в постоянную память и останутся после выключения питания.' + extra, 'Сохранить')) saveFlash();
  };
  const onExport = () => downloadText(kind.file, mapToCsv(map, kind.csvScale, kind.csvDigits));
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = parseMapCsv(await file.text(), kind.csvScale);
      let cut = 0;
      const next = parsed.map((row) => row.map((v) => { const f = fit(v); if (f !== v) cut++; return f; }));
      const changed = diffCells(next, map).length;
      editMaps((f, i) => { const m = kind.id === 'fuel' ? f : i; for (let r = 0; r < LOAD_COUNT; r++) m[r] = next[r].slice(); });
      toast('ok', `Файл «${file.name}» загружен в карту: изменено ячеек — ${changed}.` + (cut ? ` Обрезано по пределам (${show(kind.limits.min)}…${show(kind.limits.max)}${u}): ${cut}.` : ''));
    } catch (err) {
      toast('error', `Импорт CSV («${file.name}»): ` + (err instanceof Error ? err.message : String(err)));
    }
  };

  const setup = useCallback((viewer: Parameters<typeof setupSurface>[0], host: HTMLDivElement) => {
    const h = setupSurface(viewer, host, {
      kind: kind.id, unit: kind.unit === '°' ? '°' : ' ' + kind.unit, format: (v) => fmt(v / kind.scale, kind.digits),
      getSelection: () => rectRef.current,
      onPick: (r, c, extend) => setSel((s) => (extend ? { ...s, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c })),
    });
    sceneRef.current = h;
    return () => { sceneRef.current = null; h.dispose(); };
  }, [kind]);

  const writeTitle = why ?? (totalDiff === 0 ? 'Отличий от ECU нет — записывать нечего.' : 'Записать обе карты в оперативную память ECU со сверкой');
  const single = stats.n === 1;
  const stepText = show(kind.step) + u;

  return (
    <div className="page fill maps-page">
      <PageHead title={kind.title} sub={kind.sub}>
        <div className="maps-actions" onClick={refocus}>
          <button className="btn sm" disabled={!online || busy} title={online ? 'Прочитать обе карты и параметры из ECU' : 'ECU не подключён.'} onClick={onRead}>Прочитать из ECU</button>
          <span title={writeTitle}><button className="btn sm primary" disabled={!!why || totalDiff === 0 || busy} title={writeTitle} onClick={() => writeMaps()}>Записать в ECU</button></span>
          <span title={why ?? 'Сохранить калибровки из оперативной памяти ECU во Flash'}><button className="btn sm" disabled={!!why || busy} onClick={onFlash}>Сохранить во Flash</button></span>
          <i className="sep" />
          <button className="btn sm" disabled={!canUndo()} title="Отменить последнюю правку (Ctrl+Z)" onClick={() => undo()}>Отменить</button>
          <button className="btn sm" disabled={!canRedo()} title="Повторить отменённую правку (Ctrl+Y)" onClick={() => redo()}>Повторить</button>
          <button className="btn sm" disabled={totalDiff === 0} title="Отбросить правки: обе карты снова станут такими, как в ECU (можно отменить)" onClick={() => revertMaps()}>Вернуть как в ECU</button>
          <i className="sep" />
          <button className="btn sm" title="Загрузить карту из файла CSV (формат прежней программы)" onClick={() => fileRef.current?.click()}>Импорт CSV</button>
          <button className="btn sm" title="Сохранить карту в файл CSV (формат прежней программы)" onClick={onExport}>Экспорт CSV</button>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={onImport} aria-label="Файл CSV для импорта" />
        </div>
      </PageHead>

      {!mapsLoaded && !online && (
        <div className="banner info">Нет связи с ECU: показаны стартовые карты. Правки можно готовить заранее и записать после подключения.</div>
      )}

      <div className="maps-info">
        <NowLine kind={kind} />
        <div className="spacer" />
        {online && why && totalDiff > 0 ? <span className="maps-why">Запись недоступна: {why}</span> : null}
        <span className={'tag ' + (diff.size ? 'warn' : '')} title="Сколько ячеек этой карты отличается от того, что сейчас в ECU">Изменено ячеек: <b className="num maps-diff-count">{diff.size}</b></span>
        {otherDiff ? <span className="tag warn">и ещё {otherDiff} в карте {kind.other}</span> : null}
      </div>

      <div className="maps-grid" ref={gridRef} tabIndex={0} role="grid" aria-label={kind.title + ': таблица, правка с клавиатуры'} onKeyDown={onKey}>
        <table className="maps-tbl">
          <thead>
            <tr>
              <th className="corner">TPS % \ об/мин</th>
              {RPM_BINS.map((rpm, c) => <th key={c} className={c >= rect.c0 && c <= rect.c1 ? 'hot' : ''}>{rpm}</th>)}
            </tr>
          </thead>
          <tbody>
            {map.map((row, r) => (
              <tr key={r}>
                <th className={r >= rect.r0 && r <= rect.r1 ? 'hot' : ''}>{LOAD_BINS[r] / 10} %</th>
                {row.map((v, c) => {
                  const rgb = heatColor(heatT(v, range.min, range.max));
                  const inSel = r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
                  const isDiff = diff.has(r + ':' + c), wpi = wpCells.indexOf(r + ':' + c);
                  const cls = (inSel ? 'sel' + (r === rect.r0 ? ' sel-t' : '') + (r === rect.r1 ? ' sel-b' : '') + (c === rect.c0 ? ' sel-l' : '') + (c === rect.c1 ? ' sel-r' : '') : '')
                    + (r === sel.fr && c === sel.fc && stats.n > 1 ? ' cur' : '') + (isDiff ? ' diff' : '');
                  const rawText = kind.raw(v);
                  const tip = `${RPM_BINS[c]} об/мин, TPS ${LOAD_BINS[r] / 10} %: ${show(v)}${u}` + (rawText ? ` (${rawText})` : '') + (isDiff ? `; в ECU: ${show(ecu[r][c])}${u}` : '');
                  const editing = edit && edit.r === r && edit.c === c;
                  return (
                    <td key={c} className={cls} data-r={r} data-c={c} data-v={v} title={tip} style={{ background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`, color: heatInk(rgb) }}
                      onMouseDown={(e: React.MouseEvent) => cellDown(r, c, e)} onMouseEnter={() => cellEnter(r, c)} onDoubleClick={() => setEdit({ r, c, text: show(v) })}>
                      <span>{show(v)}</span>
                      {wpi >= 0 ? <i className={'maps-wp' + (wpi === 0 ? ' lead' : '')} /> : null}
                      {editing ? (
                        <input className="maps-edit" autoFocus value={edit!.text} inputMode="decimal" aria-label="Новое значение ячейки"
                          onFocus={(e: React.SyntheticEvent<HTMLInputElement>) => { if (edit!.text.length > 1) e.currentTarget.select(); }}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEdit({ r, c, text: e.target.value })}
                          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
                          onKeyDown={(e: React.KeyboardEvent) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
                            else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
                          }}
                          onBlur={() => finishEdit(true)} />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="maps-bottom">
        <div className="card maps-tools" onClick={refocus}>
          <div className="maps-stat">
            Выделено: <b>{stats.n}</b> {plural(stats.n)}, <b>{show(stats.min)}</b>…<b>{show(stats.max)}</b>{u}, среднее <b>{fmt(stats.mean / kind.scale, kind.digits)}</b>{u}
          </div>
          <div className="row">
            <button className="btn sm" title={`Уменьшить выделенные на ${stepText} (клавиша −; с Shift — на 10 шагов)`} onClick={() => stepBy(-kind.step)}>− шаг</button>
            <button className="btn sm" title={`Увеличить выделенные на ${stepText} (клавиша +; с Shift — на 10 шагов)`} onClick={() => stepBy(kind.step)}>+ шаг</button>
            <span className="lbl">шаг {stepText}</span>
            {kind.fine ? (
              <>
                <button className="btn sm" title="Мелкий шаг (Alt и клавиша −)" onClick={() => stepBy(-kind.fine)}>− {show(kind.fine)}{u}</button>
                <button className="btn sm" title="Мелкий шаг (Alt и клавиша +)" onClick={() => stepBy(kind.fine)}>+ {show(kind.fine)}{u}</button>
              </>
            ) : null}
          </div>
          <div className="row">
            <label className="row"><span className="lbl">× %</span>
              <input className="input" value={pct} inputMode="decimal" aria-label="Процент изменения" title="Например, 3: «+%» умножит выделенные на 1,03, «−%» — на 0,97" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPct(e.target.value)} />
            </label>
            <button className="btn sm" title="Уменьшить выделенные на заданный процент" onClick={() => scaleBy(-1)}>−%</button>
            <button className="btn sm" title="Увеличить выделенные на заданный процент" onClick={() => scaleBy(1)}>+%</button>
            <label className="row" style={{ marginLeft: 8 }}><span className="lbl">Значение, {kind.unit}</span>
              <input className="input" value={setText} inputMode="decimal" placeholder={show(stats.min)} aria-label={'Значение для выделенных ячеек, ' + kind.unit}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSetText(e.target.value)} onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') setAll(); }} />
            </label>
            <button className="btn sm" title="Записать это значение во все выделенные ячейки" onClick={setAll}>Задать значение</button>
          </div>
          <div className="row">
            <button className="btn sm" title="Каждая выделенная ячейка заменяется средним по себе и соседям (3×3); на краях выделения учитываются соседи вне его" onClick={smooth}>Сгладить</button>
            <button className="btn sm" disabled={single} title={single ? 'Выделите диапазон: строку, столбец или прямоугольник.' : 'Заполнить выделение плавным переходом между угловыми ячейками (для строки или столбца — между концами), с учётом шага оборотов и TPS'} onClick={interpolate}>Интерполировать</button>
            <button className="btn sm" title="Скопировать выделение во внутренний буфер программы (Ctrl+C)" style={{ marginLeft: 8 }} onClick={copy}>Копировать</button>
            <button className="btn sm" disabled={!buf} title={buf ? 'Вставить из буфера, начиная с левой верхней выделенной ячейки (Ctrl+V)' : 'Буфер пуст: сначала «Копировать».'} onClick={paste}>Вставить</button>
            <span className="lbl">{buf ? `в буфере ${buf.length}×${buf[0].length}` : ''}</span>
          </div>
          <div className="maps-legend" aria-label="Цветовая шкала">
            <b>{show(range.min)}{u}</b>
            <div className="bar" style={{ background: HEAT_CSS }} />
            <b>{show(range.max)}{u}</b>
          </div>
          <div className="maps-keys">
            <span className="kbd">←↑↓→</span> перемещение · <span className="kbd">Shift</span> диапазон · <span className="kbd">Enter</span>/<span className="kbd">F2</span>/цифры — правка · <span className="kbd">+</span> <span className="kbd">−</span> шаг (с <span className="kbd">Shift</span> ×10) · <span className="kbd">Ctrl+A</span> всё.
            Белый уголок — ячейка отличается от ECU.
          </div>
        </div>
        <Viewport3D className="maps-view" setup={setup}>
          <span className="maps-hint">Щелчок по столбику выбирает ячейку</span>
          <button className="btn sm maps-reset" onClick={() => sceneRef.current?.resetView()}>Сбросить вид</button>
        </Viewport3D>
      </div>
    </div>
  );
}

function plural(n: number): string {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? 'ячейка' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'ячейки' : 'ячеек';
}

export function FuelMapPage() { return <MapPage kind={FUEL} />; }
export function IgnMapPage() { return <MapPage kind={IGN} />; }
