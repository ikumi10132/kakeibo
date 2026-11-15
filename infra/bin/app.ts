import * as cdk from 'aws-cdk-lib';
import { KakeiboStack } from '../lib/kakeibo-stack.js';

const app = new cdk.App();

// 画面・API・ログイン・データ。CloudShell からデプロイする (README 参照)
new KakeiboStack(app, 'Kakeibo', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // smart-home-dashboard と同じリージョン
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
  },
  // ログインユーザーのメールアドレス (カンマ区切り)。環境変数 KAKEIBO_USERS で渡す
  users: (process.env.KAKEIBO_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // 独自ドメインとその証明書 (us-east-1 の ACM)。cdk.json の context に書く (秘密情報ではないのでリポジトリに置く)。
  // 環境変数 KAKEIBO_DOMAIN / KAKEIBO_CERT_ARN でも上書きできる
  domainName: process.env.KAKEIBO_DOMAIN || app.node.tryGetContext('domainName') || undefined,
  certificateArn: process.env.KAKEIBO_CERT_ARN || app.node.tryGetContext('certificateArn') || undefined,
  adminUsers: (app.node.tryGetContext('adminUsers') as string[] | undefined) ?? [],
});
