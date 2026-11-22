import { useState, type FormEvent } from 'react';
import { PAYMENT_LABELS, PAYMENT_METHODS, type PaymentMethod, type Transaction, type TxType } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { todayJst, yen } from '../util';
import { getAccessToken } from '../auth';
import { WARIPO_URL } from '../config';
import { CategoryPicker } from './CategoryPicker';
import { sourceLabel } from './TxRow';

/** 家計簿の明細を waripo で割り勘にする (相手の負担 share。相手の家計簿に負担分が入る) */
async function splitOnWaripo(txId: string, share: number): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error('ログインし直してください');
  const res = await fetch(`${WARIPO_URL}/api/entries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'split', kakeiboTxId: txId, share }),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(body.message ?? `waripo に記録できませんでした (${res.status})`);
}

interface Props extends Shared {
  tx?: Transaction;
  onClose: () => void;
  onSaved: (message: string) => void;
  /** ホーム画面に埋め込む (下から出るシートではなくカードとして表示し、保存後は空に戻す) */
  inline?: boolean;
}

export function TxForm({ tx, categories, onClose, onSaved, handleError, changed, toast, inline }: Props) {
  const [type, setType] = useState<TxType>(tx?.type ?? 'expense');
  const [amount, setAmount] = useState(tx ? String(tx.amount) : '');
  const [date, setDate] = useState(tx?.date ?? todayJst());
  const [categoryId, setCategoryId] = useState<string | null>(tx?.categoryId ?? null);
  const [payment, setPayment] = useState<PaymentMethod>(tx?.payment ?? 'applepay');
  const [merchant, setMerchant] = useState(tx?.merchant ?? '');
  const [memo, setMemo] = useState(tx?.memo ?? '');
  const [advance, setAdvance] = useState(tx?.advance ?? false);
  const [received, setReceived] = useState(tx?.received != null ? String(tx.received) : '');
  // 新しく記録するときに、そのまま waripo で割り勘にする
  const [split, setSplit] = useState(false);
  const [splitHalf, setSplitHalf] = useState(true);
  const [splitShare, setSplitShare] = useState('');
  const [busy, setBusy] = useState(false);
  const amountNum = Number(amount.replace(/[^\d]/g, '')) || 0;
  const receivedNum = received === '' ? null : Number(received.replace(/[^\d]/g, '')) || 0;
  const otherShare = splitHalf ? Math.floor(amountNum / 2) : Number(splitShare.replace(/[^\d]/g, '')) || 0;
  const willSplit = !tx && type === 'expense' && !advance && split;

  const changeType = (t: TxType) => {
    setType(t);
    if (categories.find((c) => c.id === categoryId)?.type !== t) setCategoryId(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount.replace(/[^\d]/g, ''));
    if (!n) return toast('金額を入力してください', true);
    setBusy(true);
    try {
      if (advance && receivedNum !== null && receivedNum > n) {
        setBusy(false);
        return toast('受け取った額が支払った金額を超えています', true);
      }
      if (willSplit && otherShare > n) {
        setBusy(false);
        return toast('相手の負担が支払った金額を超えています', true);
      }
      const isAdvance = type === 'expense' && advance;
      const input = { type, amount: n, date, categoryId, payment: type === 'income' ? ('other' as const) : payment, merchant, memo, advance: isAdvance, received: isAdvance ? receivedNum : null };
      if (tx) await api.updateTransaction(tx.id, input);
      else {
        const created = await api.createTransaction(input);
        if (willSplit) {
          try {
            await splitOnWaripo(created.id, otherShare);
          } catch (err) {
            // 明細は記録できている。あとから明細を開いて「waripo で割り勘」でやり直せる
            onSaved(`${yen(n)} を記録しました`);
            toast(`記録しましたが、waripo で割り勘にできませんでした (${err instanceof Error ? err.message : String(err)})。明細を開いてやり直せます`, true);
            return;
          }
          onSaved(`${yen(n)} を記録して、waripo で割り勘にしました (相手の負担 ${yen(otherShare)})`);
          return;
        }
      }
      onSaved(`${yen(n)} を${tx ? '更新' : '記録'}しました`);
    } catch (err) {
      handleError(err);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!tx || !confirm('この明細を削除しますか？')) return;
    setBusy(true);
    try {
      await api.deleteTransaction(tx.id);
      changed();
      onClose();
      toast('削除しました');
    } catch (err) {
      handleError(err);
      setBusy(false);
    }
  };

  const body = (
    <>

        <div className="segmented" role="group" aria-label="収支">
          {(['expense', 'income'] as const).map((t) => (
            <button key={t} type="button" className={type === t ? 'active' : ''} aria-pressed={type === t} onClick={() => changeType(t)}>
              {t === 'expense' ? '支出' : '収入'}
            </button>
          ))}
        </div>

        <label className="field">
          <span>金額</span>
          <div className="amount-input">
            <span aria-hidden>¥</span>
            <input
              className="input"
              inputMode="numeric"
              autoFocus={!tx && !inline}
              placeholder="0"
              value={amount ? Number(amount.replace(/[^\d]/g, '') || 0).toLocaleString('ja-JP') : ''}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            />
          </div>
        </label>

        <CategoryPicker categories={categories} type={type} value={categoryId} onChange={setCategoryId} />

        {/* 支払方法は支出のときだけ (収入は日付だけ) */}
        <div className={type === 'expense' ? 'field-row' : ''}>
          <label className="field">
            <span>日付</span>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          {type === 'expense' && (
            <label className="field">
              <span>支払方法</span>
              <select className="input" value={payment} onChange={(e) => setPayment(e.target.value as PaymentMethod)}>
                {PAYMENT_METHODS.map((p) => (
                  <option key={p} value={p}>{PAYMENT_LABELS[p]}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        {tx && type === 'expense' && !tx.advance && <WaripoBox tx={tx} changed={changed} toast={toast} handleError={handleError} onClose={onClose} />}

        {!tx && type === 'expense' && !advance && (
          <div className="advance-box">
            <label className="switch-row">
              <span>
                <strong>waripo で割り勘</strong>
                <span className="muted small"> 相手の家計簿に相手の負担分が入ります</span>
              </span>
              <input type="checkbox" role="switch" checked={split} onChange={(e) => setSplit(e.target.checked)} />
            </label>
            {split && (
              <>
                <div className="segmented small-seg" role="group" aria-label="分け方">
                  <button type="button" className={splitHalf ? 'active' : ''} aria-pressed={splitHalf} onClick={() => setSplitHalf(true)}>半分ずつ</button>
                  <button type="button" className={!splitHalf ? 'active' : ''} aria-pressed={!splitHalf} onClick={() => setSplitHalf(false)}>相手の負担を指定</button>
                </div>
                {!splitHalf && (
                  <label className="field">
                    <span>相手の負担</span>
                    <div className="amount-input small-amount">
                      <span aria-hidden>¥</span>
                      <input
                        className="input"
                        inputMode="numeric"
                        placeholder="0"
                        value={splitShare === '' ? '' : Number(splitShare.replace(/[^\d]/g, '') || 0).toLocaleString('ja-JP')}
                        onChange={(e) => setSplitShare(e.target.value.replace(/[^\d]/g, ''))}
                      />
                    </div>
                  </label>
                )}
                <p className="small">
                  相手の負担 <strong>{yen(otherShare)}</strong>・あなたの負担 <strong>{yen(Math.max(0, amountNum - otherShare))}</strong>
                  <span className="muted">（家計簿にはあなたの負担だけが支出として入ります）</span>
                </p>
              </>
            )}
          </div>
        )}

        {type === 'expense' && !tx?.split && !willSplit && (
          <div className="advance-box">
            <label className="switch-row">
              <span>
                <strong>立て替え</strong>
                <span className="muted small"> あとで他の人から受け取る支払い</span>
              </span>
              <input type="checkbox" role="switch" checked={advance} onChange={(e) => setAdvance(e.target.checked)} />
            </label>
            {advance && (
              <>
                <label className="field">
                  <span>受け取った額 (まだなら空欄)</span>
                  <div className="amount-input small-amount">
                    <span aria-hidden>¥</span>
                    <input
                      className="input"
                      inputMode="numeric"
                      placeholder="未精算"
                      value={received === '' ? '' : Number(received.replace(/[^\d]/g, '') || 0).toLocaleString('ja-JP')}
                      onChange={(e) => setReceived(e.target.value.replace(/[^\d]/g, ''))}
                    />
                  </div>
                </label>
                <p className="small">
                  自分の負担: <strong>{yen(Math.max(0, amountNum - (receivedNum ?? 0)))}</strong>
                  {receivedNum === null && <span className="muted">（受け取るまでは全額を支出として数えます）</span>}
                </p>
              </>
            )}
          </div>
        )}

        <label className="field">
          <span>{type === 'income' ? '入金元 (会社名など・任意)' : '店名'}</span>
          <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={100} />
        </label>
        <label className="field">
          <span>メモ</span>
          <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={300} />
        </label>

        {tx && tx.source !== 'manual' && <p className="muted small">記録元: {sourceLabel(tx)}</p>}
        {tx && (
          <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
            この明細を削除
          </button>
        )}
    </>
  );

  if (inline) {
    return (
      <form id="quick-form" className="card quick-form" onSubmit={submit} aria-label="明細の入力">
        <h2 className="card-title">記録する</h2>
        {body}
        <div className="quick-foot">
          <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>記録する</button>
        </div>
      </form>
    );
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit} aria-label="明細の入力">
        <div className="sheet-head">
          <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>閉じる</button>
          <h2>{tx ? '明細の編集' : '記録する'}</h2>
          <span />
        </div>
        {body}
        <div className="sheet-foot">
          <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>保存する</button>
        </div>
      </form>
    </div>
  );
}

/** waripo (割り勘アプリ) と連動する欄。割り勘済みなら内容を、まだならボタンを出す */
function WaripoBox({ tx, changed, toast, handleError, onClose }: Pick<Shared, 'changed' | 'toast' | 'handleError'> & { tx: Transaction; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const [half, setHalf] = useState(true);
  const [share, setShare] = useState('');
  const [busy, setBusy] = useState(false);
  const otherShare = half ? Math.floor(tx.amount / 2) : Number(share.replace(/[^\d]/g, '')) || 0;

  if (tx.split) {
    return (
      <div className="advance-box">
        <strong>waripo で割り勘中</strong>
        {tx.split.role === 'payer' ? (
          <p className="small">
            相手の負担 {yen(tx.split.otherShare ?? 0)}・あなたの負担 <strong>{yen(tx.amount - (tx.split.otherShare ?? 0))}</strong>（家計簿にはあなたの負担だけが支出として入ります）
          </p>
        ) : (
          <p className="small">相手が払った割り勘の、あなたの負担分です。</p>
        )}
        <a className="btn btn-outline btn-small" href={WARIPO_URL} target="_blank" rel="noreferrer">waripo で見る・取り消す</a>
      </div>
    );
  }

  const submit = async () => {
    if (otherShare > tx.amount) return toast('相手の負担が支払った金額を超えています', true);
    setBusy(true);
    try {
      await splitOnWaripo(tx.id, otherShare);
      toast(`waripo で割り勘にしました (相手の負担 ${yen(otherShare)})`);
      changed();
      onClose();
    } catch (e) {
      handleError(e);
      setBusy(false);
    }
  };

  return (
    <div className="advance-box">
      {!open ? (
        <button type="button" className="btn btn-outline" onClick={() => setOpen(true)}>waripo で割り勘</button>
      ) : (
        <>
          <strong>waripo で割り勘</strong>
          <div className="segmented small-seg" role="group" aria-label="分け方">
            <button type="button" className={half ? 'active' : ''} aria-pressed={half} onClick={() => setHalf(true)}>半分ずつ</button>
            <button type="button" className={!half ? 'active' : ''} aria-pressed={!half} onClick={() => setHalf(false)}>相手の負担を指定</button>
          </div>
          {!half && (
            <label className="field">
              <span>相手の負担</span>
              <input className="input" inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value.replace(/[^\d]/g, ''))} />
            </label>
          )}
          <p className="small">相手の負担 <strong>{yen(otherShare)}</strong>・あなたの負担 <strong>{yen(Math.max(0, tx.amount - otherShare))}</strong>。相手の家計簿に相手の負担分が「waripoから自動登録」として入ります。</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>割り勘にする</button>
        </>
      )}
    </div>
  );
}
