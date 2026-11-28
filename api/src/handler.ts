import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import * as db from './db.js';
import { isSubscription, pushStore } from './push.js';
import {
  categoryLabel,
  groupsFromClaim,
  installmentAmounts,
  installmentDates,
  isDate,
  isMonth,
  matchRule,
  normalize,
  parseAmount,
  parseCardMail,
  payoffSchedule,
  summarizeInstallment,
  todayJst,
  yen,
  type CardMail,
} from './logic.js';
import {
  isOpenAdvance,
  PAYMENT_LABELS,
  PAYMENT_METHODS,
  type Category,
  type InstallmentPlan,
  type InstallmentsResponse,
  type PaymentMethod,
  type ShortcutResult,
  type Transaction,
  type TxType,
} from './types.js';

/** W-SSO のグループ。このグループの人 (と管理者) だけが家計簿を使える */
const APP_GROUP = 'app-kakeibo';
const push = pushStore(process.env.TABLE_NAME ?? 'kakeibo');

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

/** 分割払いの指定 ({ count, start })。2 回以上のときだけ分割払いにする */
function parseInstallment(v: unknown, tx: { type: TxType; amount: number; advance: boolean }): { count: number; start: 'this' | 'next' } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { count?: unknown; start?: unknown };
  const count = Number(o.count);
  if (!Number.isFinite(count) || count < 2) return null;
  if (!Number.isInteger(count) || count > 60) throw new HttpError(400, '分割の回数は 2〜60 回で指定してください');
  if (tx.type !== 'expense') throw new HttpError(400, '分割払いにできるのは支出だけです');
  if (tx.advance) throw new HttpError(400, '立て替えは分割払いにできません');
  if (tx.amount < count) throw new HttpError(400, '金額が分割の回数より少ないです');
  return { count, start: o.start === 'next' ? 'next' : 'this' };
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
      const b = parseBody(event);
      const tx = validateTx(b, await db.listCategories(uid));
      const inst = parseInstallment(b.installment, tx);
      if (inst) {
        // 分割払い: 回数分の明細をまとめて作る (返すのは 1 回目の明細)
        const { txs } = await db.createInstallment(
          uid,
          { merchant: tx.merchant, categoryId: tx.categoryId, total: tx.amount, count: inst.count, start: inst.start, purchaseDate: tx.date },
          installmentDates(tx.date, inst.count, inst.start).map((date, i) => ({ date, amount: installmentAmounts(tx.amount, inst.count)[i]! })),
          { ...tx, source: 'manual', confirmed: true, advance: false, received: null },
        );
        return json(201, txs[0]);
      }
      return json(201, await db.createTransaction(uid, { ...tx, source: 'manual', confirmed: true }));
    }
    case 'PUT /transactions/{id}': {
      const old = await db.getTransaction(uid, id);
      if (!old) throw new HttpError(404, '明細がありません');
      const tx = validateTx(parseBody(event), await db.listCategories(uid));
      // 分割払いの回は、金額・日付・立て替えを変えない (分割払いの設定で決まる)
      const next: Transaction = old.installment
        ? { ...old, ...tx, amount: old.amount, date: old.date, advance: false, received: null, installment: old.installment, confirmed: true }
        : { ...old, ...tx, confirmed: true };
      const saved = await db.updateTransaction(uid, old, next);
      // waripo が作った明細 (割り勘の相手の負担分) は、カテゴリーを直しても店名ルールとして覚えない
      if (next.categoryId && next.categoryId !== old.categoryId && old.source !== 'waripo') await learnRule(uid, next.merchant, next.categoryId);
      // 分割払い: カテゴリーと店名は、ほかの回にも合わせる
      if (old.installment && (next.categoryId !== old.categoryId || next.merchant !== old.merchant)) {
        const plan = await db.getInstallment(uid, old.installment.planId);
        if (plan) {
          for (const p of plan.schedule) {
            if (p.txId !== old.id) await db.patchTransaction(uid, p.txId, { categoryId: next.categoryId, merchant: next.merchant, confirmed: true });
          }
          await db.putInstallment(uid, { ...plan, categoryId: next.categoryId, merchant: next.merchant });
        }
      }
      return json(200, saved);
    }
    case 'DELETE /transactions/{id}': {
      const old = await db.getTransaction(uid, id);
      if (old?.installment) throw new HttpError(400, '分割払いの回は 1 回分だけ削除できません。分割払いの画面から、分割払いごと削除してください');
      await db.deleteTransaction(uid, id);
      return json(200, { ok: true });
    }

    // 分割払い
    case 'GET /installments': {
      const today = todayJst();
      const plans = (await db.listInstallments(uid))
        .map((p) => summarizeInstallment(p, today))
        // 支払い中 (次の支払日が近い順) → 支払い終わったもの (新しい順)
        .sort((a, b) =>
          a.finished !== b.finished ? (a.finished ? 1 : -1) : a.finished ? (a.purchaseDate < b.purchaseDate ? 1 : -1) : (a.nextDate! < b.nextDate! ? -1 : 1),
        );
      const res: InstallmentsResponse = { threshold: (await db.getPrefs(uid)).installmentThreshold ?? null, plans };
      return json(200, res);
    }
    case 'PUT /installments/settings': {
      const v = parseBody(event).threshold;
      let threshold: number | null = null;
      if (v !== null && v !== undefined && v !== '' && v !== 0) {
        try {
          threshold = parseAmount(v);
        } catch (e) {
          throw new HttpError(400, `目安の金額: ${(e as Error).message}`);
        }
      }
      return json(200, { threshold: (await db.savePrefs(uid, { installmentThreshold: threshold })).installmentThreshold ?? null });
    }
    case 'POST /installments/{id}/payoff': {
      const plan = await db.getInstallment(uid, id);
      if (!plan) throw new HttpError(404, '分割払いがありません');
      let result: ReturnType<typeof payoffSchedule<InstallmentPlan['schedule'][number]>>;
      try {
        result = payoffSchedule(plan.schedule, Number(parseBody(event).index));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const last = result.kept.at(-1)!;
      const lastTx = await db.getTransaction(uid, last.txId);
      await db.patchTransaction(uid, last.txId, {
        amount: last.amount,
        ...(lastTx?.installment && { installment: { ...lastTx.installment, payoff: result.removed.length > 0 || lastTx.installment.payoff } }),
      });
      for (const p of result.removed) await db.deleteTransaction(uid, p.txId);
      const next: InstallmentPlan = { ...plan, schedule: result.kept, paidOffAt: result.removed.length ? result.kept.length : plan.paidOffAt };
      await db.putInstallment(uid, next);
      return json(200, summarizeInstallment(next, todayJst()));
    }
    case 'DELETE /installments/{id}': {
      const plan = await db.getInstallment(uid, id);
      if (!plan) throw new HttpError(404, '分割払いがありません');
      for (const p of plan.schedule) await db.deleteTransaction(uid, p.txId);
      await db.deleteInstallment(uid, id);
      return json(200, { ok: true });
    }

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

    // 通知 (Web プッシュ)。端末ごとに登録し、種類ごとにオン/オフできる
    case 'GET /push':
      return json(200, { publicKey: await push.publicKey(), settings: await push.settings(uid), devices: await push.deviceCount(uid) });
    case 'POST /push/subscriptions': {
      const b = parseBody(event);
      if (!isSubscription(b.subscription)) throw new HttpError(400, '通知の登録情報が不正です');
      if ((await push.deviceCount(uid)) >= 10) throw new HttpError(400, '通知を受け取る端末は 10 台までです');
      await push.subscribe(uid, b.subscription, str(b.device, 200));
      return json(201, { ok: true });
    }
    case 'POST /push/unsubscribe': {
      const endpoint = str(parseBody(event).endpoint, 2000);
      if (endpoint) await push.unsubscribe(uid, endpoint);
      return json(200, { ok: true });
    }
    case 'PUT /push/settings': {
      const b = parseBody(event);
      return json(200, await push.saveSettings(uid, { mail: b.mail === true, waripo: b.waripo === true }));
    }
    case 'POST /push/test':
      return json(200, { sent: await push.notify(uid, null, { title: 'MyKakeibo!', body: 'テスト通知です。記録したときはこのように届きます', url: '/', tag: 'test' }) });

    // 利用通知メールの読み取りテスト (記録はしない)。画面で本文を貼り付けて、正しく読めるか確かめる
    case 'POST /mail/preview': {
      const text = str(parseBody(event).text, 50_000);
      if (!text) throw new HttpError(400, 'メールの本文を貼り付けてください');
      try {
        return json(200, { ok: true, ...parseCardMail(text) });
      } catch (e) {
        return json(200, { ok: false, message: (e as Error).message });
      }
    }

    default:
      throw new HttpError(404, 'Not Found');
  }
}

