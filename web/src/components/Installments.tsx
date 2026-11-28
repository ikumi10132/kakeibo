import { useState } from 'react';
import { installmentLevel, INSTALLMENT_MARGIN, type InstallmentsResponse, type InstallmentSummary } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { categoryLabel, monthLabel, yen } from '../util';

/** その月に支払う分割払いの合計 */
export const installmentTotal = (data: InstallmentsResponse | null, month: string) =>
  (data?.plans ?? []).reduce((s, p) => s + p.schedule.filter((x) => x.date.startsWith(month)).reduce((a, x) => a + x.amount, 0), 0);

const dayLabel = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}年${m}月${d}日`;
};

/** 目安との差の説明 */
export function levelNote(amount: number, threshold: number | null): string {
  if (!threshold) return '目安を決めると、超えそうなときに色でお知らせします';
  if (amount > threshold) return `目安 ${yen(threshold)} を ${yen(amount - threshold)} 超えています`;
  return `目安 ${yen(threshold)} まであと ${yen(threshold - amount)}`;
}

export function InstallmentsPage({ data, month, categories, changed, toast, handleError }: Shared & { data: InstallmentsResponse | null; month: string }) {
  const [editing, setEditing] = useState(false);
  const [threshold, setThreshold] = useState('');
  const total = installmentTotal(data, month);
  const level = installmentLevel(total, data?.threshold ?? null);
  const active = data?.plans.filter((p) => !p.finished) ?? [];
  const finished = data?.plans.filter((p) => p.finished) ?? [];

  const saveThreshold = async () => {
    try {
      const n = Number(threshold.replace(/[^\d]/g, '')) || null;
      await api.saveInstallmentThreshold(n);
      setEditing(false);
      toast(n ? `目安を ${yen(n)} にしました` : '目安をなしにしました');
      changed();
    } catch (e) {
      handleError(e);
    }
  };

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">分割払い</h1>
      </header>

      <section className={`card inst-summary level-${level}`}>
        <p className="kpi-label">{monthLabel(month)}の分割払い</p>
        <p className="inst-total num">{yen(total)}</p>
        <p className="small">{levelNote(total, data?.threshold ?? null)}</p>
        {!editing ? (
          <button
            className="btn btn-outline btn-small"
            onClick={() => {
              setThreshold(data?.threshold ? String(data.threshold) : '');
              setEditing(true);
            }}
          >
            {data?.threshold ? '目安を変える' : '目安を決める'}
          </button>
        ) : (
          <div className="inst-threshold">
            <label className="field">
              <span>毎月の分割払いの目安</span>
              <div className="amount-input small-amount">
                <span aria-hidden>¥</span>
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="例: 30,000 (空欄で目安なし)"
                  value={threshold === '' ? '' : Number(threshold.replace(/[^\d]/g, '') || 0).toLocaleString('ja-JP')}
                  onChange={(e) => setThreshold(e.target.value.replace(/[^\d]/g, ''))}
                />
              </div>
            </label>
            <p className="muted small">目安まで {yen(INSTALLMENT_MARGIN)} を切ると黄色、超えると赤で表示します。</p>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={() => void saveThreshold()}>保存</button>
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>やめる</button>
            </div>
          </div>
        )}
      </section>

      {!data && <p className="muted center-text">読み込み中…</p>}
      {data && data.plans.length === 0 && (
        <p className="muted center-text">分割払いはまだありません。支出を記録するときに「分割払い」をオンにすると、毎月の分が自動で入ります。</p>
      )}

      {active.length > 0 && (
        <section className="inst-list" aria-label="支払い中の分割払い">
          <h2 className="section-title">支払い中</h2>
          {active.map((p) => (
            <PlanCard key={p.id} plan={p} {...{ categories, changed, toast, handleError }} />
          ))}
        </section>
      )}

      {finished.length > 0 && (
        <details className="inst-done">
          <summary>支払い終わった分割払い ({finished.length})</summary>
          {finished.map((p) => (
            <PlanCard key={p.id} plan={p} {...{ categories, changed, toast, handleError }} />
          ))}
        </details>
      )}
    </>
  );
}

function PlanCard({ plan, categories, changed, toast, handleError }: Pick<Shared, 'categories' | 'changed' | 'toast' | 'handleError'> & { plan: InstallmentSummary }) {
  const [payoff, setPayoff] = useState(false);
  // 繰り上げ返済できる回: 最後の回より前 (最後の回で返済しても何も変わらない)。初期値は次に払う回
  const options = plan.schedule.slice(0, -1).map((p, i) => ({ index: i + 1, ...p }));
  const [index, setIndex] = useState(Math.min(plan.paidCount + 1, Math.max(1, plan.schedule.length - 1)));
  const [busy, setBusy] = useState(false);
  const rest = plan.schedule.slice(index - 1).reduce((s, p) => s + p.amount, 0);
  const last = plan.schedule.at(-1);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      changed();
    } catch (e) {
      handleError(e);
      setBusy(false);
    }
  };

  const doPayoff = () =>
    run(async () => {
      await api.payoffInstallment(plan.id, index);
      toast(`${index} 回目で繰り上げ返済しました (${yen(rest)})`);
    });

  const remove = () => {
    if (!confirm(`「${plan.merchant || '分割払い'}」の分割払いを削除しますか？\n各月の明細 (${plan.schedule.length} 件) もすべて削除します。`)) return;
    void run(async () => {
      await api.deleteInstallment(plan.id);
      toast('分割払いを削除しました');
    });
  };

  return (
    <article className="card inst-card">
      <div className="inst-head">
        <div>
          <h3 className="inst-title">{plan.merchant || categoryLabel(plan.categoryId, categories)}</h3>
          <p className="muted small">
            {dayLabel(plan.purchaseDate)} に {yen(plan.total)} を {plan.count} 回払い ({plan.start === 'next' ? '来月から' : '今月から'})
            {plan.paidOffAt ? `・${plan.paidOffAt} 回目で繰り上げ返済` : ''}
          </p>
        </div>
        <p className="num inst-monthly">
          毎月 {yen(plan.monthly)}
        </p>
      </div>

      <div className="inst-progress" role="progressbar" aria-valuemin={0} aria-valuemax={plan.schedule.length} aria-valuenow={plan.paidCount}>
        <div style={{ width: `${(plan.paidCount / plan.schedule.length) * 100}%` }} />
      </div>
      <dl className="inst-kv">
        <div><dt>支払済み</dt><dd>{plan.paidCount} / {plan.schedule.length} 回</dd></div>
        <div><dt>残り</dt><dd className="num">{yen(plan.remainingAmount)}</dd></div>
        <div><dt>{plan.finished ? '最終回' : '次回'}</dt><dd>{plan.finished ? (last ? dayLabel(last.date) : '—') : dayLabel(plan.nextDate!)}</dd></div>
      </dl>

      {!plan.finished && !payoff && (
        <div className="btn-row">
          {options.length > 0 && (
            <button className="btn btn-outline btn-small" disabled={busy} onClick={() => setPayoff(true)}>繰り上げ返済</button>
          )}
          <button className="btn btn-ghost btn-small" disabled={busy} onClick={remove}>削除</button>
        </div>
      )}
      {plan.finished && (
        <div className="btn-row">
          <button className="btn btn-ghost btn-small" disabled={busy} onClick={remove}>削除</button>
        </div>
      )}

      {payoff && (
        <div className="advance-box">
          <strong>繰り上げ返済</strong>
          <label className="field">
            <span>まとめて払う回</span>
            <select className="input" value={index} onChange={(e) => setIndex(Number(e.target.value))}>
              {options.map((o) => (
                <option key={o.index} value={o.index}>
                  {o.index} 回目 ({dayLabel(o.date)}){o.index <= plan.paidCount ? '・支払日を過ぎた回' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="small">
            {index} 回目に残り <strong>{yen(rest)}</strong> をまとめて支払います。{index + 1} 回目以降 ({plan.schedule.length - index} 回分) の明細は削除します。
          </p>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={() => void doPayoff()}>繰り上げ返済する</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setPayoff(false)}>やめる</button>
          </div>
        </div>
      )}
    </article>
  );
}
