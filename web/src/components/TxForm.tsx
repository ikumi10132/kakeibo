import { useState, type FormEvent } from 'react';
import { PAYMENT_LABELS, PAYMENT_METHODS, type PaymentMethod, type Transaction, type TxType } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { todayJst, yen } from '../util';
import { CategorySelect } from './CategorySelect';

interface Props extends Shared {
  tx?: Transaction;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function TxForm({ tx, categories, onClose, onSaved, handleError, changed, toast }: Props) {
  const [type, setType] = useState<TxType>(tx?.type ?? 'expense');
  const [amount, setAmount] = useState(tx ? String(tx.amount) : '');
  const [date, setDate] = useState(tx?.date ?? todayJst());
  const [categoryId, setCategoryId] = useState<string | null>(tx?.categoryId ?? null);
  const [payment, setPayment] = useState<PaymentMethod>(tx?.payment ?? 'applepay');
  const [merchant, setMerchant] = useState(tx?.merchant ?? '');
  const [memo, setMemo] = useState(tx?.memo ?? '');
  const [busy, setBusy] = useState(false);

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
      const input = { type, amount: n, date, categoryId, payment, merchant, memo };
      if (tx) await api.updateTransaction(tx.id, input);
      else await api.createTransaction(input);
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

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit} aria-label="明細の入力">
        <div className="sheet-head">
          <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>閉じる</button>
          <h2>{tx ? '明細の編集' : '記録する'}</h2>
          <button type="submit" className="btn btn-primary btn-small" disabled={busy}>保存</button>
        </div>

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
              autoFocus={!tx}
              placeholder="0"
              value={amount ? Number(amount.replace(/[^\d]/g, '') || 0).toLocaleString('ja-JP') : ''}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            />
          </div>
        </label>

        <label className="field">
          <span>カテゴリー</span>
          <CategorySelect categories={categories} type={type} value={categoryId} onChange={setCategoryId} allowNone />
        </label>

        <div className="field-row">
          <label className="field">
            <span>日付</span>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>支払方法</span>
            <select className="input" value={payment} onChange={(e) => setPayment(e.target.value as PaymentMethod)}>
              {PAYMENT_METHODS.map((p) => (
                <option key={p} value={p}>{PAYMENT_LABELS[p]}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>店名</span>
          <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={100} />
        </label>
        <label className="field">
          <span>メモ</span>
          <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={300} />
        </label>

        {tx?.source === 'shortcut' && <p className="muted small">iPhone のショートカットから記録された明細です</p>}
        {tx && (
          <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
            この明細を削除
          </button>
        )}
      </form>
    </div>
  );
}
