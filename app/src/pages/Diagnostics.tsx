// Диагностика: все поля телеметрии по группам и флаги ошибок.
import type { ReactNode } from 'react';
import { ACTUATOR_TESTS, FAULTS, emptyTelemetry, type Telemetry } from '../core/types';
import { fuelFlowMlMin } from '../core/calc';
import { clearFaults, useApp } from '../core/store';
import { PageHead, fmt, DASH } from '../ui/kit';
import './Service.css';

type Tone = '' | 'ok' | 'warn' | 'danger';
interface Row { name: string; value: string; unit?: string; note: string; tone?: Tone }

const OUTPUTS = ['Катушка 1', 'Катушка 2', 'Форсунка', 'Насос', 'Нагреватель', 'РХХ разрешён'];
const yes = (v: number) => (v ? 'да' : 'нет');
const hms = (ms: number) => {
  const s = Math.floor(ms / 1000), p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
};
const LAMBDA_DIR: Record<string, [string, Tone]> = { '-1': ['богато', ''], '0': ['около стехиометрии', ''], '1': ['бедно', ''], '2': ['нет данных', ''] };

function Group({ title, rows, live, children }: { title: string; rows: Row[]; live: boolean; children?: ReactNode }) {
  return (
    <div className="card">
      <div className="card-title"><h3>{title}</h3></div>
      {children}
      <div className="dg-rows">
        {rows.map((r) => [
          <div key={r.name + 'n'}>{r.name}</div>,
          <div key={r.name + 'v'} className={'dg-val ' + (live ? r.tone ?? '' : 'nodata')}>{live ? r.value : DASH}{live && r.unit ? <small>{r.unit}</small> : null}</div>,
          <div key={r.name + 'd'} className="dg-note">{r.note}</div>,
        ])}
      </div>
    </div>
  );
}

