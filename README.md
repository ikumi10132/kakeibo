# 家計簿

iPhone の Apple Pay で払うと自動で記録される、自分用の家計簿 Web アプリです。
ログインした人ごとにデータが分かれているので、2 人それぞれが自分の家計簿として使えます。

```
[iPhone ショートカット] ──(トークン)──┐
[スマホ/PC の画面] ── CloudFront + S3 │
     │                              ▼
     └──(Cognito でログイン)──▶ API Gateway ─▶ Lambda (Node.js) ─▶ DynamoDB
GitHub (main に push) ─▶ GitHub Actions ─▶ AWS CDK でデプロイ
```

| ディレクトリ | 内容 |
|---|---|
| `api/` | Lambda (TypeScript)。明細・カテゴリー・振り分けルール・ショートカット用 API |
| `web/` | 画面 (React + Vite)。iPhone ではホーム画面に追加してアプリのように使う |
| `infra/` | AWS CDK。S3 / CloudFront / Cognito / API Gateway / Lambda / DynamoDB |

## できること

- 収入・支出の記録、月ごとの一覧と検索、カテゴリー別の集計
- カテゴリーのカスタマイズ (2 階層、アイコン、色、並べ替え。削除時は明細を別カテゴリーへ移動)
- **Apple Pay で払ったら自動で記録** (ショートカットの「取引」オートメーション)
- **店名から自動でカテゴリーを決める**。決められなかった明細は「未確認」に入り、カテゴリーを選ぶと次から自動で振り分け
- QR 決済・現金用の手入力ショートカット (金額とカテゴリーを選ぶだけ)

今後: 予算、貯金目標、Claude に貼って分析するための集計の書き出し

## セットアップ

前提: Node.js 22 以上、AWS CLI v2 (`aws login` でログイン済み)。smart-home-dashboard と同じ AWS アカウント・リージョンを使います。

```bash
npm ci
```

### 1. 初回デプロイ

CDK の bootstrap は smart-home-dashboard で済んでいるので不要です。

```bash
npm run deploy
```

完了すると `SiteUrl` (画面の URL) や `UserPoolId` が表示されます。

### 2. ログインユーザーを作る (2 人分)

新規登録は無効にしてあるので、CLI で作成します。

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
```

仮パスワードがメールで届くので、`SiteUrl` を開いてログインし、新しいパスワードを設定します。
iPhone では Safari の共有メニューから「ホーム画面に追加」してください。

### 3. iPhone のショートカットを作る

画面の「設定 → ショートカット」でトークンを発行し、表示される手順に沿って作成します。

### 4. GitHub Actions で自動デプロイする

1. デプロイ用の IAM ロールを作る (初回のみ。GitHub の OIDC プロバイダーは smart-home-dashboard で作成済みのものを使います)
   ```bash
   cd infra && npx cdk deploy KakeiboGithubOidc
   ```
2. 出力された `DeployRoleArn` を、GitHub のリポジトリ設定 → Secrets and variables → Actions → **Variables** に
   `AWS_DEPLOY_ROLE_ARN` として登録

以降は `main` に push すると、型チェック・テスト・ビルドのあと自動でデプロイされます。

## ローカル開発

デプロイ後の出力値で `web/public/config.json` を作ります (`config.example.json` を参照)。

```bash
npm run dev   # http://localhost:5173
npm test      # API のテスト (DynamoDB はメモリ上の簡易版に差し替え)
```

## データとバックアップ

- DynamoDB のテーブルは削除保護あり。スタックを消してもテーブルは残ります
- ポイントインタイムリカバリ (過去 35 日の任意の時点に戻せる) を有効にしています

## 費用の目安

2 人で使う程度なら、ほぼ無料枠内です (DynamoDB はオンデマンド課金で月 1 円未満の見込み)。
CloudWatch Logs は 1 か月で自動削除されます。
