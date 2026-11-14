// DynamoDB に依存しない純粋な処理 (テストしやすいように分けている)
import type { Category, Rule } from './types.js';

/** 日本時間の今日を YYYY-MM-DD で返す */
export function todayJst(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}

export const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);

/**
 * ショートカットから届く金額を整数の円にする。
 * 例: "¥1,234" / "￥1,234" / "JP¥1,234" / "1,234円" / "1234.00" / 1234
 */
export function parseAmount(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(Math.abs(raw));
  if (typeof raw !== 'string') throw new Error('金額がありません');
  const s = raw.normalize('NFKC').replace(/[,\s]/g, '');
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) throw new Error(`金額を読み取れません: ${raw}`);
  const n = Math.round(Number(m[0]));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`金額が不正です: ${raw}`);
  return n;
}

/** 比較用に店名をそろえる (全角半角・大文字小文字・空白の違いを無視) */
export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 店名に一致するルールのうち、キーワードが最も長いものを返す */
export function matchRule(merchant: string, rules: Rule[]): Rule | undefined {
  const m = normalize(merchant);
  if (!m) return undefined;
  let best: Rule | undefined;
  for (const r of rules) {
    const k = normalize(r.keyword);
    if (k && m.includes(k) && (!best || k.length > normalize(best.keyword).length)) best = r;
  }
  return best;
}

/** 「親 > 子」の表示名 */
export function categoryLabel(id: string | null, categories: Category[]): string {
  const c = categories.find((x) => x.id === id);
  if (!c) return '未分類';
  const parent = c.parentId ? categories.find((x) => x.id === c.parentId) : undefined;
  return parent ? `${parent.name} > ${c.name}` : c.name;
}

export const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;
