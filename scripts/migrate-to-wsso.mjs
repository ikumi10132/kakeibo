// 家計簿のデータを、以前の家計簿専用のログインのアカウントから、W-SSO (wakalabo 共通ログイン) のアカウントへ移す。
// 同じメールアドレスのアカウント同士を対応づけ、DynamoDB の USER#<以前の ID> の項目を USER#<W-SSO の ID> にコピーする。
// ショートカット用のトークンも W-SSO のアカウントに付け替えるので、iPhone のショートカットはそのまま動く。
//
// - 以前のデータは消さない (コピーするだけ)。移した先にすでにある項目は上書きしないので、何回実行しても安全
// - --apply を付けないと、何をするかを表示するだけ (書き込まない)
//
// 使い方 (CloudShell で、kakeibo を clone して npm ci した後に。README の「W-SSO への切り替え」参照):
//   node scripts/migrate-to-wsso.mjs --table <テーブル名> --old-pool <以前のユーザープール ID> --new-pool <W-SSO のユーザープール ID> [--apply]
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const TABLE = arg('table');
const OLD_POOL = arg('old-pool');
const NEW_POOL = arg('new-pool');
const APPLY = args.includes('--apply');
if (!TABLE || !OLD_POOL || !NEW_POOL || TABLE === 'None' || OLD_POOL === 'None' || NEW_POOL === 'None') {
  console.error('使い方: node scripts/migrate-to-wsso.mjs --table <テーブル名> --old-pool <以前のプール ID> --new-pool <W-SSO のプール ID> [--apply]');
  process.exit(1);
}

const cognito = new CognitoIdentityProviderClient({});
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** メールアドレス → sub */
async function usersByEmail(poolId) {
  const map = new Map();
  let token;
  do {
    const res = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, PaginationToken: token }));
    for (const u of res.Users ?? []) {
      const attr = (n) => u.Attributes?.find((a) => a.Name === n)?.Value;
      const email = attr('email')?.toLowerCase();
      const sub = attr('sub');
      if (email && sub) map.set(email, sub);
    }
    token = res.PaginationToken;
  } while (token);
  return map;
}

async function queryAll(pk) {
  const items = [];
  let start;
  do {
    const res = await doc.send(
      new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey: start }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items;
}

/** ショートカット用トークンの「トークン → ユーザー」の項目 (PK = TOKEN#<ハッシュ>, SK = TOKEN) */
async function tokenItems() {
  const items = [];
  let start;
  do {
    const res = await doc.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'SK = :sk AND begins_with(PK, :p)',
        ExpressionAttributeValues: { ':sk': 'TOKEN', ':p': 'TOKEN#' },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items;
}

const oldUsers = await usersByEmail(OLD_POOL);
const newUsers = await usersByEmail(NEW_POOL);
const tokens = await tokenItems();
console.log(`以前のアカウント ${oldUsers.size} 件 / W-SSO のアカウント ${newUsers.size} 件 / ショートカット用トークン ${tokens.length} 件`);
console.log(APPLY ? '--- 書き込みます ---' : '--- 確認だけ (書き込むには --apply を付けて実行) ---');

let problems = 0;
for (const [email, oldSub] of oldUsers) {
  const newSub = newUsers.get(email);
  const items = await queryAll(`USER#${oldSub}`);
  const txCount = items.filter((i) => String(i.SK).startsWith('TX#')).length;
  if (!newSub) {
    if (items.length > 0) problems++;
    console.log(`× ${email}: W-SSO に同じメールアドレスのアカウントがありません (明細 ${txCount} 件は移せません)`);
    continue;
  }
  if (newSub === oldSub) {
    console.log(`- ${email}: 同じ ID なので移す必要はありません`);
    continue;
  }
  let copied = 0;
  let skipped = 0;
  for (const item of items) {
    if (!APPLY) {
      copied++;
      continue;
    }
    try {
      await doc.send(
        new PutCommand({
          TableName: TABLE,
          Item: { ...item, PK: `USER#${newSub}` },
          ConditionExpression: 'attribute_not_exists(PK)', // 移した先にある項目は上書きしない
        }),
      );
      copied++;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') skipped++;
      else throw e;
    }
  }
  const mine = tokens.filter((t) => t.userId === oldSub);
  for (const t of mine) {
    if (APPLY) {
      await doc.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: t.PK, SK: t.SK },
          UpdateExpression: 'SET userId = :n',
          ExpressionAttributeValues: { ':n': newSub },
        }),
      );
    }
  }
  console.log(
    `○ ${email}: 項目 ${items.length} 件 (うち明細 ${txCount} 件) を${APPLY ? 'コピーしました' : 'コピーします'}` +
      (skipped ? ` (移した先にすでにあった ${skipped} 件はそのまま)` : '') +
      ` / ショートカット用トークン ${mine.length} 件を${APPLY ? '付け替えました' : '付け替えます'}`,
  );
}

for (const [email] of newUsers) {
  if (!oldUsers.has(email)) console.log(`- ${email}: 以前の家計簿のアカウントはありません (新しく使い始める人)`);
}
if (problems) console.log(`\n注意: 移せないアカウントが ${problems} 件あります。ダッシュボードで同じメールアドレスの W-SSO アカウントを作ってから、もう一度実行してください`);
console.log(APPLY ? '\n完了しました' : '\n確認だけでした。問題なければ、最後に --apply を付けてもう一度実行してください');
