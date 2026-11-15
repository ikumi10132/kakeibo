import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import * as db from './db.js';
import { categoryLabel, isDate, isMonth, matchRule, normalize, parseAmount, todayJst, yen } from './logic.js';
import {
  isOpenAdvance,
  PAYMENT_LABELS,
  PAYMENT_METHODS,
  type Category,
  type PaymentMethod,
  type ShortcutResult,
  type Transaction,
  type TxType,
} from './types.js';

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下でエラーにする */
  }
  throw new HttpError(400, '本文は JSON オブジェクトで送ってください');
}

const str = (v: unknown, max = 100): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const txType = (v: unknown): TxType => (v === 'income' ? 'income' : 'expense');

function payment(v: unknown, fallback: PaymentMethod): PaymentMethod {
  const s = str(v);
  if ((PAYMENT_METHODS as readonly string[]).includes(s)) return s as PaymentMethod;
  const byLabel = Object.entries(PAYMENT_LABELS).find(([, label]) => label === s);
  return byLabel ? (byLabel[0] as PaymentMethod) : fallback;
}

// ---------- 画面から使う API (Cognito ログイン必須) ----------

function validateCategory(b: Record<string, unknown>, categories: Category[], selfId?: string): Omit<Category, 'id'> {
  const name = str(b.name, 30);
  if (!name) throw new HttpError(400, 'カテゴリー名を入力してください');
  const parentId = b.parentId ? str(b.parentId) : null;
  if (parentId) {
    const parent = categories.find((c) => c.id === parentId);
    if (!parent) throw new HttpError(400, '親カテゴリーがありません');
    if (parent.parentId) throw new HttpError(400, 'カテゴリーは 2 階層までです');
    if (parentId === selfId) throw new HttpError(400, '自分自身を親にはできません');
    if (selfId && categories.some((c) => c.parentId === selfId)) {
      throw new HttpError(400, '子カテゴリーを持つカテゴリーは、他の子にできません');
    }
  }
  const color = /^#[0-9a-f]{6}$/i.test(str(b.color)) ? str(b.color) : '#8e8e93';
  return {
    name,
    type: txType(b.type),
    parentId,
    icon: str(b.icon, 8) || '📁',
    color,
    order: typeof b.order === 'number' ? b.order : Date.now() % 1e9,
  };
}

function validateTx(b: Record<string, unknown>, categories: Category[]) {
  const date = isDate(b.date) ? b.date : todayJst();
  const categoryId = b.categoryId ? str(b.categoryId) : null;
  if (categoryId && !categories.some((c) => c.id === categoryId)) throw new HttpError(400, 'カテゴリーがありません');
  let amount: number;
  try {
    amount = parseAmount(b.amount);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const type = txType(b.type);
  const advance = type === 'expense' && isTrue(b.advance);
  return {
    date,
    type,
    amount,
    categoryId,
    payment: payment(b.payment, 'other'),
    merchant: str(b.merchant),
    memo: str(b.memo, 300),
    advance,
    received: advance ? parseReceived(b.received, amount) : null,
  };
}

const isTrue = (v: unknown) => v === true || v === 'true' || v === 'はい';

/** 立て替えで受け取った額。空なら未精算 (null)。0 円 (結局もらえなかった) も可 */
function parseReceived(v: unknown, amount: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).normalize('NFKC').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, '受け取った額が不正です');
  const r = Math.round(n);
  if (r > amount) throw new HttpError(400, '受け取った額が支払った金額を超えています');
  return r;
}

/** 手でカテゴリーを直したとき、その店名をルールとして覚える */
async function learnRule(uid: string, merchant: string, categoryId: string): Promise<void> {
  if (!merchant) return;
  const rules = await db.listRules(uid);
  if (matchRule(merchant, rules)?.categoryId === categoryId) return;
  const same = rules.find((r) => normalize(r.keyword) === normalize(merchant));
  await db.putRule(uid, { id: same?.id, keyword: merchant, categoryId, auto: same ? same.auto : true });
}

