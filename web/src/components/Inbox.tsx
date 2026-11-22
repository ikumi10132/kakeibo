import { useState } from 'react';
import type { Transaction } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { dateLabel, yen } from '../util';
import { CategorySelect } from './CategorySelect';

interface Props extends Shared {
  txs: Transaction[] | null;
}

/** 明細を確認済みにする (カテゴリーを付けて保存) */
function confirmWith(tx: Transaction, categoryId: string | null) {
  const { id: _id, createdAt: _c, source: _s, confirmed: _cf, ...input } = tx;
  return api.updateTransaction(tx.id, { ...input, categoryId });
}

export function Inbox({ txs, categories, changed, toast, handleError, edit }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = txs ?? [];
  // 選べるのは同じ種類 (支出 / 収入) の明細だけ。最初に選んだ明細の種類にそろえる
  const picked = list.filter((t) => selected.has(t.id));
  const bulkType = picked[0]?.type ?? 'expense';
  const allSelected = list.length > 0 && list.every((t) => selected.has(t.id) || t.type !== bulkType);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.filter((t) => t.type === bulkType).map((t) => t.id)));

  const applyBulk = async () => {
    if (!bulkCategory || picked.length === 0) return;
    setBusy(true);
    let done = 0;
    try {
      // 1 件ずつ保存する (店名ルールの学習が前の結果を見て重複しないように)
      for (const t of picked) {
        await confirmWith(t, bulkCategory);
        done++;
      }
      toast(`${done} 件をまとめて登録しました`);
      setSelected(new Set());
      setBulkCategory(null);
    } catch (e) {
      handleError(e);
      if (done) toast(`${done} 件は登録できました。残りをもう一度お試しください`, true);
    } finally {
      setBusy(false);
      changed();
    }
  };

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">未確認の明細</h1>
      </header>
      <p className="muted">
        Apple Pay や利用通知メールから自動で記録したもののうち、店名からカテゴリーを決められなかった明細です。
        カテゴリーを選ぶと、次からその店は自動で振り分けられます。左のチェックで選ぶと、まとめて登録できます。
      </p>
      {!txs && <p className="muted center-text">読み込み中…</p>}
      {txs?.length === 0 && <p className="muted center-text">すべて確認済みです</p>}

      {list.length > 1 && (
        <div className={`card bulk-bar${picked.length ? ' active' : ''}`}>
          <label className="bulk-check">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            <span>{picked.length ? `${picked.length} 件を選択中` : 'すべて選択'}</span>
          </label>
          {picked.length > 0 && (
            <div className="inbox-actions">
              <CategorySelect categories={categories} type={bulkType} value={bulkCategory} onChange={setBulkCategory} allowNone />
              <button className="btn btn-primary" disabled={busy || !bulkCategory} onClick={() => void applyBulk()}>
                {busy ? '登録中…' : 'まとめて登録'}
              </button>
            </div>
          )}
        </div>
      )}

      <ul className="inbox">
        {txs?.map((t) => (
          <InboxItem
            key={t.id}
            tx={t}
            {...{ categories, changed, toast, handleError, edit }}
            selectable={list.length > 1}
            selected={selected.has(t.id)}
            disabled={picked.length > 0 && t.type !== bulkType}
            onToggle={() => toggle(t.id)}
          />
        ))}
      </ul>
    </>
  );
}

interface ItemProps extends Pick<Shared, 'categories' | 'changed' | 'toast' | 'handleError' | 'edit'> {
  tx: Transaction;
  selectable?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}

export function InboxItem({ tx, categories, changed, toast, handleError, edit, selectable, selected, disabled, onToggle }: ItemProps) {
  const [categoryId, setCategoryId] = useState<string | null>(tx.categoryId);
  const [busy, setBusy] = useState(false);

  const confirmTx = async () => {
    setBusy(true);
    try {
      await confirmWith(tx, categoryId);
      toast(`${tx.merchant || yen(tx.amount)} を確定しました`);
      changed();
    } catch (e) {
      handleError(e);
      setBusy(false);
    }
  };

  return (
    <li className={`card inbox-item${selected ? ' selected' : ''}`}>
      <div className="inbox-top">
        {selectable && (
          <input
            type="checkbox"
            className="inbox-check"
            aria-label={`${tx.merchant || '明細'} を選ぶ`}
            checked={!!selected}
            disabled={disabled}
            onChange={onToggle}
          />
        )}
        <button className="inbox-head" onClick={() => edit(tx)}>
          <span>
            <strong>{tx.merchant || '(店名なし)'}</strong>
            <span className="muted small"> {dateLabel(tx.date)}{tx.type === 'income' ? '・収入' : ''}</span>
          </span>
          <span className="num">{yen(tx.amount)}</span>
        </button>
      </div>
      <div className="inbox-actions">
        <CategorySelect categories={categories} type={tx.type} value={categoryId} onChange={setCategoryId} allowNone />
        <button className="btn btn-primary" disabled={busy || !categoryId} onClick={() => void confirmTx()}>
          確定
        </button>
      </div>
    </li>
  );
}
