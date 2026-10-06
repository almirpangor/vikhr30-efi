// Журнал обмена с ECU.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clearLog, downloadText, load, save, setLogPaused, useApp, type LogEntry } from '../core/store';
import { PageHead, Seg } from '../ui/kit';
import './Service.css';

type Filter = 'all' | 'io' | 'errors' | 'app';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' }, { value: 'io', label: 'Команды и ответы' }, { value: 'errors', label: 'Ошибки' }, { value: 'app', label: 'Программа' },
];
const MAX_ROWS = 500;
const DIR = { tx: '→', rx: '←', app: '•' } as const;
const DIR_TITLE = { tx: 'Отправлено в ECU', rx: 'Получено от ECU', app: 'Сообщение программы' } as const;

const isError = (e: LogEntry) => e.kind === 'error' || e.kind === 'err' || e.kind === 'bad' || (e.dir === 'rx' && e.text.startsWith('ERR'));
const p2 = (n: number) => String(n).padStart(2, '0');
function stamp(ms: number) {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export default function LogPage() {
  const log = useApp((s) => s.log);
  const paused = useApp((s) => s.logPaused);
  const [filter, setFilter] = useState<Filter>(() => { const f = load<Filter>('log.filter', 'all'); return FILTERS.some((x) => x.value === f) ? f : 'all'; });
  const [query, setQuery] = useState('');
  const [stick, setStick] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return log.filter((e) => (filter === 'all' || (filter === 'io' ? e.dir !== 'app' : filter === 'app' ? e.dir === 'app' : isError(e))) && (!q || e.text.toLowerCase().includes(q)));
  }, [log, filter, query]);
  const rows = matched.length > MAX_ROWS ? matched.slice(-MAX_ROWS) : matched;

  useLayoutEffect(() => { const el = box.current; if (el && stick) el.scrollTop = el.scrollHeight; }, [rows, stick]);
  useEffect(() => { save('log.filter', filter); }, [filter]);

  const onScroll = () => { const el = box.current; if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24); };
  const saveFile = () => {
    const text = matched.map((e) => `${stamp(e.time)} ${e.dir === 'tx' ? '->' : e.dir === 'rx' ? '<-' : '**'} ${e.text}`).join('\r\n') + '\r\n';
    downloadText(`vikhr30-journal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, text);
  };

  return (
    <div className="page fill">
      <PageHead title="Журнал" sub="Команды, ответы ECU и сообщения программы. Телеметрия сюда не пишется.">
        <div className="lg-tools">
          <button className={'btn' + (paused ? ' on' : '')} aria-pressed={paused} title={paused ? 'Новые строки сейчас не записываются' : 'Остановить запись новых строк'} onClick={() => setLogPaused(!paused)}>{paused ? 'Продолжить' : 'Пауза'}</button>
          <button className="btn" disabled={!log.length} onClick={() => clearLog()}>Очистить</button>
          <button className="btn" disabled={!matched.length} title="Сохранить показанные строки в текстовый файл" onClick={saveFile}>Сохранить в файл</button>
        </div>
      </PageHead>
      <div className="lg-tools">
        <Seg label="Фильтр журнала" value={filter} options={FILTERS} onChange={setFilter} />
        <input className="input" type="search" placeholder="Поиск по тексту" aria-label="Поиск по тексту журнала" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="lg-foot">
          <span>Показано: {rows.length}{matched.length > rows.length ? ` (последние из ${matched.length})` : ''} · всего в журнале: {log.length}</span>
          {paused && <span className="warn">Пауза: новые строки не записываются</span>}
        </span>
      </div>
      <div className="card flush lg-box">
        {rows.length === 0 ? (
          <div className="empty" style={{ flex: 1 }}>
            <b>{log.length ? 'Под фильтр ничего не подходит' : 'Журнал пуст'}</b>
            <span>{log.length ? 'Измените фильтр или строку поиска.' : 'Строки появятся после подключения к ECU: здесь видны все отправленные команды и ответы на них.'}</span>
          </div>
        ) : (
          <div className="lg-scroll" ref={box} onScroll={onScroll} tabIndex={0} role="log" aria-label="Строки журнала">
            {rows.map((e) => (
              <div key={e.n} className={`lg-line lg-${e.dir}` + (isError(e) ? ' lg-error' : '')}>
                <span className="lg-time">{stamp(e.time)}</span>
                <span className="lg-dir" title={DIR_TITLE[e.dir]}>{DIR[e.dir]}</span>
                <span className="lg-text">{e.text}</span>
              </div>
            ))}
          </div>
        )}
        {!stick && rows.length > 0 && <button className="btn sm primary lg-jump" onClick={() => setStick(true)}>↓ К последней строке</button>}
      </div>
    </div>
  );
}
