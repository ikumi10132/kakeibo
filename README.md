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
2. 次をまとめて貼り付けて Enter

```bash
curl -so- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null && source ~/.nvm/nvm.sh && nvm install 22 >/dev/null \
  && cd /tmp && rm -rf kakeibo && git clone --depth 1 https://github.com/ikumi10132/kakeibo.git && cd kakeibo \
  && npm ci && npm run build && cd infra && npx cdk deploy Kakeibo --require-approval never
```

- 作業場所を `/tmp` にしているのは、CloudShell の保存領域 (1GB) を使い切らないため
- 最後に `Kakeibo.SiteUrl` (画面の URL) が表示されます
- コードを更新したときも、同じコマンドを貼り付けるだけです
- iPhone では Safari の共有メニューから「ホーム画面に追加」すると、アプリのように使えます

### ログイン (W-SSO)

ログインは **W-SSO** (wakalabo 共通ログイン。ログイン画面は https://apps.wakalabo.net/sso.html) を使います。
使う人の追加・パスワードの再設定・家計簿を使えるかどうか (グループ `app-kakeibo`) の設定は、ダッシュボードの「ユーザー管理」で行います。
W-SSO の情報は wakalabo-apps が SSM パラメータ (`/wakalabo/auth/...`) に置いたものを読むので、**wakalabo-apps を先にデプロイ**しておく必要があります。

### W-SSO への切り替え (1 回だけ)

以前は家計簿専用のログインでした。データは「誰のものか」をログインの ID で管理しているので、W-SSO のアカウントに移します
(同じメールアドレスのアカウント同士を対応づけ。ショートカット用のトークンも移すので、iPhone のショートカットはそのまま使えます)。

1. wakalabo-apps をデプロイし、ダッシュボードの「ユーザー管理」で、家計簿を使う人全員に W-SSO のアカウントがあり「家計簿」にチェックが入っていることを確認
2. CloudShell で kakeibo を clone して `npm ci` した後、確認だけ実行 (書き込まない)
   ```bash
   TABLE=$(aws cloudformation describe-stacks --stack-name Kakeibo --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
   OLD=$(aws cloudformation describe-stacks --stack-name Kakeibo --query "Stacks[0].Outputs[?OutputKey=='UserPoolId' || OutputKey=='LegacyUserPoolId'].OutputValue | [0]" --output text)
   NEW=$(aws ssm get-parameter --name /wakalabo/auth/user-pool-id --query Parameter.Value --output text)
   node scripts/migrate-to-wsso.mjs --table "$TABLE" --old-pool "$OLD" --new-pool "$NEW"
   ```
3. 表示に問題がなければ、最後の行に `--apply` を付けて実行 (以前のデータは消さずにコピー。何回実行しても安全)
4. いつものデプロイ

### iPhone のショートカットを作る

画面の「設定 → ショートカット」でトークンを発行し、表示される手順に沿って作成します。

## Gmail から自動で記録する (カードの利用通知メール)

iPhone のメールのオートメーションは、iPhone がメールを受信したときにしか動きません (充電中にまとめて受信されるなど)。
[`scripts/gmail-to-kakeibo.gs`](scripts/gmail-to-kakeibo.gs) を Google Apps Script で動かすと、Google のサーバーが 5 分ごとに Gmail を確認して家計簿に送ります (無料)。

1. https://script.google.com →「新しいプロジェクト」。中身を消して、`scripts/gmail-to-kakeibo.gs` を貼り付けて保存
2. 左の歯車「プロジェクトの設定」→ 一番下「スクリプト プロパティを追加」: プロパティ `KAKEIBO_TOKEN`、値は家計簿の「設定 → ショートカット」で発行したトークン (`kb_...`)
3. エディタに戻り、上の関数の選択で `setup` を選んで「実行」。Google の許可画面が出たら、自分のアカウントを選び「詳細」→「(安全ではないページ) に移動」→「許可」
   (自分で作ったスクリプトなので「Google で確認されていません」と出ますが問題ありません)

以後、`setup` を実行した後に届いた利用通知メールが記録されます。動作の記録は左の「実行数」で見られます。
同じメールは家計簿側で二重に記録しないので、iPhone のメールのオートメーションと併用しても大丈夫です。

## 独自ドメイン (kakeibo.wakalabo.net)

CloudFront で使う HTTPS 証明書は、AWS の決まりで **us-east-1** に作る必要があります。CloudShell の AWS CLI で作成します
(CDK でリージョンをまたぐと us-east-1 に Lambda が作られるため使いません)。

1. 証明書を申請し、確認用の CNAME を表示する
   ```bash
   ARN=$(aws acm request-certificate --region us-east-1 --domain-name kakeibo.wakalabo.net --validation-method DNS --query CertificateArn --output text) && echo "ARN=$ARN" && sleep 10 && aws acm describe-certificate --region us-east-1 --certificate-arn "$ARN" --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output table
   ```
2. 表示された CNAME (Name / Value) をお名前.com に登録し、状態が `ISSUED` になるまで待つ
   ```bash
   aws acm list-certificates --region us-east-1 --query 'CertificateSummaryList[].[DomainName,Status,CertificateArn]' --output table
   ```
3. `infra/cdk.json` の context に `domainName` と `certificateArn` を書いてデプロイ (上のデプロイ手順と同じコマンド)
4. お名前.com で `kakeibo` の CNAME を、出力された `Kakeibo.CloudFrontDomain` に向ける

独自ドメインを設定しても、`cloudfront.net` の URL でも引き続き開けます。iPhone のショートカットが使う API の URL は変わりません。

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
