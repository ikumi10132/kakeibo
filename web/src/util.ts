import type { Category, Transaction } from '../../api/src/types';

export const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

export function todayJst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

export const thisMonth = () => todayJst().slice(0, 7);

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const monthLabel = (month: string) => {
  const [y, m] = month.split('-');
  return `${y}年${Number(m)}月`;
};

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${m}/${d} (${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

export const findCategory = (id: string | null, categories: Category[]) => categories.find((c) => c.id === id);

/** 子カテゴリーは親にまとめる (集計用) */
export function rootOf(id: string | null, categories: Category[]): Category | undefined {
  const c = findCategory(id, categories);
  return c?.parentId ? findCategory(c.parentId, categories) : c;
}

export function categoryLabel(id: string | null, categories: Category[]): string {
  const c = findCategory(id, categories);
  if (!c) return '未分類';
  const p = c.parentId ? findCategory(c.parentId, categories) : undefined;
  return p ? `${p.name} > ${c.name}` : c.name;
}

/** 親 → その子 の順に並べる */
export function orderedCategories(categories: Category[], type?: Category['type']): Category[] {
  return categories
    .filter((c) => !c.parentId && (!type || c.type === type))
    .flatMap((p) => [p, ...categories.filter((c) => c.parentId === p.id)]);
}

export interface Totals {
  expense: number;
  income: number;
  byCategory: { category?: Category; amount: number }[];
}

export function totals(txs: Transaction[], categories: Category[]): Totals {
  let expense = 0;
  let income = 0;
  const map = new Map<string, number>();
  for (const t of txs) {
    if (t.type === 'income') {
      income += t.amount;
      continue;
    }
    expense += t.amount;
    const key = rootOf(t.categoryId, categories)?.id ?? '';
    map.set(key, (map.get(key) ?? 0) + t.amount);
  }
  const byCategory = [...map.entries()]
    .map(([id, amount]) => ({ category: findCategory(id, categories), amount }))
    .sort((a, b) => b.amount - a.amount);
  return { expense, income, byCategory };
}
