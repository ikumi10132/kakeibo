// API と画面で共有する型

export type TxType = 'expense' | 'income';

export const PAYMENT_METHODS = ['applepay', 'qr', 'cash', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  applepay: 'Apple Pay',
  qr: 'QR決済',
  cash: '現金',
  card: 'カード',
  other: 'その他',
};

export interface Category {
  id: string;
  name: string;
  type: TxType;
  /** 親カテゴリーの id。親自身は null */
  parentId: string | null;
  /** 絵文字 1 文字 */
  icon: string;
  /** #rrggbb */
  color: string;
  order: number;
}

export interface Transaction {
  /** "YYYY-MM-DD_xxxx" の形。日付を含めて DynamoDB のキーを引けるようにしている */
  id: string;
  date: string;
  type: TxType;
  /** 円 (整数、正の数) */
  amount: number;
  categoryId: string | null;
  payment: PaymentMethod;
  merchant: string;
  memo: string;
  /** shortcut: Apple Pay などショートカット、mail: カード会社の利用通知メール、waripo: 割り勘アプリが作った明細、mytask: MyTask! でタスクを完了したときの支出 */
  source: 'manual' | 'shortcut' | 'mail' | 'waripo' | 'mytask';
  /** ショートカットからの自動登録はカテゴリーを確認するまで false */
  confirmed: boolean;
  /** 立て替え (あとで他の人からお金を受け取る支出)。古いデータには無いので未定義は false 扱い */
  advance?: boolean;
  /** 立て替えで受け取った額。null / 未定義なら未精算。自分の負担 = amount - received */
  received?: number | null;
  /** waripo (割り勘アプリ) で割り勘にした明細。waripo が書き込む */
  split?: {
    entryId: string;
    /** payer: 自分が払って相手の分を立て替えた。partner: 相手が払った分のうち自分の負担 */
    role: 'payer' | 'partner';
    /** payer のときの相手の負担額 */
    otherShare?: number;
  };
  createdAt: string;
}

export type TransactionInput = Omit<Transaction, 'id' | 'createdAt' | 'source' | 'confirmed'> & {
  confirmed?: boolean;
};

/**
 * 自分の負担額。立て替えは受け取った額を差し引く (未精算の間は全額)。
 * waripo で割り勘にして自分が払った明細は、相手の負担分を差し引く (相手の家計簿に相手の分が入る)
 */
export const ownAmount = (t: Pick<Transaction, 'amount' | 'advance' | 'received' | 'split'>): number => {
  if (t.split?.role === 'payer') return t.amount - (t.split.otherShare ?? 0);
  return t.advance ? t.amount - (t.received ?? 0) : t.amount;
};

export const isOpenAdvance = (t: Pick<Transaction, 'advance' | 'received'>): boolean =>
  !!t.advance && (t.received === null || t.received === undefined);

export interface Rule {
  id: string;
  /** 店名にこの文字が含まれていたら categoryId に振り分ける */
  keyword: string;
  categoryId: string;
  /** 手で直したときに自動で作られたものか */
  auto: boolean;
}

export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** 作成直後だけトークン本体を返す (保存しているのはハッシュのみ) */
export interface CreatedToken extends ApiToken {
  token: string;
}

export interface ShortcutResult {
  id: string;
  amount: number;
  merchant: string;
  category: string;
  confirmed: boolean;
  /** iPhone の通知にそのまま出せる文 */
  message: string;
}

