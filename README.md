# 家計簿

iPhone の Apple Pay で払うと自動で記録される、自分用の家計簿 Web アプリです。
ログインした人ごとにデータが分かれているので、2 人それぞれが自分の家計簿として使えます。

```
[iPhone ショートカット] ──(トークン)──┐
[スマホ/PC の画面] ── CloudFront + S3 │
     │                              ▼
     └──(Cognito でログイン)──▶ API Gateway ─▶ Lambda (Node.js) ─▶ DynamoDB
GitHub (main に push) ─▶ GitHub Actions で型チェック・テスト
AWS CloudShell ─▶ AWS CDK でデプロイ
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

## デプロイ (ブラウザだけでできます)

このアカウント (新しい AWS エクスペリエンス) は、AWS が管理する制限 (SCP) で GitHub との OIDC 連携が禁止されているため、
GitHub Actions からはデプロイできません。AWS コンソールの **CloudShell** からデプロイします。
CDK の bootstrap は smart-home-dashboard で済んでいるので不要です。

1. AWS コンソール右上の `>_` アイコンで CloudShell を開く (リージョンは ap-southeast-2)
2. 次をまとめて貼り付けて Enter (`KAKEIBO_USERS` はログインする人のメールアドレス。カンマ区切り)

```bash
export KAKEIBO_USERS="a@example.com,b@example.com"
curl -so- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null && source ~/.nvm/nvm.sh && nvm install 22 >/dev/null \
  && cd /tmp && rm -rf kakeibo && git clone --depth 1 https://github.com/ikumi10132/kakeibo.git && cd kakeibo \
  && npm ci && npm run build && cd infra && npx cdk deploy Kakeibo --require-approval never
```

- 作業場所を `/tmp` にしているのは、CloudShell の保存領域 (1GB) を使い切らないため
- 最後に `Kakeibo.SiteUrl` (画面の URL) が表示されます
- 初回は `KAKEIBO_USERS` の各アドレスに仮パスワードのメールが届きます。画面を開いてログインし、新しいパスワードを設定してください。
  2 回目以降も同じアドレスを指定してください (一覧から外してもユーザーは削除されません。削除は AWS コンソールの Cognito から)
- iPhone では Safari の共有メニューから「ホーム画面に追加」すると、アプリのように使えます

コードを更新したときも、同じコマンドを貼り付けるだけです。

### iPhone のショートカットを作る

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
