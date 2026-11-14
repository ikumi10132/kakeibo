import { monthLabel, shiftMonth, thisMonth } from '../util';

export function MonthNav({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const current = thisMonth();
  return (
    <div className="month-nav">
      <button className="btn btn-icon" aria-label="前の月" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
      <button className="month-label" onClick={() => setMonth(current)} title="今月に戻る">
        {monthLabel(month)}
      </button>
      <button
        className="btn btn-icon"
        aria-label="次の月"
        disabled={month >= current}
        onClick={() => setMonth(shiftMonth(month, 1))}
      >
        ›
      </button>
    </div>
  );
}
