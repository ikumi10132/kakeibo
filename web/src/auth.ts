// 家計簿のログインは W-SSO (wakalabo 共通ログイン) を使う。wsso-client.ts は wakalabo-apps のものをコピーしている
export { currentUserId, getAccessToken, handleRedirect, isAdmin, isLoggedIn, login, logout } from './wsso-client';
