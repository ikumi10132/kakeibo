import { configure } from './wsso-client';

export interface AppConfig {
  apiUrl: string;
  /** W-SSO のログイン画面がある URL (例 https://apps.wakalabo.net) */
  ssoUrl: string;
  /** W-SSO のアプリ クライアント ID (全アプリ共通) */
  wssoClientId: string;
  region: string;
}

/** 割り勘アプリ waripo。家計簿の明細から割り勘にするときに、その API (同じサイトの /api) を呼ぶ */
export const WARIPO_URL = 'https://waripo.wakalabo.net';

let config: AppConfig | undefined;

/** デプロイ時に CDK が書き出す /config.json を読み込む */
export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('config.json が見つかりません。ローカル開発時は web/public/config.json を作成してください');
  }
  config = (await res.json()) as AppConfig;
  configure({
    ssoUrl: config.ssoUrl,
    userPoolClientId: config.wssoClientId,
    region: config.region,
    appId: 'kakeibo',
    storageKey: 'kb.session',
  });
  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error('config が読み込まれていません');
  return config;
}
