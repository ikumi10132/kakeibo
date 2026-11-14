import type { Transaction } from '../../../api/src/types';
import type { Shared } from '../App';
import { totals, yen } from '../util';
import { MonthNav } from './MonthNav';

interface Props extends Shared {
  month: string;
  setMonth: (m: string) => void;
  txs: Transaction[] | null;
  inboxCount: number;
  openInbox: () => void;
}

export function Home({ month, setMonth, txs, categories, inboxCount, openInbox }: Props) {
  const t = txs ? totals(txs, categories) : null;
  const max = t?.byCategory[0]?.amount ?? 0;

  return (
    <>
      <MonthNav month={month} setMonth={setMonth} />

      {inboxCount > 0 && (
        <button className="banner banner-action" onClick={openInbox}>
          📥 カテゴリー未確認の明細が {inboxCount} 件あります ›
        </button>
      )}

      <section className="card summary">
        <div>
          <p className="muted small">支出</p>
          <p className="big">{t ? yen(t.expense) : '—'}</p>
        </div>
        <div className="summary-row">
          <div>
            <p className="muted small">収入</p>
            <p className="income">{t ? yen(t.income) : '—'}</p>
          </div>
          <div>
            <p className="muted small">収支</p>
            <p className={t && t.income - t.expense < 0 ? 'minus' : 'income'}>
              {t ? `${t.income - t.expense < 0 ? '−' : '+'}${yen(Math.abs(t.income - t.expense))}` : '—'}
            </p>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">カテゴリー別の支出</h2>
        {!t && <p className="muted">読み込み中…</p>}
        {t && t.byCategory.length === 0 && <p className="muted">この月の支出はまだありません</p>}
        <ul className="bars">
          {t?.byCategory.map(({ category, amount }) => (
            <li key={category?.id ?? 'none'}>
              <div className="bar-head">
                <span>
                  <span aria-hidden>{category?.icon ?? '❔'}</span> {category?.name ?? '未分類'}
                </span>
                <span className="num">
                  {yen(amount)} <span className="muted small">{Math.round((amount / (t.expense || 1)) * 100)}%</span>
                </span>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${(amount / (max || 1)) * 100}%`, background: category?.color ?? 'var(--muted)' }}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
