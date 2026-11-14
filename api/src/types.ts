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
  source: 'manual' | 'shortcut';
  /** ショートカットからの自動登録はカテゴリーを確認するまで false */
  confirmed: boolean;
  createdAt: string;
}

export type TransactionInput = Omit<Transaction, 'id' | 'createdAt' | 'source' | 'confirmed'> & {
  confirmed?: boolean;
};

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
