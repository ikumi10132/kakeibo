import * as cdk from 'aws-cdk-lib';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';
import { KakeiboStack } from '../lib/kakeibo-stack.js';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  // smart-home-dashboard と同じリージョン
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
};

// 本体: 画面・API・ログイン・データ
new KakeiboStack(app, 'Kakeibo', { env });

// GitHub Actions から AWS にデプロイするための IAM ロール (最初に1回だけ手動デプロイ)
new GithubOidcStack(app, 'KakeiboGithubOidc', {
  env,
  repo: app.node.getContext('githubRepo') as string,
});
