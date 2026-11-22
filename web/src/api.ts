import type { ApiToken, Category, CreatedToken, Rule, Transaction, TransactionInput } from '../../api/src/types';
import { getAccessToken } from './auth';
import { getConfig } from './config';

export class AuthError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new AuthError('ログインが必要です');
  const res = await fetch(`${getConfig().apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) throw new AuthError('ログインの有効期限が切れました');
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `エラーが発生しました (${res.status})`);
  return body;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const enc = encodeURIComponent;

export const api = {
  categories: () => call<Category[]>('/categories'),
  createCategory: (c: Omit<Category, 'id'>) => send<Category>('POST', '/categories', c),
  updateCategory: (c: Category) => send<Category>('PUT', `/categories/${enc(c.id)}`, c),
  deleteCategory: (id: string, moveTo: string | null) =>
    send<{ ok: true }>('DELETE', `/categories/${enc(id)}${moveTo ? `?moveTo=${enc(moveTo)}` : ''}`),

  transactions: (month: string) => call<Transaction[]>(`/transactions?month=${month}`),
  unconfirmed: () => call<Transaction[]>('/transactions?unconfirmed=1'),
  openAdvances: () => call<Transaction[]>('/transactions?advance=open'),
  createTransaction: (t: TransactionInput) => send<Transaction>('POST', '/transactions', t),
  updateTransaction: (id: string, t: TransactionInput) => send<Transaction>('PUT', `/transactions/${enc(id)}`, t),
  deleteTransaction: (id: string) => send<{ ok: true }>('DELETE', `/transactions/${enc(id)}`),

  rules: () => call<Rule[]>('/rules'),
  createRule: (keyword: string, categoryId: string) => send<Rule>('POST', '/rules', { keyword, categoryId }),
  deleteRule: (id: string) => send<{ ok: true }>('DELETE', `/rules/${enc(id)}`),

  tokens: () => call<ApiToken[]>('/tokens'),
  createToken: (name: string) => send<CreatedToken>('POST', '/tokens', { name }),
  deleteToken: (id: string) => send<{ ok: true }>('DELETE', `/tokens/${enc(id)}`),

  push: () => call<PushInfo>('/push'),
  subscribePush: (subscription: PushSubscriptionJSON, device: string) => send<{ ok: true }>('POST', '/push/subscriptions', { subscription, device }),
  unsubscribePush: (endpoint: string) => send<{ ok: true }>('POST', '/push/unsubscribe', { endpoint }),
  savePushSettings: (s: NotifySettings) => send<NotifySettings>('PUT', '/push/settings', s),
  testPush: () => send<{ sent: number }>('POST', '/push/test'),

  previewMail: (text: string) => send<MailPreview>('POST', '/mail/preview', { text }),
};

export interface NotifySettings {
  mail: boolean;
  waripo: boolean;
}
export interface PushInfo {
  publicKey: string;
  settings: NotifySettings;
  devices: number;
}
export type MailPreview = { ok: true; date: string; amount: number; merchant: string; card: string } | { ok: false; message: string };