interface RecordInput {
  date: string;
  type: TxType;
  amount: number;
  merchant: string;
  /** 指定されたカテゴリー (「食費 > 外食」のような表示名・名前・id)。空なら店名のルールで決める */
  category: string;
  payment: PaymentMethod;
  memo: string;
  source: 'shortcut' | 'mail';
  advance: boolean;
}

/** ショートカット・メールからの記録。カテゴリーは 1) 指定 2) 店名のルール 3) 未分類のまま未確認 の順で決める */
async function record(uid: string, r: RecordInput): Promise<ShortcutResult> {
  const categories = await db.listCategories(uid);
  let categoryId: string | null = null;
  let confirmed = false;
  if (r.category) {
    const hit = categories.find((c) => categoryLabel(c.id, categories) === r.category || c.name === r.category || c.id === r.category);
    if (hit) {
      categoryId = hit.id;
      confirmed = true;
    }
  }
  if (!categoryId) {
    const rule = matchRule(r.merchant, await db.listRules(uid));
    if (rule && categories.some((c) => c.id === rule.categoryId)) {
      categoryId = rule.categoryId;
      confirmed = true;
    }
  }
  const tx = await db.createTransaction(uid, {
    date: r.date,
    type: r.type,
    amount: r.amount,
    categoryId,
    payment: r.payment,
    merchant: r.merchant,
    memo: r.memo,
    source: r.source,
    confirmed,
    advance: r.advance,
    received: null,
  });
  const label = categoryLabel(categoryId, categories);
  const shop = r.merchant ? ` (${r.merchant})` : '';
  return {
    id: tx.id,
    amount: r.amount,
    merchant: r.merchant,
    category: label,
    confirmed,
    message: confirmed
      ? `${yen(r.amount)}${shop} を「${label}」で記録しました`
      : `${yen(r.amount)}${shop} を記録しました。カテゴリーを確認してください`,
  };
}

