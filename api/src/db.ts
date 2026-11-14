// DynamoDB (1 テーブル) の読み書き
//
// PK               SK                     内容
// USER#<sub>       META                   初期データを作成済みか
// USER#<sub>       CAT#<id>               カテゴリー
// USER#<sub>       TX#<YYYY-MM-DD>#<id>   明細 (日付順に並ぶので月単位で取り出せる)
// USER#<sub>       RULE#<id>              自動振り分けルール
// USER#<sub>       TOKEN#<id>             ショートカット用トークンの情報 (一覧表示用)
// TOKEN#<sha256>   TOKEN                  トークンからユーザーを引くための項目
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { defaultCategories, defaultRules } from './defaults.js';
import type { ApiToken, Category, CreatedToken, Rule, Transaction } from './types.js';

const TABLE = process.env.TABLE_NAME ?? 'kakeibo';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const userPk = (uid: string) => `USER#${uid}`;
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12);
const strip = <T>(item: Record<string, unknown>): T => {
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as T;
};

async function queryAll(pk: string, skPrefix: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items;
}

async function batchPut(items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    let requests: Record<string, unknown>[] | undefined = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; requests?.length && attempt < 5; attempt++) {
      const res = await doc.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests as never } }));
      requests = res.UnprocessedItems?.[TABLE] as Record<string, unknown>[] | undefined;
      if (requests?.length) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
}

// ---------- 初期データ ----------

/** 初めてのユーザーには既定のカテゴリーとルールを用意する */
export async function ensureSeeded(uid: string): Promise<void> {
  const meta = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: userPk(uid), SK: 'META' } }));
  if (meta.Item) return;
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: { PK: userPk(uid), SK: 'META', createdAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return; // 同時に別のリクエストが作成中
    throw e;
  }
  await batchPut([
    ...defaultCategories().map((c) => ({ PK: userPk(uid), SK: `CAT#${c.id}`, ...c })),
    ...defaultRules().map((r) => ({ PK: userPk(uid), SK: `RULE#${r.id}`, ...r })),
  ]);
}

// ---------- カテゴリー ----------

export async function listCategories(uid: string): Promise<Category[]> {
  const items = await queryAll(userPk(uid), 'CAT#');
  return items.map((i) => strip<Category>(i)).sort((a, b) => a.order - b.order);
}

export async function putCategory(uid: string, c: Omit<Category, 'id'> & { id?: string }): Promise<Category> {
  const category: Category = { ...c, id: c.id ?? shortId() };
  await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: userPk(uid), SK: `CAT#${category.id}`, ...category } }));
  return category;
}

/** カテゴリーを削除し、使っていた明細とルールを moveTo に付け替える (null なら未分類) */
export async function deleteCategory(uid: string, id: string, moveTo: string | null): Promise<void> {
  const categories = await listCategories(uid);
  if (categories.some((c) => c.parentId === id)) {
    throw new Error('子カテゴリーがあるため削除できません。先に子カテゴリーを削除または移動してください');
  }
  if (moveTo && !categories.some((c) => c.id === moveTo)) throw new Error('移動先のカテゴリーがありません');

  const txs = (await queryAll(userPk(uid), 'TX#')).filter((t) => t.categoryId === id);
  await batchPut(txs.map((t) => ({ ...t, categoryId: moveTo })));

  const rules = (await queryAll(userPk(uid), 'RULE#')).filter((r) => r.categoryId === id);
  for (const r of rules) {
    if (moveTo) await doc.send(new PutCommand({ TableName: TABLE, Item: { ...r, categoryId: moveTo } }));
    else await doc.send(new DeleteCommand({ TableName: TABLE, Key: { PK: r.PK, SK: r.SK } }));
  }
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { PK: userPk(uid), SK: `CAT#${id}` } }));
}

// ---------- 明細 ----------

const txSk = (id: string) => {
  const [date, rand] = id.split('_');
  if (!date || !rand) throw new Error('明細の id が不正です');
  return `TX#${date}#${rand}`;
};

/** month = "YYYY-MM"。省略時はすべて */
export async function listTransactions(uid: string, month?: string): Promise<Transaction[]> {
  const items = await queryAll(userPk(uid), month ? `TX#${month}` : 'TX#');
  return items.map((i) => strip<Transaction>(i)).sort((a, b) => (a.id < b.id ? 1 : -1));
}

