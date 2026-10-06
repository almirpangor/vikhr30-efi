// Тест исполнительных устройств.
import { useEffect } from 'react';
import { ACTUATOR_TESTS } from '../core/types';
import { canMutate, runTest, selectNet, setPage, stopTests, useApp } from '../core/store';
import { PageHead, confirmDialog } from '../ui/kit';
import './Service.css';

/** Вывод контроллера и цепь на 3D-схеме для каждого теста. */
const WIRING: Record<string, { pin: string; what: string; net: string }> = {
  PUMP: { pin: 'PB11', what: 'реле бензонасоса', net: 'RELAY' },
  INJECTOR: { pin: 'PB10', what: 'ключ форсунки', net: 'INJ' },
  COIL1: { pin: 'PB0', what: 'ключ катушки 1', net: 'COIL1' },
  COIL2: { pin: 'PB1', what: 'ключ катушки 2', net: 'COIL2' },
  IAC_OPEN: { pin: 'PB6–PB9', what: 'драйвер шагового РХХ', net: 'IAC_OUT' },
  IAC_CLOSE: { pin: 'PB6–PB9', what: 'драйвер шагового РХХ', net: 'IAC_OUT' },
  O2_HEATER: { pin: 'PB15', what: 'ключ нагревателя лямбды', net: 'HEAT' },
};

function Cond({ state, title, hint, live }: { state: boolean | null; title: string; hint: string; live: boolean }) {
  return (
    <div className={'tst-cond ' + (state === null ? '' : state ? 'yes' : 'no')}>
      <span className="mark" aria-hidden="true">{state === null ? '?' : state ? '✓' : '✕'}</span>
      <div><b>{title}</b><small>{state === null ? (live ? 'Неизвестно' : 'Нет связи с ECU') : state ? 'Выполнено' : 'Не выполнено'}{state === null && !live ? '' : ' — ' + hint}</small></div>
    </div>
  );
}

export default function TestsPage() {
  const live = useApp((s) => s.live);
  const status = useApp((s) => s.status);
  const rpm = useApp((s) => s.telemetry?.rpm ?? 0);
  const service = useApp((s) => !!s.telemetry?.service);
  const kill = useApp((s) => !!s.telemetry?.kill);
  const active = useApp((s) => (s.live ? s.telemetry?.actuatorTest ?? 0 : 0));
  const message = useApp((s) => s.testMessage);
  const linked = status === 'online' || status === 'lost';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.overlay')) return; // открыт диалог — Esc закрывает его
      if (linked) stopTests();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linked]);

  const stopped = live ? rpm === 0 : null;
  // Прошивка передаёт SERVICE=1 только при остановленном двигателе, поэтому на ходу положение перемычки неизвестно.
  const jumper = live ? (rpm > 0 && !service ? null : service) : null;
  const pin = live ? !kill : null;
  const why = !live ? 'ECU не подключён.' : canMutate() ?? (kill ? 'Сработала аварийная чека STOP — верните её в рабочее положение.' : null);

  const start = async (cmd: string) => {
    const def = ACTUATOR_TESTS.find((d) => d.cmd === cmd)!;
    if (def.confirm && !(await confirmDialog(`${def.title}: ${def.note.toLowerCase()}`, def.confirm, 'Запустить', true))) return;
    runTest(cmd);
  };

  return (
    <div className="page">
      <PageHead title="Тест устройств" sub="Короткое включение каждого выхода ECU для проверки монтажа. Длительность ограничена прошивкой." />

      <div className="tst-conds">
        <Cond live={live} state={stopped} title="Двигатель остановлен (RPM = 0)" hint={stopped === false ? `сейчас ${rpm} об/мин` : 'тесты на работающем моторе запрещены'} />
        <Cond live={live} state={jumper} title="Перемычка SERVICE установлена" hint={live && jumper === null ? 'на работающем двигателе ECU её не сообщает' : 'PB13 замкнут на массу'} />
        <Cond live={live} state={pin} title="Аварийная чека в рабочем положении" hint={pin === false ? 'чека сработала, выходы заблокированы' : 'PB12 разомкнут'} />
      </div>

      <div className="banner warn">
        <div>
          <b>Перед тестом катушек:</b> отключите топливо (разъёмы насоса и форсунки), свечу оставьте в головке или надёжно закрепите на массе двигателя.{' '}
          <b>Перед тестом форсунки:</b> исключите искру, сбросьте давление в рампе или направьте форсунку в мерную ёмкость, рядом не должно быть нагретых деталей.{' '}
          Первые проверки силовых выходов — на стенде, с предохранителем и ограничением тока.
        </div>
      </div>

      <button className="btn solid-danger tst-stop" disabled={!linked} title={linked ? 'Немедленно выключить все тестовые выходы' : 'ECU не подключён.'} onClick={() => stopTests()}>
        СТОП — выключить все тестовые выходы <span className="kbd" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.6)' }}>Esc</span>
      </button>

      <div className="row tst-status" role="status" aria-live="polite">
        <span className={'tag ' + (active ? 'warn' : '')}>{active ? 'идёт тест' : 'состояние'}</span>
        <span>{message}</span>
      </div>
      {why && <div className="tst-why">Запуск недоступен: {why}</div>}

      <div className="tst-grid">
        {ACTUATOR_TESTS.map((d) => {
          const w = WIRING[d.cmd];
          const on = active === d.id;
          return (
            <div key={d.cmd} className={'card tst-card' + (on ? ' active' : '')} aria-current={on ? 'true' : undefined}>
              <h2>{d.title}{on && <span className="tag ok">включён</span>}</h2>
              <div>{d.note}</div>
              {w && <div className="tst-pin">Вывод <b>{w.pin}</b> — {w.what}</div>}
              <div className="row">
                <button className={'btn ' + (d.confirm ? 'danger' : 'primary')} disabled={!!why || (!!active && !on) || on} title={why ?? (active ? 'Дождитесь окончания текущего теста или нажмите СТОП.' : d.note)} onClick={() => start(d.cmd)}>Запустить</button>
                {w && <button className="btn ghost sm" title="Показать цепь на 3D-схеме" onClick={() => { selectNet(w.net); setPage('scheme'); }}>На схеме</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
