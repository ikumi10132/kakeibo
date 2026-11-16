import type { Transaction } from '../../../api/src/types';
import type { Shared } from '../App';
import { categoryLabel, dateLabel, totals, yen } from '../util';
import { Advances } from './Advances';
import { IconAlert, IconChart, IconPlus } from './Icons';
import { InboxItem } from './Inbox';
import { MonthNav } from './MonthNav';
import { sourceLabel, TxRow } from './TxRow';

interface Props extends Shared {
  month: string;
  setMonth: (m: string) => void;
  txs: Transaction[] | null;
  advances: Transaction[];
  unconfirmed: Transaction[];
}

const RECENT = 8;

export function Home({ month, setMonth, txs, advances, unconfirmed, ...shared }: Props) {
  const { categories, edit, go } = shared;
  const t = txs ? totals(txs, categories) : null;
  const max = t?.byCategory[0]?.amount ?? 0;
  const advanceTotal = advances.reduce((s, a) => s + a.amount, 0);
  const balance = t ? t.income - t.expense : 0;
  const recent = (txs ?? []).slice(0, RECENT);

  return (
    <>
      <header className="page-head">
        <MonthNav month={month} setMonth={setMonth} />
        <div className="head-actions pc-only">
          <button className="btn btn-outline" onClick={() => go('export')}>
            <IconChart /> 書き出し
          </button>
          <button className="btn btn-primary" onClick={() => edit()}>
            <IconPlus /> 記録する
          </button>
        </div>
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

      <div className="home-cols">
        <div className="col-main">
          <section className="card">
            <h2 className="card-title">カテゴリー別の支出</h2>
            {!t && <p className="muted">読み込み中…</p>}
            {t && t.byCategory.length === 0 && <p className="muted">この月の支出はまだありません</p>}
            <ul className="bars">
              {t?.byCategory.map(({ category, amount }) => (
                <li key={category?.id ?? 'none'}>
                  <div className="bar-head">
                    <span>{category?.name ?? '未分類'}</span>
                    <span className="num">
                      {yen(amount)} <span className="muted small">{Math.round((amount / (t.expense || 1)) * 100)}%</span>
                    </span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(amount / (max || 1)) * 100}%`, background: category?.color }} />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">最近の明細</h2>
              <button className="link-button" onClick={() => go('list')}>すべて見る</button>
            </div>
            {txs && recent.length === 0 && <p className="muted">この月の明細はまだありません</p>}
            {recent.length > 0 && (
              <>
                {/* PC: 表 */}
                <div className="table-wrap pc-only">
                  <table className="tx-table">
                    <thead>
                      <tr>
                        <th scope="col">日付</th>
                        <th scope="col">店名・メモ</th>
                        <th scope="col">カテゴリー</th>
                        <th scope="col">記録元</th>
                        <th scope="col" className="num-col">金額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((tx) => (
                        <tr key={tx.id} onClick={() => edit(tx)}>
                          <td className="nowrap">{dateLabel(tx.date)}</td>
                          <td>
                            <button className="row-link" onClick={(e) => { e.stopPropagation(); edit(tx); }}>
                              {tx.merchant || tx.memo || '（店名なし）'}
                            </button>
                          </td>
                          <td>
                            {!tx.confirmed ? <span className="tag tag-open">未確認</span> : categoryLabel(tx.categoryId, categories)}
                            {tx.advance && <span className={`tag${tx.received == null ? ' tag-open' : ''}`}>{tx.received == null ? '立替・未精算' : '立替'}</span>}
                          </td>
                          <td><span className="source">{sourceLabel(tx)}</span></td>
                          <td className={`num-col num ${tx.type === 'income' ? 'income' : ''}`}>
                            {tx.type === 'income' ? '+' : ''}{yen(tx.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* スマホ: リスト */}
                <ul className="list phone-only">
                  {recent.map((tx) => (
                    <TxRow key={tx.id} tx={tx} categories={categories} onClick={() => edit(tx)} />
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>

        <div className="col-side">
          {unconfirmed.length > 0 && (
            <section className="card">
              <h2 className="card-title">未確認の明細</h2>
              <p className="muted small">カテゴリーを選ぶと、次からその店は自動で振り分けます。</p>
              <ul className="inbox">
                {unconfirmed.slice(0, 2).map((tx) => (
                  <InboxItem key={tx.id} tx={tx} {...shared} />
                ))}
              </ul>
              {unconfirmed.length > 2 && (
                <button className="link-button" onClick={() => go('inbox')}>ほか {unconfirmed.length - 2} 件を見る</button>
              )}
            </section>
          )}

          <Advances {...shared} txs={advances} />

          <section className="card">
            <h2 className="card-title">AI 分析用の書き出し</h2>
            <p className="small">集計を文章にまとめてコピーします。Claude に貼り付けて「目標達成のための改善点は？」などと聞けます。</p>
            <div className="info-box small">
              <strong>書き出す内容</strong>
              <span>月ごと・カテゴリーごとの合計、収入、立て替え</span>
              <span>店名・メモ・日ごとの明細は含みません</span>
            </div>
            <button className="btn btn-outline" onClick={() => go('export')}>書き出す</button>
          </section>
        </div>
      </div>
    </>
  );
}
