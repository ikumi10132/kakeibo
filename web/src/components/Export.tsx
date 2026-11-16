import { useEffect, useState } from 'react';
import { isOpenAdvance, type Transaction } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { monthLabel, shiftMonth, totals, yen } from '../util';
import { IconCopy } from './Icons';

const RANGES = [
  { months: 1, label: '今月だけ' },
  { months: 3, label: '直近 3 か月' },
  { months: 6, label: '直近 6 か月' },
] as const;

/**
 * Claude などの AI に貼り付けて分析してもらうための集計。
 * 店名・メモ・日ごとの明細は含めず、月ごと・カテゴリーごとの合計だけにする
 */
export function buildSummary(byMonth: { month: string; txs: Transaction[] }[], categories: Shared['categories'], openAdvances: Transaction[]): string {
  const lines: string[] = [];
  const first = byMonth[byMonth.length - 1]!.month;
  const last = byMonth[0]!.month;
  lines.push(`# 家計の集計 (${first === last ? monthLabel(last) : `${monthLabel(first)}〜${monthLabel(last)}`})`);
  lines.push('');
  lines.push('金額は円。支出は自分の負担額 (立て替えは受け取った額を差し引いた額。未精算の間は全額)。');
  lines.push('');

  lines.push('## 月ごとの合計');
  lines.push('| 月 | 収入 | 支出 | 収支 |');
  lines.push('|---|---:|---:|---:|');
  for (const { month, txs } of [...byMonth].reverse()) {
    const t = totals(txs, categories);
    lines.push(`| ${monthLabel(month)} | ${yen(t.income)} | ${yen(t.expense)} | ${yen(t.income - t.expense)} |`);
  }
  lines.push('');

  // カテゴリー (大分類) × 月
  const names = new Set<string>();
  const perMonth = [...byMonth].reverse().map(({ month, txs }) => {
    const map = new Map<string, number>();
    for (const c of totals(txs, categories).byCategory) {
      const name = c.category?.name ?? '未分類';
      names.add(name);
      map.set(name, c.amount);
    }
    return { month, map };
  });
  if (names.size > 0) {
    lines.push('## カテゴリー別の支出');
    lines.push(`| カテゴリー | ${perMonth.map((m) => monthLabel(m.month)).join(' | ')} |`);
    lines.push(`|---|${perMonth.map(() => '---:').join('|')}|`);
    const sorted = [...names].sort((a, b) => (perMonth.at(-1)!.map.get(b) ?? 0) - (perMonth.at(-1)!.map.get(a) ?? 0));
    for (const name of sorted) {
      lines.push(`| ${name} | ${perMonth.map((m) => yen(m.map.get(name) ?? 0)).join(' | ')} |`);
    }
    lines.push('');
  }

  if (openAdvances.length > 0) {
    lines.push('## 未精算の立て替え');
    lines.push(`${openAdvances.length} 件、合計 ${yen(openAdvances.reduce((s, a) => s + a.amount, 0))}`);
    lines.push('');
  }

  lines.push('## お願い');
  lines.push('この集計をもとに、支出の傾向と、無理なく節約できそうなカテゴリーを教えてください。');
  return lines.join('\n');
}

export function Export({ categories, handleError, toast, month }: Shared & { month: string }) {
  const [range, setRange] = useState<number>(3);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setText(null);
    const months = Array.from({ length: range }, (_, i) => shiftMonth(month, -i));
    Promise.all([Promise.all(months.map((m) => api.transactions(m))), api.openAdvances()])
      .then(([lists, advances]) => {
        if (!alive) return;
        const byMonth = months.map((m, i) => ({ month: m, txs: lists[i] ?? [] }));
        setText(buildSummary(byMonth, categories, advances.filter(isOpenAdvance)));
      })
      .catch(handleError);
    return () => {
      alive = false;
    };
  }, [range, month, categories, handleError]);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました。Claude に貼り付けてください');
    } catch {
      toast('コピーできませんでした。下の文章を長押しして選択してください', true);
    }
  };

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">AI 分析用の書き出し</h1>
      </header>
      <p className="muted">
        集計を文章にまとめます。コピーして Claude に貼り付け、「目標達成のための改善点は？」などと聞いてください。
        {monthLabel(month)} を最新の月として集計します (月はホームや明細で切り替えられます)。
      </p>

      <section className="card">
        <div className="segmented" role="group" aria-label="期間">
          {RANGES.map((r) => (
            <button key={r.months} className={range === r.months ? 'active' : ''} aria-pressed={range === r.months} onClick={() => setRange(r.months)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="info-box small">
          <strong>書き出す内容</strong>
          <span>月ごとの収入・支出・収支、カテゴリーごとの支出、未精算の立て替えの件数と合計</span>
          <span>店名・メモ・日ごとの明細は含みません</span>
        </div>
        <label className="field">
          <span>書き出す文章</span>
          <textarea className="input export-text" readOnly value={text ?? '集計中…'} rows={14} />
        </label>
        <button className="btn btn-primary" disabled={!text} onClick={() => void copy()}>
          <IconCopy /> コピーする
        </button>
      </section>
    </>
  );
}
