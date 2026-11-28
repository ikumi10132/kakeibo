// ショートカット (/shortcut/*) は Cognito のログインを通らないので、トークンの持ち主が今もこのアプリを使えるかを確かめる。
// ダッシュボードのユーザー管理で、停止・削除・アプリの権限を外した人のトークンは使えなくする。
import { AdminListGroupsForUserCommand, CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';

const POOL = process.env.USER_POOL_ID ?? '';
const APP_GROUP = 'app-kakeibo';
const CACHE_MS = 5 * 60_000;
const cognito = new CognitoIdentityProviderClient({});
const cache = new Map<string, { at: number; allowed: boolean }>();

async function lookup(sub: string): Promise<boolean> {
  const res = await cognito.send(new ListUsersCommand({ UserPoolId: POOL, Filter: `sub = "${sub.replace(/["\\]/g, '')}"`, Limit: 1 }));
  const u = res.Users?.[0];
  if (!u?.Username || u.Enabled === false) return false;
  const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: POOL, Username: u.Username, Limit: 60 }));
  const names = (groups.Groups ?? []).map((g) => g.GroupName);
  return names.includes('admin') || names.includes(APP_GROUP);
}

/**
 * この利用者が今もこのアプリを使えるか。結果は 5 分覚えておく (Cognito への問い合わせを減らす)。
 * Cognito に問い合わせられなかったとき (障害など) は通す: カードのメールなどの記録が消えるのを防ぐため。
 * 「使えない」とはっきり分かったときだけ拒否する
 */
export async function stillAllowed(sub: string, now = Date.now()): Promise<boolean> {
  const hit = cache.get(sub);
  if (hit && now - hit.at < CACHE_MS) return hit.allowed;
  try {
    const allowed = await lookup(sub);
    cache.set(sub, { at: now, allowed });
    return allowed;
  } catch (e) {
    console.warn('access: Cognito に問い合わせられなかったので通します', (e as Error).name);
    return true;
  }
}

export const clearAccessCache = () => cache.clear();
