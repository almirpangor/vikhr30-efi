// Параметры: 18 калибровок ECU с проверкой и записью.
import { useEffect, useState } from 'react';
import { PARAMS, type ParamDef } from '../core/types';
import { canMutate, homeIac, loadDefaults, readAll, revertParams, saveFlash, setParam, useApp, validateParams, writeParams } from '../core/store';
import { PageHead, Seg, confirmDialog, fmt, DASH } from '../ui/kit';
import './Service.css';

const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Зажигание', keys: ['trigger_trim_tenths', 'dwell_us', 'fixed_ign_tenths'] },
  { title: 'Топливо', keys: ['injector_deadtime_us', 'fuel_scale_permille'] },
  { title: 'Дроссель', keys: ['tps_min_raw', 'tps_max_raw'] },
  { title: 'Отсечка', keys: ['rev_limit_soft', 'rev_limit_hard'] },
  { title: 'Холостой ход', keys: ['iac_max_steps', 'iac_crank_steps', 'iac_hot_steps', 'iac_target_rpm', 'iac_direction'] },
  { title: 'Лямбда', keys: ['o2_heater_duty_pct', 'o2_mode', 'wideband_lambda_min_milli', 'wideband_lambda_max_milli'] },
];
const SEG: Record<string, { value: string; label: string }[]> = {
  iac_direction: [{ value: '1', label: 'Прямое (1)' }, { value: '-1', label: 'Обратное (−1)' }],
  o2_mode: [{ value: '0', label: 'Узкополосный (0)' }, { value: '1', label: 'Широкополосный (1)' }],
};
const UNITS: Record<string, string> = { ADC: 'отсчёты АЦП', '−1 / 1': '', '0 NB / 1 WB': '' };

const parse = (text: string): number => {
  const s = text.trim().replace('−', '-');
  return /^-?\d+$/.test(s) ? Number(s) : NaN;
};
const show = (v: number) => (Number.isFinite(v) ? String(v) : '');
const rowError = (p: ParamDef, v: number): string => {
  if (!Number.isInteger(v)) return 'Нужно целое число.';
  if (v < p.min || v > p.max) return `Допустимо от ${fmt(p.min)} до ${fmt(p.max)}.`;
  return '';
};