export async function getTransaction(uid: string, id: string): Promise<Transaction | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: userPk(uid), SK: txSk(id) } }));
  return res.Item ? strip<Transaction>(res.Item) : undefined;
}

export async function createTransaction(
  uid: string,
  tx: Omit<Transaction, 'id' | 'createdAt'>,
): Promise<Transaction> {
  const full: Transaction = { ...tx, id: `${tx.date}_${shortId()}`, createdAt: new Date().toISOString() };
  await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: userPk(uid), SK: txSk(full.id), ...full } }));
  return full;
}

/** 日付が変わるとキーも変わるので、そのときは新しい id で作り直す */
export async function updateTransaction(uid: string, old: Transaction, next: Transaction): Promise<Transaction> {
  if (old.date === next.date) {
    await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: userPk(uid), SK: txSk(old.id), ...next, id: old.id } }));
    return { ...next, id: old.id };
  }
  const moved: Transaction = { ...next, id: `${next.date}_${old.id.split('_')[1]}` };
  await doc.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { PK: userPk(uid), SK: txSk(moved.id), ...moved } } },
        { Delete: { TableName: TABLE, Key: { PK: userPk(uid), SK: txSk(old.id) } } },
      ],
    }),
  );
  return moved;
}

export async function deleteTransaction(uid: string, id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { PK: userPk(uid), SK: txSk(id) } }));
}

// ---------- ルール ----------

export async function listRules(uid: string): Promise<Rule[]> {
  const items = await queryAll(userPk(uid), 'RULE#');
  return items.map((i) => strip<Rule>(i)).sort((a, b) => a.keyword.localeCompare(b.keyword, 'ja'));
}

export async function putRule(uid: string, r: Omit<Rule, 'id'> & { id?: string }): Promise<Rule> {
  const rule: Rule = { ...r, id: r.id ?? shortId() };
  await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: userPk(uid), SK: `RULE#${rule.id}`, ...rule } }));
  return rule;
}

export async function deleteRule(uid: string, id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { PK: userPk(uid), SK: `RULE#${id}` } }));
}

// ---------- ショートカット用トークン ----------
// トークン本体は保存せず、SHA-256 のハッシュだけを保存する

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function listTokens(uid: string): Promise<ApiToken[]> {
  const items = await queryAll(userPk(uid), 'TOKEN#');
  return items.map((i) => {
    const { hash: _h, ...t } = strip<ApiToken & { hash: string }>(i);
    return t;
  });
}

export async function createToken(uid: string, name: string): Promise<CreatedToken> {
  const token = `kb_${randomBytes(24).toString('base64url')}`;
  const info: ApiToken = { id: shortId(), name, createdAt: new Date().toISOString() };
  const h = hash(token);
  await doc.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { PK: userPk(uid), SK: `TOKEN#${info.id}`, ...info, hash: h } } },
        { Put: { TableName: TABLE, Item: { PK: `TOKEN#${h}`, SK: 'TOKEN', userId: uid, tokenId: info.id } } },
      ],
    }),
  );
  return { ...info, token };
}

export async function deleteToken(uid: string, id: string): Promise<void> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: userPk(uid), SK: `TOKEN#${id}` } }));
  if (!res.Item) return;
  await doc.send(
    new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: TABLE, Key: { PK: userPk(uid), SK: `TOKEN#${id}` } } },
        { Delete: { TableName: TABLE, Key: { PK: `TOKEN#${res.Item.hash as string}`, SK: 'TOKEN' } } },
      ],
    }),
  );
}

/** トークンが有効ならユーザー id を返す */
export async function userIdFromToken(token: string): Promise<string | undefined> {
  if (!token.startsWith('kb_')) return undefined;
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: `TOKEN#${hash(token)}`, SK: 'TOKEN' } }));
  if (!res.Item) return undefined;
  const uid = res.Item.userId as string;
  // 最終利用日時は失敗しても記録に影響させない
  await doc
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: userPk(uid), SK: `TOKEN#${res.Item.tokenId as string}` },
        UpdateExpression: 'SET lastUsedAt = :t',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':t': new Date().toISOString() },
      }),
    )
    .catch(() => undefined);
  return uid;
}
