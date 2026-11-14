import { useState } from 'react';
import type { Transaction } from '../../../api/src/types';
import type { Shared } from '../App';
import { categoryLabel, dateLabel, yen } from '../util';
import { MonthNav } from './MonthNav';
import { TxRow } from './TxRow';

interface Props extends Shared {
  month: string;
  setMonth: (m: string) => void;
  txs: Transaction[] | null;
}

export function TxList({ month, setMonth, txs, categories, edit }: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = (txs ?? []).filter(
    (t) =>
      !q ||
      t.merchant.toLowerCase().includes(q) ||
      t.memo.toLowerCase().includes(q) ||
      categoryLabel(t.categoryId, categories).toLowerCase().includes(q),
  );
  const byDate = new Map<string, Transaction[]>();
  for (const t of filtered) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);

  return (
    <>
      <MonthNav month={month} setMonth={setMonth} />
      <input
        className="input"
        type="search"
        placeholder="店名・メモ・カテゴリーで検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!txs && <p className="muted center-text">読み込み中…</p>}
      {txs && filtered.length === 0 && <p className="muted center-text">明細はありません</p>}
      {[...byDate.entries()].map(([date, list]) => (
        <section key={date} className="day">
          <h3 className="day-head">
            <span>{dateLabel(date)}</span>
            <span className="muted small">
              {yen(list.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0))}
            </span>
          </h3>
          <ul className="card list">
            {list.map((t) => (
              <TxRow key={t.id} tx={t} categories={categories} onClick={() => edit(t)} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
