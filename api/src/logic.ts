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

const SMALL_KANA: Record<string, string> = {
  ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ',
};

/**
 * 比較用に店名をそろえる (全角半角・大文字小文字・空白の違いを無視)。
 * カード会社の通知は「スターバツクス」のように小さいカナを大きく書くので、小さいカナも大きくそろえる。
 * ひらがなはカタカナにそろえる
 */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[ァィゥェォッャュョヮヵヶ]/g, (c) => SMALL_KANA[c] ?? c)
    .replace(/\s+/g, '');
}

export interface CardMail {
  date: string;
  amount: number;
  merchant: string;
  card: string;
}

/**
 * カード会社の利用通知メールの本文から、日付・金額・利用先を読み取る。
 * JCB の「カードご利用通知」の形式 (【ご利用日時(日本時間)】 2026/11/16 13:12 / 【ご利用金額】 2,060円 / 【ご利用先】 …) に対応。
 * 似た書き方 (ご利用日・利用金額・ご利用店名 など) も読む
 */
export function parseCardMail(raw: string): CardMail {
  const text = raw.normalize('NFKC').replace(/\r/g, '');
  const line = (re: RegExp) => text.match(re)?.[1]?.trim() ?? '';
  const label = (names: string) => new RegExp(`(?:【|\\[|■|・)?\\s*(?:ご)?(?:${names})[^】\\]:：\\n]*(?:】|\\]|:|：)?[ \\t]*([^\\n]+)`);

  const dateText = line(label('利用日時|利用日'));
  const d = dateText.match(/(\d{4})[/年-](\d{1,2})[/月-](\d{1,2})/);
  const amountText = line(label('利用金額'));
  const a = amountText.match(/([\d,]+)\s*円/) ?? amountText.match(/[¥￥]\s*([\d,]+)/);
  const merchant = line(label('利用先|利用店名|ご利用店|加盟店名')).replace(/\s+/g, ' ');
  const card = line(/カード名称\s*[:：]\s*([^\n]+)/);

  if (!a) throw new Error('メールから金額を読み取れませんでした');
  const amount = Number(a[1]!.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('メールの金額が不正です');
  const date = d ? `${d[1]}-${d[2]!.padStart(2, '0')}-${d[3]!.padStart(2, '0')}` : todayJst();
  return { date: isDate(date) ? date : todayJst(), amount, merchant, card };
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