function build(t: Telemetry, live: boolean) {
  const flow = fuelFlowMlMin(t.duty10);
  const dir = LAMBDA_DIR[String(t.lambdaDir)] ?? ['нет данных', ''];
  const test = t.actuatorTest ? ACTUATOR_TESTS.find((d) => d.id === t.actuatorTest)?.title ?? `№ ${t.actuatorTest}` : 'нет';
  const engine: Row[] = [
    { name: 'Обороты', value: fmt(t.rpm), unit: 'об/мин', note: 'По датчику коленвала; при прокрутке должны быть устойчивыми.' },
    { name: 'Пик оборотов', value: fmt(t.peak), unit: 'об/мин', note: 'Наибольшее значение с включения ECU или сброса ошибок.' },
    { name: 'Синхронизация', value: yes(t.sync), tone: t.sync ? 'ok' : t.rpm > 0 ? 'warn' : '', note: '«Да» — пропуск зуба венца 36-1 найден, фаза отслеживается.' },
    { name: 'Номер зуба', value: t.toothIndex === 255 ? DASH : String(t.toothIndex), note: live && t.toothIndex === 255 ? 'Нет синхронизации (ECU передаёт 255).' : 'Текущий зуб после пропуска; 255 — нет синхронизации.' },
    { name: 'Период зуба', value: fmt(t.toothUs), unit: 'мкс', note: 'Сглаженный период обычного зуба венца.' },
  ];
  const sensors: Row[] = [
    { name: 'Дроссель (TPS)', value: fmt(t.tps10 / 10, 1), unit: '%', note: 'Положение заслонки после калибровки.' },
    { name: 'TPS, сырой АЦП', value: String(t.tpsRaw), unit: 'отсч.', note: 'Нужен при калибровке «закрыт / открыт».' },
    { name: 'Давление во впуске (MAP)', value: fmt(t.map10 / 10, 1), unit: 'кПа', note: 'Абсолютное давление.' },
    { name: 'Барометр', value: fmt(t.baro10 / 10, 1), unit: 'кПа', note: 'Опорное давление для поправки топлива.' },
    { name: 'Головка (CHT)', value: fmt(t.cht10 / 10, 1), unit: '°C', tone: t.cht10 > 850 ? 'danger' : '', note: t.cht10 > 850 ? 'Выше 85 °C — перегрев.' : 'Температура головки цилиндров.' },
    { name: 'Воздух (IAT)', value: fmt(t.iat10 / 10, 1), unit: '°C', note: 'Температура воздуха на впуске.' },
    { name: 'Бортсеть', value: fmt(t.batteryMv / 1000, 2), unit: 'В', note: 'По ней поправляются форсунка и накопление.' },
    { name: 'Лямбда-зонд', value: fmt(t.o2Mv), unit: 'мВ', note: live ? `Состояние: ${dir[0]}.` : 'Напряжение датчика и оценка смеси.' },
    { name: 'λ', value: t.lambdaMilli ? fmt(t.lambdaMilli / 1000, 3) : DASH, note: live && t.lambdaMilli ? 'По широкополосному контроллеру.' : 'Число доступно только с широкополосным датчиком.' },
  ];
  const calc: Row[] = [
    { name: 'Впрыск', value: fmt(t.pwUs / 1000, 2), unit: 'мс', note: 'Полная длительность импульса форсунки.' },
    { name: 'Загрузка форсунки', value: fmt(t.duty10 / 10, 1), unit: '%', tone: t.duty10 >= 850 ? 'warn' : '', note: 'Выше 85 % прошивка ограничивает импульс.' },
    { name: 'Расход топлива', value: fmt(flow), unit: 'мл/мин', note: (live ? `${fmt(flow * 0.06, 2)} л/ч — ` : 'Также в л/ч. ') + (live ? 'расчёт' : 'Расчёт') + ' по загрузке форсунки, не измерение.' },
    { name: 'Угол опережения', value: fmt(t.advance10 / 10, 1), unit: '° до ВМТ', note: 'После всех поправок.' },
    { name: 'Накопление', value: fmt(t.preparedDwellUs), unit: 'мкс', note: 'С поправкой по напряжению бортсети.' },
    { name: 'Обогащение при ускорении', value: fmt(t.accelPermille / 10, 1), unit: '%', note: '100 % — добавки нет.' },
    { name: 'Отсечка топлива', value: yes(t.fuelCut), tone: t.fuelCut ? 'warn' : '', note: 'Чека, торможение двигателем или предел оборотов.' },
  ];
  const act: Row[] = [
    { name: 'Маска выходов', value: '0x' + t.outputMask.toString(16).toUpperCase().padStart(2, '0'), note: 'Расшифровка — лампочки выше.' },
    { name: 'РХХ: позиция → цель', value: `${t.iacPos} → ${t.iacTarget}`, unit: 'шаг', note: !live ? 'Текущее и заданное положение клапана.' : t.iacPos === t.iacTarget ? 'Клапан на месте.' : 'Клапан движется к цели.' },
    { name: 'Нагреватель лямбды', value: fmt(t.heater), unit: '%', note: 'Текущая скважность после мягкого старта.' },
    { name: 'Активный тест', value: test, tone: t.actuatorTest ? 'warn' : '', note: !live ? 'Какой тест сейчас выполняется.' : t.actuatorTest ? 'Тестовый выход включён.' : 'Тестовые выходы выключены.' },
  ];
  return { engine, sensors, calc, act };
}

