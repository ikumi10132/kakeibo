import * as cdk from 'aws-cdk-lib';
import { KakeiboStack } from '../lib/kakeibo-stack.js';

const app = new cdk.App();

// 画面・API・ログイン・データ。GitHub Actions からデプロイする (デプロイ用ロールは scripts/setup-github-role.sh で作成)
new KakeiboStack(app, 'Kakeibo', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // smart-home-dashboard と同じリージョン
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
  },
  // ログインユーザーのメールアドレス (カンマ区切り)。GitHub の Variables「KAKEIBO_USERS」から渡す
  users: (process.env.KAKEIBO_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});
