import { useState } from 'react';
import type { Transaction } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { dateLabel, yen } from '../util';

/** 未精算の立て替え。受け取った額を入れて精算する */
export function Advances({ txs, ...shared }: Shared & { txs: Transaction[] }) {
  if (txs.length === 0) return null;
  const total = txs.reduce((s, t) => s + t.amount, 0);
  return (
    <section className="card">
      <h2 className="card-title">
        立て替え中 <span className="muted small">{txs.length} 件・{yen(total)}</span>
      </h2>
      <p className="muted small">受け取ったら金額を入れて「精算」。差額が自分の支出になります（受け取るまでは全額で計上）。</p>
      <ul className="inbox">
        {txs.map((t) => (
          <AdvanceItem key={t.id} tx={t} {...shared} />
        ))}
      </ul>
    </section>
  );
}

function AdvanceItem({ tx, changed, toast, handleError, edit }: Shared & { tx: Transaction }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const n = value === '' ? null : Number(value);

  const settle = async () => {
    if (n === null) return;
    if (n > tx.amount) return toast('受け取った額が支払った金額を超えています', true);
    setBusy(true);
    try {
      const { id: _id, createdAt: _c, source: _s, confirmed: _cf, ...input } = tx;
      await api.updateTransaction(tx.id, { ...input, received: n });
      toast(`精算しました。自分の負担は ${yen(tx.amount - n)} です`);
      changed();
    } catch (e) {
      handleError(e);
      setBusy(false);
    }
  };

  return (
    <li className="inbox-item">
      <button className="inbox-head" onClick={() => edit(tx)}>
        <span>
          <strong>{tx.merchant || tx.memo || '(店名なし)'}</strong>
          <span className="muted small"> {dateLabel(tx.date)}</span>
        </span>
        <span className="num">{yen(tx.amount)}</span>
      </button>
      <div className="settle-row">
        <input
          className="input"
          inputMode="numeric"
          placeholder="受け取った額"
          aria-label={`${tx.merchant || '立て替え'}で受け取った額`}
          value={value === '' ? '' : Number(value).toLocaleString('ja-JP')}
          onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ''))}
        />
        <button className="btn btn-primary" disabled={busy || n === null} onClick={() => void settle()}>
          精算
        </button>
      </div>
    </li>
  );
}
