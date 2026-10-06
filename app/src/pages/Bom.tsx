// Комплектующие: что купить для сборки ECU.
import { useState } from 'react';
import { BOM, bomTotal, type BomItem } from '../core/hardware';
import { downloadText, load, save } from '../core/store';
import { PageHead, Seg, fmt, DASH } from '../ui/kit';
import './Service.css';

type Filter = 'all' | BomItem['status'] | 'left';
const STATUS: Record<BomItem['status'], { label: string; tone: string }> = {
  shop: { label: 'Есть в магазине', tone: 'ok' },
  'shop-unverified': { label: 'Уточнить в магазине', tone: 'warn' },
  elsewhere: { label: 'Заказать отдельно', tone: 'danger' },
};
const money = (v: number) => fmt(v, Number.isInteger(v) ? 0 : 2) + ' ₽';
const keyOf = (b: BomItem) => b.ref + '|' + b.title;

export default function BomPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [bought, setBought] = useState<string[]>(() => { const b = load<string[]>('bom.bought', []); return Array.isArray(b) ? b : []; });
  const total = bomTotal();
  const unverified = BOM.filter((b) => b.status === 'shop-unverified').length;
  const noPrice = BOM.filter((b) => b.status !== 'elsewhere' && b.price === undefined).length;
  const boughtCount = BOM.filter((b) => bought.includes(keyOf(b))).length;
  const leftSum = BOM.reduce((s, b) => s + (bought.includes(keyOf(b)) ? 0 : (b.price ?? 0) * b.qty), 0);
  const rows = BOM.filter((b) => filter === 'all' || (filter === 'left' ? !bought.includes(keyOf(b)) : b.status === filter));
  const toggle = (k: string) => { const next = bought.includes(k) ? bought.filter((x) => x !== k) : [...bought, k]; setBought(next); save('bom.bought', next); };

  const csv = () => {
    const q = (s: string | number | undefined) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
    const head = ['Обозначение', 'Что купить', 'Назначение', 'Кол-во', 'Цена, руб', 'Сумма, руб', 'Статус', 'Куплено', 'Примечание', 'В исходной схеме', 'Ссылка'];
    const lines = BOM.map((b) => [b.ref, b.title, b.role, b.qty, b.price === undefined ? '' : String(b.price).replace('.', ','), b.price === undefined ? '' : String(Math.round(b.price * b.qty * 100) / 100).replace('.', ','),
      STATUS[b.status].label, bought.includes(keyOf(b)) ? 'да' : '', b.note, b.original, b.url].map(q).join(';'));
    downloadText('vikhr30-komplektuyushchie.csv', [head.map(q).join(';'), ...lines].join('\r\n') + '\r\n');
  };

  return (
    <div className="page bom-page">
      <PageHead title="Комплектующие" sub="Перечень деталей для сборки блока в варианте «из одного магазина».">
        <div className="row no-print">
          <button className="btn" onClick={csv}>Сохранить список в CSV</button>
          <button className="btn" onClick={() => window.print()}>Печать</button>
        </div>
      </PageHead>

      <div className="banner info no-print">
        <div>
          Магазин «Электроника», Уфа, пр. Октября, 108, тел. <span className="num">8 (347) 233-30-33</span>. Цены сняты с сайта 03.10.2026.
          Остатки сайт не показывает — перед поездкой уточните наличие по телефону.
        </div>
      </div>
      <div className="print-head">
        <b>Вихрь-30 EFI — комплектующие.</b> Магазин «Электроника», Уфа, пр. Октября, 108, тел. 8 (347) 233-30-33. Цены с сайта на 03.10.2026, наличие уточнять по телефону.
        Итого по магазину: {money(total.shop)}; уточнить: {unverified}; заказать отдельно: {total.elsewhere}.
      </div>

      <div className="bom-sum no-print">
        <div><span>Сумма по магазину</span><b>{money(total.shop)}</b></div>
        <div><span>Уточнить в магазине</span><b className={unverified ? 'warn' : ''}>{unverified} поз.</b></div>
        <div><span>Заказать отдельно</span><b className={total.elsewhere ? 'danger' : ''}>{total.elsewhere} поз.</b></div>
        <div><span>Куплено · осталось докупить</span><b>{boughtCount} из {BOM.length} · {money(Math.round(leftSum))}</b></div>
      </div>

      <div className="row no-print">
        <Seg label="Фильтр по статусу" value={filter} onChange={setFilter} options={[
          { value: 'all', label: `Все (${BOM.length})` }, { value: 'shop', label: 'Есть в магазине' }, { value: 'shop-unverified', label: 'Уточнить' },
          { value: 'elsewhere', label: 'Заказать отдельно' }, { value: 'left', label: `Не куплено (${BOM.length - boughtCount})` },
        ]} />
        {noPrice > 0 && <span className="muted" style={{ fontSize: 12.5 }}>Позиций без цены на сайте: {noPrice} — в сумму не входят.</span>}
      </div>

      <div className="card flush">
        <table className="tbl bom-table">
          <thead><tr>
            <th className="no-print" title="Отметка «куплено»">Куплено</th><th>Обозн.</th><th>Что купить</th><th>Назначение</th>
            <th className="r">Кол-во</th><th className="r">Цена</th><th className="r">Сумма</th><th>Статус</th>
          </tr></thead>
          <tbody>
            {rows.map((b) => {
              const k = keyOf(b), has = bought.includes(k), st = STATUS[b.status];
              return (
                <tr key={k} className={has ? 'bought' : ''}>
                  <td className="no-print"><input type="checkbox" checked={has} aria-label={`Куплено: ${b.title}`} onChange={() => toggle(k)} /></td>
                  <td className="ref">{b.ref}</td>
                  <td>
                    {b.url ? <a href={b.url} target="_blank" rel="noopener noreferrer" title="Открыть страницу магазина в новой вкладке">{b.title}</a> : b.title}
                    {b.note && <div className="bom-note">{b.note}</div>}
                    {b.original && <div className="bom-orig">В исходной схеме было: {b.original}</div>}
                  </td>
                  <td>{b.role}</td>
                  <td className="r num">{b.qty}</td>
                  <td className="r num">{b.price === undefined ? <span className="nodata">{DASH}</span> : money(b.price)}</td>
                  <td className="r num">{b.price === undefined ? <span className="nodata">{DASH}</span> : money(Math.round(b.price * b.qty * 100) / 100)}</td>
                  <td><span className={'tag ' + st.tone}>{st.label}</span></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8}><div className="empty"><b>Таких позиций нет</b><span>Выберите другой фильтр.</span></div></td></tr>}
          </tbody>
          {filter === 'all' && (
            <tfoot><tr><td className="no-print" /><td colSpan={5}>Итого по магазину (позиции с известной ценой)</td><td className="r num">{money(total.shop)}</td><td /></tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
