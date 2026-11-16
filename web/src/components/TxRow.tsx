import { isOpenAdvance, ownAmount, PAYMENT_LABELS, type Category, type Transaction } from '../../../api/src/types';
import { categoryLabel, findCategory, yen } from '../util';

/** どこから記録されたか */
export function sourceLabel(tx: Transaction): string {
  if (tx.source === 'mail') return '利用通知メール';
  if (tx.source === 'shortcut') return tx.payment === 'applepay' ? 'Apple Pay' : 'ショートカット';
  return '手入力';
}

export function TxRow({ tx, categories, onClick }: { tx: Transaction; categories: Category[]; onClick: () => void }) {
  const c = findCategory(tx.categoryId, categories);
  const open = isOpenAdvance(tx);
  return (
    <li>
      <button className="tx-row" onClick={onClick}>
        <span className="tx-icon" style={{ background: c?.color ?? 'var(--surface-2)' }} aria-hidden>
          {c?.icon ?? '？'}
        </span>
        <span className="tx-main">
          <span className="tx-title">
            {tx.merchant || categoryLabel(tx.categoryId, categories)}
          </span>
          <span className="tx-meta">
            {!tx.confirmed && <span className="tag tag-open">未確認</span>}
            {tx.advance && <span className={`tag${open ? ' tag-open' : ''}`}>{open ? '立替・未精算' : '立替'}</span>}
            {tx.merchant ? `${categoryLabel(tx.categoryId, categories)}・` : ''}
            {tx.type === 'income' ? '収入' : tx.source === 'manual' ? PAYMENT_LABELS[tx.payment] : sourceLabel(tx)}
            {tx.memo ? `・${tx.memo}` : ''}
          </span>
        </span>
        <span className={`num tx-amount ${tx.type === 'income' ? 'income' : ''}`}>
          {tx.type === 'income' ? '+' : ''}
          {yen(tx.advance && !open ? ownAmount(tx) : tx.amount)}
          {tx.advance && !open && <span className="tx-sub">支払 {yen(tx.amount)}</span>}
        </span>
      </button>
    </li>
  );
}
