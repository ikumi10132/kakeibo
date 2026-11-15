// 管理者向け: ログインユーザー (Cognito) の一覧・追加・停止・削除
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AdminUser } from './types.js';

export const ADMIN_GROUP = 'admin';
const POOL = process.env.USER_POOL_ID ?? '';
const cognito = new CognitoIdentityProviderClient({});

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

const attr = (u: UserType, name: string) => u.Attributes?.find((a) => a.Name === name)?.Value;

function toAdminUser(u: UserType, admins: Set<string>): AdminUser {
  const username = u.Username ?? '';
  return {
    username,
    email: attr(u, 'email') ?? '',
    status: u.UserStatus ?? 'UNKNOWN',
    enabled: u.Enabled ?? false,
    isAdmin: admins.has(username),
    createdAt: u.UserCreateDate?.toISOString() ?? '',
  };
}

async function adminUsernames(): Promise<Set<string>> {
  const names = new Set<string>();
  let token: string | undefined;
  do {
    const res = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: POOL, GroupName: ADMIN_GROUP, NextToken: token }));
    for (const u of res.Users ?? []) if (u.Username) names.add(u.Username);
    token = res.NextToken;
  } while (token);
  return names;
}

export async function listUsers(): Promise<AdminUser[]> {
  const admins = await adminUsernames();
  const users: AdminUser[] = [];
  let token: string | undefined;
  do {
    const res = await cognito.send(new ListUsersCommand({ UserPoolId: POOL, PaginationToken: token }));
    users.push(...(res.Users ?? []).map((u) => toAdminUser(u, admins)));
    token = res.PaginationToken;
  } while (token);
  return users.sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * ユーザーを追加する。
 * password を指定したときは、それを初回ログイン用の仮パスワードにする (メールは送らない。本人に直接伝える)。
 * 省略したときは、Cognito が仮パスワードをメールで送る。
 * どちらも初回ログイン時に本人が新しいパスワードを設定する
 */
export async function createUser(email: string, password?: string): Promise<AdminUser> {
  const res = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: POOL,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
      ...(password ? { TemporaryPassword: password, MessageAction: 'SUPPRESS' as const } : {}),
    }),
  );
  if (!res.User) throw new Error('ユーザーを作成できませんでした');
  return toAdminUser(res.User, new Set());
}

/** 仮パスワードを設定し直す (次回ログイン時に本人が変更する) */
export async function resetPassword(username: string, password: string): Promise<void> {
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: username, Password: password, Permanent: false }));
}

export async function setEnabled(username: string, enabled: boolean): Promise<void> {
  const input = { UserPoolId: POOL, Username: username };
  await cognito.send(enabled ? new AdminEnableUserCommand(input) : new AdminDisableUserCommand(input));
}

/** ログインできなくするだけで、家計簿のデータ (DynamoDB) は消さない */
export async function deleteUser(username: string): Promise<void> {
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: username }));
}

/** Cognito のエラーを日本語にする */
export function cognitoMessage(e: unknown): string | undefined {
  const name = (e as { name?: string })?.name;
  switch (name) {
    case 'UsernameExistsException':
      return 'このメールアドレスのユーザーはすでにいます';
    case 'InvalidPasswordException':
      return 'パスワードは 12 文字以上で、英大文字・英小文字・数字・記号をそれぞれ含めてください';
    case 'InvalidParameterException':
      return '入力内容が正しくありません (メールアドレスを確認してください)';
    case 'UserNotFoundException':
      return 'ユーザーが見つかりません';
    default:
      return undefined;
  }
}