function NumberField({ p, value, invalid }: { p: ParamDef; value: number; invalid: boolean }) {
  const [text, setText] = useState(show(value));
  // Значение поменяли снаружи (чтение из ECU, возврат, «Взять текущее») — показать его.
  useEffect(() => { if (Number.isFinite(value) && parse(text) !== value) setText(show(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input className={'input' + (invalid ? ' invalid' : '')} inputMode="numeric" value={text} aria-label={p.label} aria-invalid={invalid}
      onChange={(e) => { setText(e.target.value); setParam(p.key, parse(e.target.value)); }} />
  );
}

export default function ParamsPage() {
  const params = useApp((s) => s.params);
  const ecu = useApp((s) => s.ecuParams);
  const loaded = useApp((s) => s.paramsLoaded);
  const live = useApp((s) => s.live);
  const unsaved = useApp((s) => s.unsaved);
  const tpsRaw = useApp((s) => s.telemetry?.tpsRaw ?? 0);
  // подписка на то, от чего зависит canMutate()
  useApp((s) => s.status); useApp((s) => (s.telemetry?.rpm ?? 0) > 0); useApp((s) => s.telemetry?.service); // только смена состояния, а не каждый кадр телеметрии

  const lock = canMutate();
  const problems = validateParams(params);
  const changed = PARAMS.filter((p) => params[p.key] !== ecu[p.key]);
  const writeWhy = lock ?? (problems.length ? 'Исправьте ошибки в значениях.' : !changed.length ? 'Отличий от ECU нет.' : null);
  const byKey = Object.fromEntries(PARAMS.map((p) => [p.key, p]));
  const listed = new Set(GROUPS.flatMap((g) => g.keys));
  const groups = [...GROUPS, { title: 'Прочее', keys: PARAMS.filter((p) => !listed.has(p.key)).map((p) => p.key) }].filter((g) => g.keys.some((k) => byKey[k]));

  return (
    <div className="page">
      <PageHead title="Параметры" sub="Калибровки ECU. Запись возможна при остановленном двигателе и установленной перемычке SERVICE.">
        <div className="par-actions">
          <button className="btn" disabled={!live} title={live ? 'Прочитать карты и параметры заново' : 'ECU не подключён.'} onClick={() => readAll()}>Прочитать из ECU</button>
          <button className="btn primary" disabled={!!writeWhy} title={writeWhy ?? 'Записать изменённые параметры в RAM ECU со сверкой'} onClick={() => writeParams()}>
            Записать в ECU{changed.length ? ` (${changed.length})` : ''}
          </button>
          <button className={'btn' + (unsaved ? ' on' : '')} disabled={!!lock} title={lock ?? 'Сохранить калибровки из RAM ECU во Flash'}
            onClick={async () => { if (await confirmDialog('Сохранить во Flash?', 'Карты и параметры из оперативной памяти ECU будут записаны во Flash и останутся после выключения питания. Не отключайте питание до сообщения об успехе.', 'Сохранить')) saveFlash(); }}>
            Сохранить во Flash
          </button>
          <button className="btn" disabled={!changed.length} title={changed.length ? 'Отменить несохранённые правки' : 'Отличий от ECU нет.'} onClick={() => revertParams()}>Вернуть как в ECU</button>
        </div>
      </PageHead>

      {!loaded && <div className="banner info">Параметры ещё не прочитаны из ECU — показаны заводские значения прошивки. Подключите ECU или включите «Демо».</div>}
      {loaded && lock && <div className="banner warn">Запись недоступна: {lock}</div>}
      {unsaved && <div className="banner info">В оперативной памяти ECU есть изменения, не сохранённые во Flash. После выключения питания они пропадут.</div>}
      {problems.length > 0 && (
        <div className="banner danger par-problems" role="alert">
          <b>Запись невозможна, пока не исправлено:</b>
          <ul>{problems.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      )}

      <div className="card flush">
        <table className="tbl par-table">
          <thead><tr><th>Параметр</th><th>Значение</th><th>Единицы</th><th>Диапазон</th><th className="par-nowrap">В ECU</th><th>Пояснение</th></tr></thead>
          <tbody>
            {groups.map((g) => [
              <tr key={g.title} className="par-group"><td colSpan={6}><h3>{g.title}</h3></td></tr>,
              ...g.keys.filter((k) => byKey[k]).map((k) => {
                const p = byKey[k], v = params[k], err = rowError(p, v), diff = v !== ecu[k];
                const isTps = k === 'tps_min_raw' || k === 'tps_max_raw';
                return (
                  <tr key={k} className={diff ? 'par-changed' : ''}>
                    <td><div className="par-name">{p.label}</div><div className="par-key">{k}</div></td>
                    <td>
                      <div className="par-field">
                        {SEG[k]
                          ? <Seg label={p.label} value={String(v)} options={SEG[k]} onChange={(x) => setParam(k, Number(x))} />
                          : <NumberField p={p} value={v} invalid={!!err} />}
                        {isTps && <button className="btn sm" disabled={!live} title={live ? `Подставить текущее значение АЦП: ${tpsRaw}` : 'Нет связи с ECU.'} onClick={() => setParam(k, tpsRaw)}>Взять текущее</button>}
                      </div>
                      {isTps && <div className="par-sub">Сейчас на датчике: <span className={'num ' + (live ? '' : 'nodata')}>{live ? tpsRaw : DASH}</span></div>}
                      {err && <div className="par-err" role="alert">{err}</div>}
                    </td>
                    <td className="par-nowrap muted">{UNITS[p.units] ?? p.units}</td>
                    <td className="num par-nowrap muted">{fmt(p.min)} … {fmt(p.max)}</td>
                    <td className="par-ecu">{loaded ? fmt(ecu[k]) : <span className="nodata">{DASH}</span>}{diff && <span className="tag warn">изменено</span>}</td>
                    <td className="par-help">{p.help}{p.volatile && <> <b>Не хранится во Flash: действует до перезапуска ECU, затем снова −1 (работа по карте).</b></>}</td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-title"><h3>Служебные действия</h3></div>
        <div className="row">
          <button className="btn" disabled={!!lock} title={lock ?? 'РХХ уйдёт в нулевое положение и вернётся в рабочее'} onClick={() => homeIac()}>Калибровать РХХ</button>
          <button className="btn danger" disabled={!!lock} title={lock ?? 'Загрузить заводские карты и параметры в RAM ECU'}
            onClick={async () => { if (await confirmDialog('Вернуть заводские калибровки?', 'Топливная карта, карта зажигания и все параметры в оперативной памяти ECU будут заменены заводскими. Ваши настройки во Flash сохранятся до тех пор, пока вы не нажмёте «Сохранить во Flash».', 'Загрузить заводские', true)) loadDefaults(); }}>
            Заводские калибровки
          </button>
          {lock && <span className="par-why">{lock}</span>}
        </div>
      </div>
    </div>
  );
}
