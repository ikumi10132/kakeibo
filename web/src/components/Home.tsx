import { useEffect, useState } from 'react';
import { ownAmount, type Transaction } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { monthLabel, shiftMonth, thisMonth, todayJst, totals, yen } from '../util';
import { CumulativeChart, DonutChart, foldSlices, type LineSeries, type Slice } from './Charts';
import { IconAlert } from './Icons';
import { MonthNav } from './MonthNav';
import { TxForm } from './TxForm';

interface Props extends Shared {
  month: string;
  setMonth: (m: string) => void;
  txs: Transaction[] | null;
  advances: Transaction[];
  unconfirmed: Transaction[];
}

const daysIn = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** 1 日から各日までの支出 (自分の負担) の累計。upTo 日まで */
function cumulative(txs: Transaction[], upTo: number): number[] {
  const perDay = new Array<number>(upTo).fill(0);
  for (const t of txs) {
    if (t.type !== 'expense') continue;
    const d = Number(t.date.slice(8, 10));
    if (d >= 1 && d <= upTo) perDay[d - 1]! += ownAmount(t);
  }
  let sum = 0;
  return perDay.map((v) => (sum += v));
}

export function Home({ month, setMonth, txs, advances, unconfirmed, ...shared }: Props) {
  const { categories, go, toast, changed } = shared;
  const [formKey, setFormKey] = useState(0);
  const [prevTxs, setPrevTxs] = useState<Transaction[] | null>(null);
  const prevMonth = shiftMonth(month, -1);

  // 先月の明細 (折れ線グラフの比較用)。今月の明細を読み直したときに一緒に読み直す
  useEffect(() => {
    if (!txs) return;
    let alive = true;
    api.transactions(prevMonth).then((r) => alive && setPrevTxs(r), shared.handleError);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevMonth, txs]);

  const t = txs ? totals(txs, categories) : null;
  const advanceTotal = advances.reduce((s, a) => s + a.amount, 0);
  const balance = t ? t.income - t.expense : 0;

  const slices: Slice[] = foldSlices(
    (t?.byCategory ?? []).map(({ category, amount }) => ({
      key: category?.id ?? 'none',
      label: category?.name ?? '未分類',
      icon: category?.icon,
      color: category?.color ?? 'var(--chart-none)', // 未分類は「その他」より薄いグレー
      amount,
    })),
  );

  // 今月はきょうまで、過去の月は月末まで線を引く
  const now = thisMonth();
  const curDays = month < now ? daysIn(month) : month === now ? Number(todayJst().slice(8, 10)) : 0;
  const prevDays = daysIn(prevMonth);
  const series: LineSeries[] = [
    { key: 'prev', label: `先月 (${monthLabel(prevMonth).replace(/^\d+年/, '')})`, className: 'series-prev', values: prevTxs ? cumulative(prevTxs, prevDays) : [] },
    { key: 'cur', label: `${month === now ? '今月' : monthLabel(month).replace(/^\d+年/, '')}`, className: 'series-cur', values: txs ? cumulative(txs, curDays) : [] },
  ];
  const cur = series[1]!.values;
  const prev = series[0]!.values;
  const sameDay = Math.min(cur.length, prev.length);
  const diff = sameDay > 0 ? cur[sameDay - 1]! - prev[sameDay - 1]! : null;

  return (
    <>
      <header className="page-head">
        <MonthNav month={month} setMonth={setMonth} />
      </header>

      {unconfirmed.length > 0 && (
        <div className="notice notice-warn" role="status">
          <IconAlert size={22} />
          <p className="grow">
            カテゴリーが未確認の明細が <strong>{unconfirmed.length} 件</strong> あります。
          </p>
          <button className="link-button" onClick={() => go('inbox')}>確認する</button>
        </div>
      )}

      <section className="kpis" aria-label="今月のまとめ">
        <div className="kpi">
          <p className="kpi-label">支出（自分の負担）</p>
          <p className="kpi-value">{t ? yen(t.expense) : '—'}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">収入</p>
          <p className="kpi-value income">{t ? yen(t.income) : '—'}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">収支</p>
          <p className={`kpi-value ${balance < 0 ? 'minus' : 'income'}`}>
            {t ? `${balance < 0 ? '−' : '+'}${yen(Math.abs(balance))}` : '—'}
          </p>
        </div>
        <button className="kpi kpi-button" onClick={() => go('advances')}>
          <p className="kpi-label">立て替え中</p>
          <p className={`kpi-value ${advances.length ? 'warn' : ''}`}>{yen(advanceTotal)}</p>
          <p className="kpi-sub">未精算 {advances.length} 件</p>
        </button>
      </section>

      {/* 記録する (画面の高さいっぱい)。保存したら key を変えて空のフォームに戻す */}
      <TxForm
        key={formKey}
        {...shared}
        inline
        onClose={() => undefined}
        onSaved={(msg) => {
          setFormKey((k) => k + 1);
          changed();
          toast(msg);
        }}
      />

      <section className="card">
        <h2 className="card-title">カテゴリー別の支出</h2>
        {!t && <p className="muted">読み込み中…</p>}
        {t && slices.length === 0 && <p className="muted">この月の支出はまだありません</p>}
        {t && slices.length > 0 && <DonutChart slices={slices} total={t.expense} />}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">先月との比較</h2>
          <span className="muted small">支出（自分の負担）の累計</span>
        </div>
        {diff !== null && (
          <p className="compare-head">
            先月の同じ日までより
            <strong className={diff > 0 ? 'minus' : 'income'}> {yen(Math.abs(diff))} {diff > 0 ? '多い' : '少ない'}</strong>
            {diff === 0 && <strong>（同じ）</strong>}
          </p>
        )}
        <ul className="line-legend" aria-label="凡例">
          {[...series].reverse().map((s) => (
            <li key={s.key}>
              <span className={`legend-line ${s.className}`} aria-hidden />
              {s.label}
              <span className="num">{s.values.length ? yen(s.values.at(-1)!) : '—'}</span>
            </li>
          ))}
        </ul>
        <CumulativeChart series={series} days={Math.max(daysIn(month), prevDays)} />
      </section>
    </>
  );
}