/** ログ用: 値の形だけを表す (中身は出さない) */
function describe(v: unknown): string {
  if (typeof v === 'string') return `string(${v.length})`;
  if (Array.isArray(v)) return `array(${v.length})[${v.map(describe).slice(0, 3).join(',')}]`;
  if (v && typeof v === 'object') return `object{${Object.keys(v).slice(0, 10).join(',')}}`;
  return typeof v;
}

/** 文字・一覧 (複数のメール)・入れ子のオブジェクトのどれで届いても、文字をつなげて本文にする */
function flattenText(v: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => flattenText(x, depth + 1)).filter(Boolean).join('\n');
  if (v && typeof v === 'object') return Object.values(v).map((x) => flattenText(x, depth + 1)).filter(Boolean).join('\n');
  return '';
}

/** ショートカットで項目名を間違えやすいので、text 以外の名前でも受け付ける */
function mailText(b: Record<string, unknown>): string {
  for (const key of ['text', 'content', 'contents', 'body', 'message', 'コンテンツ']) {
    const t = flattenText(b[key]).trim();
    if (t) return t.slice(0, 50_000);
  }
  return flattenText(b).trim().slice(0, 50_000);
}

// ---------- iPhone のショートカットから使う API (トークン認証) ----------

async function shortcutRoute(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  // トークンは Authorization ヘッダ、本文の token 項目、URL の ?token= のどれでもよい
  // (iPhone でヘッダに全角スペースなどが入ると、リクエストごと拒否されて原因が分かりにくいため)
  const auth = (event.headers.authorization ?? '').replace(/^Bearer[\s\u3000]+/i, '').trim();
  let bodyToken = '';
  try {
    const t = parseBody(event).token;
    if (typeof t === 'string') bodyToken = t.trim();
  } catch {
    /* 本文が JSON でないときはヘッダか URL のトークンを使う */
  }
  const token = auth || bodyToken || (event.queryStringParameters?.token ?? '').trim();
  const uid = token ? await db.userIdFromToken(token) : undefined;
  if (!uid) throw new HttpError(401, 'トークンが無効です。MyKakeibo! の設定画面で発行し直してください');
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
      let amount: number;
      try {
        amount = parseAmount(b.amount);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const card = str(b.card, 50);
      const type = txType(b.type);
      return json(
        201,
        await record(uid, {
          date: isDate(b.date) ? b.date : todayJst(),
          type,
          amount,
          merchant: str(b.merchant),
          category: str(b.category),
          payment: payment(b.payment, card ? 'applepay' : 'other'),
          memo: str(b.memo, 300) || card,
          source: 'shortcut',
          advance: type === 'expense' && isTrue(b.advance),
        }),
      );
    }

    // カード会社の利用通知メール (iPhone の「メール」オートメーションから本文を送る)
    case 'POST /shortcut/mail': {
      // ここでのエラーは iPhone では「Bad Request」としか見えないことがあるので、すべて 200 で理由を返す
      let b: Record<string, unknown>;
      try {
        b = parseBody(event);
      } catch {
        console.warn('mail: body is not JSON', { contentType: event.headers['content-type'], length: event.body?.length ?? 0 });
        return json(200, { message: '記録できませんでした: 本文が JSON ではありません。「本文を要求」を JSON にしてください' });
      }
      // 調査用に、届いた項目の名前と形だけを残す (本文の中身は残さない)
      console.info('mail: received', Object.fromEntries(Object.entries(b).map(([k, v]) => [k, describe(v)])));
      const text = mailText(b);
      if (!text) {
        return json(200, {
          message: `記録できませんでした: メールの本文が空です (届いた項目: ${Object.keys(b).join(', ') || 'なし'})。「本文を要求」の項目 text の値を「コンテンツ」にしてください`,
        });
      }
      let mail: CardMail;
      try {
        mail = parseCardMail(text);
      } catch {
        // お知らせなど利用通知ではないメールでもオートメーションは動くので、エラーにせず何もしない
        return json(200, { message: 'カードの利用通知ではないため、記録しませんでした' });
      }
      // 同じメールが 2 回届いた・オートメーションが 2 回動いたときに二重に記録しない
      const same = (await db.listTransactions(uid, mail.date.slice(0, 7))).find(
        (t) => t.source === 'mail' && t.date === mail.date && t.amount === mail.amount && t.merchant === mail.merchant,
      );
      if (same) {
        const result: ShortcutResult = {
          id: same.id,
          amount: same.amount,
          merchant: same.merchant,
          category: categoryLabel(same.categoryId, await db.listCategories(uid)),
          confirmed: same.confirmed,
          message: `${yen(same.amount)} (${same.merchant}) は記録済みです`,
        };
        return json(200, result);
      }
      const recorded = await record(uid, {
        date: mail.date,
        type: 'expense',
        amount: mail.amount,
        merchant: mail.merchant,
        category: '',
        payment: 'card',
        memo: mail.card,
        source: 'mail',
        advance: false,
      });
      // iPhone に通知 (設定でオフにしていれば送らない)。未確認なら、押すと「未確認」の画面を開く
      await push.notify(uid, 'mail', {
        title: 'MyKakeibo! に記録しました',
        body: `${yen(recorded.amount)} ${recorded.merchant || '(店名なし)'}${recorded.confirmed ? `・${recorded.category}` : '・カテゴリーを確認してください'}`,
        url: recorded.confirmed ? '/' : '/?tab=inbox',
        tag: recorded.id,
      });
      return json(201, recorded);
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
    // W-SSO のアカウントのうち、家計簿を使えるのは admin か app-kakeibo グループの人だけ
    const groups = groupsFromClaim(claims?.['cognito:groups']);
    if (!groups.includes('admin') && !groups.includes(APP_GROUP)) {
      throw new HttpError(403, 'MyKakeibo! を使う権限がありません。ダッシュボード (apps.wakalabo.net) の管理者に追加してもらってください');
    }
    return await appRoute(event as APIGatewayProxyEventV2WithJWTAuthorizer, uid);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { message: e.message });
    console.error(e);
    return json(500, { message: e instanceof Error ? e.message : 'エラーが発生しました' });
  }
}
