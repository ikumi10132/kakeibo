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

## セットアップ (ブラウザだけでできます)

デプロイは GitHub Actions が行います。Mac のターミナルは使いません。
smart-home-dashboard と同じ AWS アカウント・リージョンを使います (CDK の bootstrap は済んでいるので不要)。

### 1. デプロイ用の権限を作る (最初に 1 回だけ)

1. AWS コンソールを開き、左下の **CloudShell** を開く
2. [`scripts/setup-github-role.sh`](scripts/setup-github-role.sh) の中身をすべて貼り付けて Enter
3. 最後に表示される `arn:aws:iam::...:role/kakeibo-deploy` をコピーしておく

### 2. GitHub に設定を登録する

リポジトリの Settings → Secrets and variables → Actions → **Variables** に次の 2 つを登録します。

| 名前 | 値 |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | 手順 1 でコピーした値 |
| `KAKEIBO_USERS` | ログインする人のメールアドレス (カンマ区切り。例 `a@example.com,b@example.com`) |

### 3. デプロイする

Actions タブ →「CI / Deploy」→ **Run workflow**。以降は `main` に push するたびに自動でデプロイされます。

完了すると、`KAKEIBO_USERS` の各アドレスに仮パスワードのメールが届きます。
画面の URL は、Actions の実行ログの最後 (`Kakeibo.SiteUrl`) に表示されます。
開いてログインし、新しいパスワードを設定してください。
iPhone では Safari の共有メニューから「ホーム画面に追加」すると、アプリのように使えます。

利用者を増やすときは `KAKEIBO_USERS` に追加して再実行します。一覧から外してもユーザーは削除されません (削除は AWS コンソールの Cognito から)。

### 4. iPhone のショートカットを作る

画面の「設定 → ショートカット」でトークンを発行し、表示される手順に沿って作成します。

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
