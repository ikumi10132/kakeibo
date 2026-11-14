import { PAYMENT_LABELS, type Category, type Transaction } from '../../../api/src/types';
import { categoryLabel, findCategory, yen } from '../util';

export function TxRow({ tx, categories, onClick }: { tx: Transaction; categories: Category[]; onClick: () => void }) {
  const c = findCategory(tx.categoryId, categories);
  return (
    <li>
      <button className="tx-row" onClick={onClick}>
        <span className="tx-icon" style={{ background: c?.color ?? 'var(--surface-2)' }} aria-hidden>
          {c?.icon ?? '❔'}
        </span>
        <span className="tx-main">
          <span className="tx-title">{tx.merchant || categoryLabel(tx.categoryId, categories)}</span>
          <span className="muted small">
            {tx.merchant ? `${categoryLabel(tx.categoryId, categories)}・` : ''}
            {PAYMENT_LABELS[tx.payment]}
            {tx.memo ? `・${tx.memo}` : ''}
          </span>
        </span>
        <span className={`num ${tx.type === 'income' ? 'income' : ''}`}>
          {tx.type === 'income' ? '+' : ''}
          {yen(tx.amount)}
        </span>
      </button>
    </li>
  );
}
