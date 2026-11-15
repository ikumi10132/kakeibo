import { useState } from 'react';
import type { Transaction } from '../../../api/src/types';
import type { Shared } from '../App';
import { categoryLabel, dateLabel, dayExpense, shortYen, todayJst, yen } from '../util';
import { MonthNav } from './MonthNav';
import { TxRow } from './TxRow';

interface Props extends Shared {
  month: string;
  setMonth: (m: string) => void;
  txs: Transaction[] | null;
}

type View = 'list' | 'calendar';
const VIEW_KEY = 'kb.view';

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

export function TxList({ month, setMonth, txs, categories, edit }: Props) {
  const [view, setViewState] = useState<View>(loadView);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* 保存できなくても切り替えは動く */
    }
  };

  const changeMonth = (m: string) => {
    setSelected(null);
    setMonth(m);
  };

  const byDate = new Map<string, Transaction[]>();
  for (const t of txs ?? []) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);

  return (
    <>
      <MonthNav month={month} setMonth={changeMonth} />
      <div className="segmented" role="group" aria-label="表示の切り替え">
        {([
          ['list', 'リスト'],
          ['calendar', 'カレンダー'],
        ] as const).map(([v, label]) => (
          <button key={v} className={view === v ? 'active' : ''} aria-pressed={view === v} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>

      {!txs && <p className="muted center-text">読み込み中…</p>}

      {txs && view === 'calendar' && (
        <>
          <Calendar month={month} byDate={byDate} selected={selected} onSelect={(d) => setSelected(d === selected ? null : d)} />
          {selected && (
            <DayGroup date={selected} list={byDate.get(selected) ?? []} categories={categories} edit={edit} emptyText="この日の明細はありません" />
          )}
        </>
      )}

      {txs && view === 'list' && (
        <>
          <input
            className="input"
            type="search"
            placeholder="店名・メモ・カテゴリーで検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ListView txs={txs} query={query} categories={categories} edit={edit} />
        </>
      )}
    </>
  );
}

function ListView({ txs, query, categories, edit }: Pick<Shared, 'categories' | 'edit'> & { txs: Transaction[]; query: string }) {
  const q = query.trim().toLowerCase();
  const filtered = txs.filter(
    (t) =>
      !q ||
      t.merchant.toLowerCase().includes(q) ||
      t.memo.toLowerCase().includes(q) ||
      categoryLabel(t.categoryId, categories).toLowerCase().includes(q),
  );
  if (filtered.length === 0) return <p className="muted center-text">明細はありません</p>;
  const byDate = new Map<string, Transaction[]>();
  for (const t of filtered) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  return (
    <>
      {[...byDate.entries()].map(([date, list]) => (
        <DayGroup key={date} date={date} list={list} categories={categories} edit={edit} />
      ))}
    </>
  );
}

function DayGroup({ date, list, categories, edit, emptyText }: Pick<Shared, 'categories' | 'edit'> & {
  date: string;
  list: Transaction[];
  emptyText?: string;
}) {
  return (
    <section className="day">
      <h3 className="day-head">
        <span>{dateLabel(date)}</span>
        <span className="muted small">{yen(dayExpense(list))}</span>
      </h3>
      {list.length === 0 ? (
        <p className="muted small center-text">{emptyText}</p>
      ) : (
        <ul className="card list">
          {list.map((t) => (
            <TxRow key={t.id} tx={t} categories={categories} onClick={() => edit(t)} />
          ))}
        </ul>
      )}
    </section>
  );
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

function Calendar({ month, byDate, selected, onSelect }: {
  month: string;
  byDate: Map<string, Transaction[]>;
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = todayJst();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];

  return (
    <div className="card cal" role="grid" aria-label="カレンダー">
      {WEEK.map((w, i) => (
        <div key={w} className={`cal-head${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`}>{w}</div>
      ))}
      {cells.map((date, i) => {
        if (!date) return <div key={`e${i}`} className="cal-day empty" />;
        const list = byDate.get(date) ?? [];
        const expense = dayExpense(list);
        const income = list.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
        const dow = i % 7;
        const cls = [
          'cal-day',
          dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
          date === today ? 'today' : '',
          date === selected ? 'selected' : '',
        ].filter(Boolean).join(' ');
        return (
          <button
            key={date}
            className={cls}
            aria-pressed={date === selected}
            aria-label={`${dateLabel(date)} 支出 ${yen(expense)}`}
            onClick={() => onSelect(date)}
          >
            <span className="cal-num">{Number(date.slice(8))}</span>
            {expense > 0 && <span className="cal-amt">{shortYen(expense)}</span>}
            {expense === 0 && income > 0 && <span className="cal-amt income">+{shortYen(income)}</span>}
          </button>
        );
      })}
    </div>
  );
}