export default function DiagnosticsPage() {
  const t = useApp((s) => s.telemetry);
  const live = useApp((s) => s.live) && !!t;
  const fw = useApp((s) => s.fwVersion);
  const port = useApp((s) => s.portName);
  const frames = useApp((s) => s.frames);
  const connected = useApp((s) => s.status) !== 'disconnected';
  const g = build(t ?? emptyTelemetry(), live);
  const system: Row[] = [
    { name: 'Время работы ECU', value: t ? hms(t.uptimeMs) : DASH, unit: 'чч:мм:сс', note: 'Сбрасывается при отключении питания.' },
    { name: 'Тактирование', value: t?.clockPll ? 'PLL 64 МГц' : 'резерв 8 МГц', tone: t?.clockPll ? 'ok' : 'warn', note: !live ? 'PLL — основной режим; резерв — PLL не запустился.' : t?.clockPll ? 'Основной режим.' : 'PLL не запустился — проверьте плату контроллера.' },
    { name: 'Bluetooth', value: t?.bt ? 'подключён' : 'нет', note: 'Сигнал STATE модуля HC-06 (PB14).' },
    { name: 'Запись разрешена', value: t ? yes(t.service) : DASH, tone: t?.service ? 'ok' : '', note: '«Да», когда стоит перемычка SERVICE и двигатель остановлен.' },
    { name: 'Аварийная чека', value: t?.kill ? 'сработала' : 'в рабочем положении', tone: t?.kill ? 'danger' : 'ok', note: !live ? 'Вход PB12: при срабатывании выходы блокируются.' : t?.kill ? 'Выходы заблокированы (PB12 замкнут на массу).' : 'Блокировки нет.' },
  ];
  const flags = t?.flags ?? 0;
  const activeCount = live ? FAULTS.filter((f) => flags & (1 << f.bit)).length : 0;

  return (
    <div className="page">
      <PageHead title="Диагностика" sub="Всё, что ECU передаёт в телеметрии, с расшифровкой." />
      {!live && <div className="banner info">{connected ? 'ECU не отвечает — значения не показаны.' : 'Нет связи с ECU. Подключите блок или включите «Демо», чтобы увидеть значения.'}</div>}
      <div className="dg-grid">
        <Group title="Двигатель" live={live} rows={g.engine} />
        <Group title="Датчики" live={live} rows={g.sensors} />
        <Group title="Расчёт" live={live} rows={g.calc} />
        <Group title="Исполнительные устройства" live={live} rows={g.act}>
          <div className="dg-lamps" role="list" aria-label="Состояние выходов">
            {OUTPUTS.map((name, bit) => {
              const on = live && !!((t?.outputMask ?? 0) & (1 << bit));
              return <div key={name} role="listitem" className={'dg-lamp' + (on ? ' on' : '')} title={live ? (on ? 'Включён' : 'Выключен') : 'Нет данных'}><i />{name}</div>;
            })}
          </div>
        </Group>
        <div className="card">
          <div className="card-title"><h3>Система</h3></div>
          <div className="dg-rows">
            {system.map((r) => [
              <div key={r.name + 'n'}>{r.name}</div>,
              <div key={r.name + 'v'} className={'dg-val ' + (live ? r.tone ?? '' : 'nodata')}>{live ? r.value : DASH}</div>,
              <div key={r.name + 'd'} className="dg-note">{r.note}</div>,
            ])}
            <div>Версия прошивки</div><div className={'dg-val' + (fw ? '' : ' nodata')}>{fw || DASH}</div><div className="dg-note">Ответ ECU при подключении.</div>
            <div>Порт</div><div className={'dg-val' + (connected && port ? '' : ' nodata')} style={{ whiteSpace: 'normal' }}>{connected && port ? port : DASH}</div><div className="dg-note">Через что идёт связь.</div>
            <div>Принято кадров</div><div className={'dg-val' + (frames ? '' : ' nodata')}>{frames ? fmt(frames) : DASH}</div><div className="dg-note">Счётчик строк телеметрии с запуска программы.</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h3>Ошибки</h3>
          {live ? <span className={'tag ' + (activeCount ? 'danger' : 'ok')}>{activeCount ? `активно: ${activeCount}` : 'нет активных'}</span> : <span className="tag">нет данных</span>}
          {live && <span className="num faint" style={{ fontSize: 12 }}>флаги 0x{flags.toString(16).toUpperCase().padStart(4, '0')}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn sm" disabled={!live} title={live ? 'Сбросить флаги ошибок и пик оборотов' : 'ECU не подключён.'} onClick={() => clearFaults()}>Сбросить ошибки</button>
        </div>
        <div className="dg-faults">
          {FAULTS.map((f) => {
            const on = live && !!(flags & (1 << f.bit));
            const soft = on && f.code === 'O2_INVALID';
            return (
              <div key={f.code} className={'dg-fault' + (on ? (soft ? ' soft' : ' active') : '')}>
                <div>{!live ? <span className="tag">{DASH}</span> : on ? <span className={'tag ' + (soft ? 'warn' : 'danger')}>активна</span> : <span className="tag ok">нет</span>}</div>
                <div><b>{f.title}</b><code>{f.code}</code><p>{f.hint}</p></div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