async function appRoute(event: APIGatewayProxyEventV2WithJWTAuthorizer, uid: string): Promise<APIGatewayProxyStructuredResultV2> {
  const id = event.pathParameters?.id ? decodeURIComponent(event.pathParameters.id) : '';
  const q = event.queryStringParameters ?? {};
  await db.ensureSeeded(uid); // 初回だけ既定のカテゴリーとルールを作る (2 回目以降は読み取り 1 回)

  switch (event.routeKey) {
    // カテゴリー
    case 'GET /categories':
      return json(200, await db.listCategories(uid));
    case 'POST /categories': {
      const categories = await db.listCategories(uid);
      return json(201, await db.putCategory(uid, validateCategory(parseBody(event), categories)));
    }
    case 'PUT /categories/{id}': {
      const categories = await db.listCategories(uid);
      if (!categories.some((c) => c.id === id)) throw new HttpError(404, 'カテゴリーがありません');
      return json(200, await db.putCategory(uid, { ...validateCategory(parseBody(event), categories, id), id }));
    }
    case 'DELETE /categories/{id}':
      try {
        await db.deleteCategory(uid, id, q.moveTo || null);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return json(200, { ok: true });

    // 明細
    case 'GET /transactions': {
      if (q.unconfirmed) return json(200, (await db.listTransactions(uid)).filter((t) => !t.confirmed));
      if (q.advance === 'open') return json(200, (await db.listTransactions(uid)).filter(isOpenAdvance));
      if (!isMonth(q.month)) throw new HttpError(400, 'month=YYYY-MM を指定してください');
      return json(200, await db.listTransactions(uid, q.month));
    }
    case 'POST /transactions': {
      const tx = validateTx(parseBody(event), await db.listCategories(uid));
      return json(201, await db.createTransaction(uid, { ...tx, source: 'manual', confirmed: true }));
    }
    case 'PUT /transactions/{id}': {
      const old = await db.getTransaction(uid, id);
      if (!old) throw new HttpError(404, '明細がありません');
      const tx = validateTx(parseBody(event), await db.listCategories(uid));
      const next: Transaction = { ...old, ...tx, confirmed: true };
      const saved = await db.updateTransaction(uid, old, next);
      if (next.categoryId && next.categoryId !== old.categoryId) await learnRule(uid, next.merchant, next.categoryId);
      return json(200, saved);
    }
    case 'DELETE /transactions/{id}':
      await db.deleteTransaction(uid, id);
      return json(200, { ok: true });

    // 自動振り分けルール
    case 'GET /rules':
      return json(200, await db.listRules(uid));
    case 'POST /rules': {
      const b = parseBody(event);
      const keyword = str(b.keyword, 50);
      const categoryId = str(b.categoryId);
      if (!keyword) throw new HttpError(400, 'キーワードを入力してください');
      if (!(await db.listCategories(uid)).some((c) => c.id === categoryId)) throw new HttpError(400, 'カテゴリーがありません');
      return json(201, await db.putRule(uid, { id: str(b.id) || undefined, keyword, categoryId, auto: false }));
    }
    case 'DELETE /rules/{id}':
      await db.deleteRule(uid, id);
      return json(200, { ok: true });

    // ショートカット用トークン
    case 'GET /tokens':
      return json(200, await db.listTokens(uid));
    case 'POST /tokens': {
      if ((await db.listTokens(uid)).length >= 10) throw new HttpError(400, 'トークンは 10 個までです');
      return json(201, await db.createToken(uid, str(parseBody(event).name, 40) || 'iPhone'));
    }
    case 'DELETE /tokens/{id}':
      await db.deleteToken(uid, id);
      return json(200, { ok: true });

    default:
      throw new HttpError(404, 'Not Found');
  }
}

// ---------- iPhone のショートカットから使う API (トークン認証) ----------

async function shortcutRoute(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const auth = event.headers.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const uid = token ? await db.userIdFromToken(token) : undefined;
  if (!uid) throw new HttpError(401, 'トークンが無効です。家計簿の設定画面で発行し直してください');
  await db.ensureSeeded(uid);

  switch (event.routeKey) {
    // 手入力用ショートカットの「リストから選択」に使う
    case 'GET /shortcut/categories': {
      const type = txType(event.queryStringParameters?.type);
      const categories = await db.listCategories(uid);
      const ordered = categories
        .filter((c) => c.type === type && !c.parentId)
        .flatMap((p) => [p, ...categories.filter((c) => c.parentId === p.id)]);
      return json(200, ordered.map((c) => categoryLabel(c.id, categories)));
    }

    case 'POST /shortcut/transactions': {
      const b = parseBody(event);
      const categories = await db.listCategories(uid);
      let amount: number;
      try {
        amount = parseAmount(b.amount);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const merchant = str(b.merchant);
      const card = str(b.card, 50);
      const type = txType(b.type);

      // カテゴリーの決め方: 1) 指定があればそれ (手入力) 2) 店名のルール 3) 未分類のまま未確認にする
      let categoryId: string | null = null;
      let confirmed = false;
      const wanted = str(b.category);
      if (wanted) {
        const hit = categories.find((c) => categoryLabel(c.id, categories) === wanted || c.name === wanted || c.id === wanted);
        if (hit) {
          categoryId = hit.id;
          confirmed = true;
        }
      }
      if (!categoryId) {
        const rule = matchRule(merchant, await db.listRules(uid));
        if (rule && categories.some((c) => c.id === rule.categoryId)) {
          categoryId = rule.categoryId;
          confirmed = true;
        }
      }

      const tx = await db.createTransaction(uid, {
        date: isDate(b.date) ? b.date : todayJst(),
        type,
        amount,
        categoryId,
        payment: payment(b.payment, card ? 'applepay' : 'other'),
        merchant,
        memo: str(b.memo, 300) || (card ? card : ''),
        source: 'shortcut',
        confirmed,
        advance: type === 'expense' && isTrue(b.advance),
        received: null,
      });
      const label = categoryLabel(categoryId, categories);
      const result: ShortcutResult = {
        id: tx.id,
        amount,
        merchant,
        category: label,
        confirmed,
        message: confirmed
          ? `${yen(amount)}${merchant ? ` (${merchant})` : ''} を「${label}」で記録しました`
          : `${yen(amount)}${merchant ? ` (${merchant})` : ''} を記録しました。カテゴリーを確認してください`,
      };
      return json(201, result);
    }

    default:
      throw new HttpError(404, 'Not Found');
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    if (event.routeKey.includes(' /shortcut/')) return await shortcutRoute(event);
    const claims = (event as APIGatewayProxyEventV2WithJWTAuthorizer).requestContext.authorizer?.jwt?.claims;
    const uid = typeof claims?.sub === 'string' ? claims.sub : undefined;
    if (!uid) throw new HttpError(401, 'ログインが必要です');
    return await appRoute(event as APIGatewayProxyEventV2WithJWTAuthorizer, uid);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { message: e.message });
    console.error(e);
    return json(500, { message: e instanceof Error ? e.message : 'エラーが発生しました' });
  }
}
