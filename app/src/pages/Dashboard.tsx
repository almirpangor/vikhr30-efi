// Страница «Приборы»: щиток и графики.
import { useState } from 'react';
import { load, save } from '../core/store';
import { PageHead, Seg } from '../ui/kit';
import { Charts } from './dashboard/Charts';
import { Cluster } from './dashboard/Cluster';
import './Dashboard.css';

type View = 'cluster' | 'charts';
const VIEWS: { value: View; label: string }[] = [{ value: 'cluster', label: 'Щиток' }, { value: 'charts', label: 'Графики' }];

export default function DashboardPage() {
  const [view, setView] = useState<View>(() => (load<string>('dash.view', 'cluster') === 'charts' ? 'charts' : 'cluster'));
  return (
    <div className="page fill dash-page">
      <PageHead title="Приборы" sub={view === 'cluster' ? 'Обороты, температура и состояние двигателя' : 'История показателей за последнюю минуту'}>
        <Seg label="Вид страницы" value={view} options={VIEWS} onChange={(v) => { setView(v); save('dash.view', v); }} />
      </PageHead>
      {view === 'cluster' ? <Cluster /> : <Charts />}
    </div>
  );
}
