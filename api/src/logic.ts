// DynamoDB に依存しない純粋な処理 (テストしやすいように分けている)
import type { Category, InstallmentPlan, InstallmentSummary, Rule } from './types.js';

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
/** HTML のメール本文をテキストにする (改行になるタグは改行に、それ以外のタグは消す) */
export function htmlToText(s: string): string {
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&yen;/g, '¥')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

export function parseCardMail(raw: string): CardMail {
  const text = htmlToText(raw).normalize('NFKC').replace(/\r/g, '');
  const line = (re: RegExp) => text.match(re)?.[1]?.trim() ?? '';
  // 項目名の前の記号はカード会社ごとに違う (JCB: 【ご利用金額】、三井住友カード: ◇利用金額：、など)
  const label = (names: string) => new RegExp(`(?:【|\\[|■|□|・|◇|◆|★|☆|●|○|◎|▼|▽|＊|\\*)?\\s*(?:ご)?(?:${names})[^】\\]:：\\n]*(?:】|\\]|:|：)?[ \\t]*([^\\n]+)`);

  const dateText = line(label('利用日時|利用日'));
  const d = dateText.match(/(\d{4})[/年-](\d{1,2})[/月-](\d{1,2})/);
  const amountText = line(label('利用金額'));
  const a = amountText.match(/([\d,]+)\s*円/) ?? amountText.match(/[¥￥]\s*([\d,]+)/);
  const merchant = line(label('利用先|利用店名|利用店舗|ご利用店|加盟店名')).replace(/\s+/g, ' ');
  const card = line(/(?:カード名称|ご利用カード|利用カード)\s*[:：]\s*([^\n]+)/);

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

/** JWT の cognito:groups (API Gateway では "[admin other]" のような文字列で届くことがある) */
export function groupsFromClaim(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim !== 'string') return [];
  return claim
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

// ---------- 分割払い ----------

/** 各回の金額。割り切れない端数は 1 回目に足す (カード会社と同じ) */
export function installmentAmounts(total: number, count: number): number[] {
  const monthly = Math.floor(total / count);
  return [total - monthly * (count - 1), ...Array.from({ length: count - 1 }, () => monthly)];
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** 各回の日付。買った日と同じ日 (その月にない日なら月末)。start = next なら翌月から */
export function installmentDates(purchaseDate: string, count: number, start: 'this' | 'next'): string[] {
  const [y, m, d] = purchaseDate.split('-').map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(Date.UTC(y, m - 1 + i + (start === 'next' ? 1 : 0), 1));
    const yy = t.getUTCFullYear();
    const mm = t.getUTCMonth() + 1;
    const dd = Math.min(d, daysInMonth(yy, mm));
    return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  });
}

/** 繰り上げ返済: index 回目 (1 始まり) で残りをまとめて払う。その回の金額と、消す回を返す */
export function payoffSchedule<T extends { amount: number }>(schedule: T[], index: number): { kept: T[]; removed: T[] } {
  if (!Number.isInteger(index) || index < 1 || index > schedule.length) throw new Error('繰り上げ返済する回が不正です');
  const rest = schedule.slice(index - 1).reduce((s, p) => s + p.amount, 0);
  const kept = schedule.slice(0, index).map((p, i) => (i === index - 1 ? { ...p, amount: rest } : p));
  return { kept, removed: schedule.slice(index) };
}

/** 一覧用: 何回払ったか、残りいくらか (今日を含む日までに支払日が来た回を「支払済み」とする) */
export function summarizeInstallment(plan: InstallmentPlan, today: string): InstallmentSummary {
  const paid = plan.schedule.filter((p) => p.date <= today);
  const rest = plan.schedule.filter((p) => p.date > today);
  return {
    ...plan,
    monthly: Math.floor(plan.total / plan.count),
    paidCount: paid.length,
    remainingAmount: rest.reduce((s, p) => s + p.amount, 0),
    nextDate: rest[0]?.date ?? null,
    finished: rest.length === 0,
  };
}

