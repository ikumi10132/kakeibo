// DynamoDB をメモリ上の簡易版に差し替えて、API を通しで動かすテスト
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handler } from '../src/handler.js';
import type { Category, CreatedToken, Rule, ShortcutResult, Transaction } from '../src/types.js';

type Item = Record<string, unknown> & { PK: string; SK: string };
const store = new Map<string, Item>();
const key = (k: { PK: unknown; SK: unknown }) => `${k.PK}|${k.SK}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(DynamoDBDocumentClient.prototype as any).send = async function (cmd: { constructor: { name: string }; input: any }) {
  const i = cmd.input;
  switch (cmd.constructor.name) {
    case 'GetCommand':
      return { Item: structuredClone(store.get(key(i.Key))) };
    case 'PutCommand':
      if (i.ConditionExpression?.includes('attribute_not_exists') && store.has(key(i.Item))) {
        const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
        throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
      }
      store.set(key(i.Item), structuredClone(i.Item));
      return {};
    case 'DeleteCommand':
      store.delete(key(i.Key));
      return {};
    case 'UpdateCommand': {
      const it = store.get(key(i.Key));
      if (it) it.lastUsedAt = i.ExpressionAttributeValues[':t'];
      return {};
    }
    case 'QueryCommand': {
      const pk = i.ExpressionAttributeValues[':pk'];
      const sk = i.ExpressionAttributeValues[':sk'];
      const Items = [...store.values()]
        .filter((x) => x.PK === pk && x.SK.startsWith(sk))
        .sort((a, b) => (a.SK < b.SK ? -1 : 1))
        .map((x) => structuredClone(x));
      return { Items };
    }
    case 'BatchWriteCommand':
      for (const reqs of Object.values(i.RequestItems) as { PutRequest: { Item: Item } }[][]) {
        for (const r of reqs) store.set(key(r.PutRequest.Item), structuredClone(r.PutRequest.Item));
      }
      return {};
    case 'TransactWriteCommand':
      for (const t of i.TransactItems) {
        if (t.Put) store.set(key(t.Put.Item), structuredClone(t.Put.Item));
        if (t.Delete) store.delete(key(t.Delete.Key));
      }
      return {};
    default:
      throw new Error(`未対応: ${cmd.constructor.name}`);
  }
};

const USER = 'user-a';

async function call<T>(
  routeKey: string,
  opts: { body?: unknown; path?: Record<string, string>; query?: Record<string, string>; token?: string; user?: string | null } = {},
): Promise<{ status: number; body: T }> {
  const event = {
    routeKey,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    pathParameters: opts.path,
    queryStringParameters: opts.query,
    requestContext: opts.user === null ? {} : { authorizer: { jwt: { claims: { sub: opts.user ?? USER } } } },
  } as unknown as APIGatewayProxyEventV2;
  const res = (await handler(event)) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode!, body: JSON.parse(res.body as string) as T };
}

async function issueToken(user = USER): Promise<string> {
  const r = await call<CreatedToken>('POST /tokens', { body: { name: 'iPhone' }, user });
  assert.equal(r.status, 201);
  return r.body.token;
}

beforeEach(() => store.clear());

test('初回アクセスで既定のカテゴリーが作られる', async () => {
  const r = await call<Category[]>('GET /categories');
  assert.equal(r.status, 200);
  assert.ok(r.body.some((c) => c.id === 'food-eatout' && c.parentId === 'food'));
  const again = await call<Category[]>('GET /categories');
  assert.equal(again.body.length, r.body.length); // 二重に作られない
});

test('Apple Pay のショートカット: ルールに当たれば確定、当たらなければ未確認', async () => {
  const token = await issueToken();

  const hit = await call<ShortcutResult>('POST /shortcut/transactions', {
    token,
    user: null,
    body: { amount: '¥1,234', merchant: 'セブン-イレブン 渋谷店', card: 'Suica以外のカード' },
  });
  assert.equal(hit.status, 201);
  assert.equal(hit.body.amount, 1234);
  assert.equal(hit.body.category, '食費 > 食料品');
  assert.ok(hit.body.confirmed);
  assert.match(hit.body.message, /¥1,234.*食費 > 食料品/);

  const miss = await call<ShortcutResult>('POST /shortcut/transactions', {
    token,
    user: null,
    body: { amount: '¥880', merchant: '町の定食屋' },
  });
  assert.equal(miss.body.category, '未分類');
  assert.equal(miss.body.confirmed, false);

  const inbox = await call<Transaction[]>('GET /transactions', { query: { unconfirmed: '1' } });
  assert.deepEqual(inbox.body.map((t) => t.merchant), ['町の定食屋']);
  assert.equal(inbox.body[0]!.payment, 'other');

  // 未確認の明細のカテゴリーを決めると、店名がルールとして記憶される
  const tx = inbox.body[0]!;
  const fixed = await call<Transaction>('PUT /transactions/{id}', {
    path: { id: tx.id },
    body: { ...tx, categoryId: 'food-eatout' },
  });
  assert.equal(fixed.status, 200);
  assert.ok(fixed.body.confirmed);
  const rules = await call<Rule[]>('GET /rules');
  assert.ok(rules.body.some((r) => r.keyword === '町の定食屋' && r.categoryId === 'food-eatout' && r.auto));

  const next = await call<ShortcutResult>('POST /shortcut/transactions', {
    token,
    user: null,
    body: { amount: '¥900', merchant: '町の定食屋' },
  });
  assert.equal(next.body.category, '食費 > 外食');
});

test('手入力用ショートカット: カテゴリー一覧と、名前・支払方法の指定', async () => {
  const token = await issueToken();
  const list = await call<string[]>('GET /shortcut/categories', { token, user: null });
  assert.ok(list.body.includes('食費 > カフェ'));
  assert.ok(!list.body.includes('給与'));

  const r = await call<ShortcutResult>('POST /shortcut/transactions', {
    token,
    user: null,
    body: { amount: 500, category: '食費 > カフェ', payment: 'QR決済' },
  });
  assert.ok(r.body.confirmed);
  const month = (await call<Transaction[]>('GET /transactions', { query: { month: r.body.id.slice(0, 7) } })).body;
  assert.equal(month.find((t) => t.id === r.body.id)?.payment, 'qr');
});

test('トークンがない・無効・削除済みなら記録できない', async () => {
  assert.equal((await call('POST /shortcut/transactions', { user: null, body: { amount: 1 } })).status, 401);
  assert.equal((await call('POST /shortcut/transactions', { token: 'kb_nope', user: null, body: { amount: 1 } })).status, 401);
  const token = await issueToken();
  const [info] = (await call<{ id: string }[]>('GET /tokens')).body;
  assert.ok(!('hash' in info!)); // ハッシュは画面に返さない
  await call('DELETE /tokens/{id}', { path: { id: info!.id } });
  assert.equal((await call('POST /shortcut/transactions', { token, user: null, body: { amount: 1 } })).status, 401);
});

test('ユーザーごとにデータが分かれている', async () => {
  await call('POST /transactions', { body: { amount: 1000, date: '2026-11-01', categoryId: 'daily' } });
  const other = await call<Transaction[]>('GET /transactions', { query: { month: '2026-11' }, user: 'user-b' });
  assert.equal(other.body.length, 0);
  const tokenB = await issueToken('user-b');
  await call('POST /shortcut/transactions', { token: tokenB, user: null, body: { amount: 1, date: '2026-11-02' } });
  const mine = await call<Transaction[]>('GET /transactions', { query: { month: '2026-11' } });
  assert.equal(mine.body.length, 1);
});

test('日付を変えると別の月に移り、カテゴリー削除で明細が付け替わる', async () => {
  const created = await call<Transaction>('POST /transactions', {
    body: { amount: '2,000', date: '2026-10-31', categoryId: 'food-cafe', merchant: 'カフェ' },
  });
  assert.equal(created.body.amount, 2000);
  const moved = await call<Transaction>('PUT /transactions/{id}', {
    path: { id: created.body.id },
    body: { ...created.body, date: '2026-11-01' },
  });
  assert.ok(moved.body.id.startsWith('2026-11-01_'));
  assert.equal((await call<Transaction[]>('GET /transactions', { query: { month: '2026-10' } })).body.length, 0);

  assert.equal((await call('DELETE /categories/{id}', { path: { id: 'food' } })).status, 400); // 子があるので不可
  await call('DELETE /categories/{id}', { path: { id: 'food-cafe' }, query: { moveTo: 'food' } });
  const [tx] = (await call<Transaction[]>('GET /transactions', { query: { month: '2026-11' } })).body;
  assert.equal(tx!.categoryId, 'food');
});

test('入力のチェック', async () => {
  assert.equal((await call('POST /transactions', { body: { amount: '' } })).status, 400);
  assert.equal((await call('POST /transactions', { body: { amount: 100, categoryId: 'nope' } })).status, 400);
  assert.equal((await call('GET /transactions', { query: { month: '2026/11' } })).status, 400);
  assert.equal((await call('POST /categories', { body: { name: '孫', parentId: 'food-cafe' } })).status, 400);
  assert.equal((await call('GET /categories', { user: null })).status, 401);
});

test('立て替え: 受け取った額を後から登録し、差額が自分の負担になる', async () => {
  const created = await call<Transaction>('POST /transactions', {
    body: { amount: 6000, date: '2026-11-03', categoryId: 'social', merchant: '居酒屋', advance: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.advance, true);
  assert.equal(created.body.received, null);

  const open = await call<Transaction[]>('GET /transactions', { query: { advance: 'open' } });
  assert.deepEqual(open.body.map((t) => t.id), [created.body.id]);

  assert.equal(
    (await call('PUT /transactions/{id}', { path: { id: created.body.id }, body: { ...created.body, received: 7000 } })).status,
    400,
  );
  const settled = await call<Transaction>('PUT /transactions/{id}', {
    path: { id: created.body.id },
    body: { ...created.body, received: '4,000' },
  });
  assert.equal(settled.body.received, 4000);
  assert.equal((await call<Transaction[]>('GET /transactions', { query: { advance: 'open' } })).body.length, 0);

  // 収入には立て替えを付けられない
  const income = await call<Transaction>('POST /transactions', { body: { amount: 100, type: 'income', advance: true } });
  assert.equal(income.body.advance, false);
});

test('管理者 API は admin グループのときだけ使える', async () => {
  const res = await handler({
    routeKey: 'GET /admin/users',
    headers: {},
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: USER } } } },
  } as unknown as APIGatewayProxyEventV2);
  assert.equal((res as APIGatewayProxyStructuredResultV2).statusCode, 403);

  const self = await handler({
    routeKey: 'DELETE /admin/users/{username}',
    headers: {},
    isBase64Encoded: false,
    pathParameters: { username: USER },
    requestContext: { authorizer: { jwt: { claims: { sub: USER, 'cognito:groups': '[admin]' } } } },
  } as unknown as APIGatewayProxyEventV2);
  assert.equal((self as APIGatewayProxyStructuredResultV2).statusCode, 400); // 自分自身は削除できない
});

test('カード会社の利用通知メールを記録し、同じメールは二重に記録しない', async () => {
  const token = await issueToken();
  const text = '【ご利用日時(日本時間)】　2026/11/16 13:12\n【ご利用金額】　2,060円\n【ご利用先】　スターバツクス　シブヤテン';
  const first = await call<ShortcutResult>('POST /shortcut/mail', { token, user: null, body: { text } });
  assert.equal(first.status, 201);
  assert.equal(first.body.amount, 2060);
  assert.equal(first.body.category, '食費 > カフェ'); // 既定のルール「スターバックス」に当たる
  const again = await call<ShortcutResult>('POST /shortcut/mail', { token, user: null, body: { text } });
  assert.equal(again.status, 200);
  assert.match(again.body.message, /記録済み/);
  const month = await call<Transaction[]>('GET /transactions', { query: { month: '2026-11' } });
  assert.equal(month.body.filter((t) => t.source === 'mail').length, 1);
  assert.equal(month.body[0]!.payment, 'card');

  const notUsage = await call<{ message: string }>('POST /shortcut/mail', { token, user: null, body: { text: 'キャンペーンのお知らせ' } });
  assert.equal(notUsage.status, 200);
  assert.match(notUsage.body.message, /記録しませんでした/);
  const empty = await call<{ message: string }>('POST /shortcut/mail', { token, user: null, body: {} });
  assert.equal(empty.status, 200);
  assert.match(empty.body.message, /本文が空/);
  // 一覧 (複数のメール) の形で届いても読む
  const asList = await call<ShortcutResult>('POST /shortcut/mail', { token, user: null, body: { text: [text.replace('2,060', '1,500')] } });
  assert.equal(asList.body.amount, 1500);
  // 項目名が message でも受け付ける
  const byMessage = await call<ShortcutResult>('POST /shortcut/mail', {
    token,
    user: null,
    body: { message: text.replace('2,060', '980') },
  });
  assert.equal(byMessage.body.amount, 980);
  assert.equal((await call('POST /shortcut/mail', { user: null, body: { text } })).status, 401);
});

test('トークンは本文の token 項目や URL でも渡せる', async () => {
  const token = await issueToken();
  const text = '【ご利用日時(日本時間)】 2026/11/16 13:12\n【ご利用金額】 800円\n【ご利用先】 テスト';
  const inBody = await call<ShortcutResult>('POST /shortcut/mail', { user: null, body: { token, text } });
  assert.equal(inBody.status, 201);
  const res = await handler({
    routeKey: 'GET /shortcut/categories',
    headers: {},
    isBase64Encoded: false,
    queryStringParameters: { token },
    requestContext: {},
  } as unknown as APIGatewayProxyEventV2);
  assert.equal((res as APIGatewayProxyStructuredResultV2).statusCode, 200);
});
