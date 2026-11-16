import { useState } from 'react';
import type { Transaction } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { dateLabel, yen } from '../util';
import { CategorySelect } from './CategorySelect';

interface Props extends Shared {
  txs: Transaction[] | null;
}

export function Inbox({ txs, categories, changed, toast, handleError, edit }: Props) {
  return (
    <>
      <header className="page-head">
        <h1 className="page-title">未確認の明細</h1>
      </header>
      <p className="muted">
        Apple Pay や利用通知メールから自動で記録したもののうち、店名からカテゴリーを決められなかった明細です。
        カテゴリーを選ぶと、次からその店は自動で振り分けられます。
      </p>
      {!txs && <p className="muted center-text">読み込み中…</p>}
      {txs?.length === 0 && <p className="muted center-text">すべて確認済みです</p>}
      <ul className="inbox">
        {txs?.map((t) => (
          <InboxItem key={t.id} tx={t} {...{ categories, changed, toast, handleError, edit }} />
        ))}
      </ul>
    </>
  );
}

export function InboxItem({ tx, categories, changed, toast, handleError, edit }: Pick<Shared, 'categories' | 'changed' | 'toast' | 'handleError' | 'edit'> & { tx: Transaction }) {
  const [categoryId, setCategoryId] = useState<string | null>(tx.categoryId);
  const [busy, setBusy] = useState(false);

  const confirmTx = async () => {
    setBusy(true);
    try {
      const { id: _id, createdAt: _c, source: _s, confirmed: _cf, ...input } = tx;
      await api.updateTransaction(tx.id, { ...input, categoryId });
      toast(`${tx.merchant || yen(tx.amount)} を確定しました`);
      changed();
    } catch (e) {
      handleError(e);
      setBusy(false);
    }
  };

  return (
    <li className="card inbox-item">
      <button className="inbox-head" onClick={() => edit(tx)}>
        <span>
          <strong>{tx.merchant || '(店名なし)'}</strong>
          <span className="muted small"> {dateLabel(tx.date)}</span>
        </span>
        <span className="num">{yen(tx.amount)}</span>
      </button>
      <div className="inbox-actions">
        <CategorySelect categories={categories} type={tx.type} value={categoryId} onChange={setCategoryId} allowNone />
        <button className="btn btn-primary" disabled={busy || !categoryId} onClick={() => void confirmTx()}>
          確定
        </button>
      </div>
    </li>
  );
}
