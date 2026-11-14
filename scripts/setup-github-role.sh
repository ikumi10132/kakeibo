#!/usr/bin/env bash
# GitHub Actions から AWS にデプロイするための IAM ロール (kakeibo-deploy) を作る。最初に 1 回だけ実行する。
# AWS コンソールの CloudShell に、このファイルの中身をそのまま貼り付けて実行できる。
# - GitHub の OIDC プロバイダーは smart-home-dashboard で作成済みのものを使う (なければ作る)
# - ロールは ikumi10132/kakeibo の main ブランチからだけ使える
# - できるのは CDK のデプロイ用ロール (cdk-*) を引き受けることだけ
set -euo pipefail
REPO="${REPO:-ikumi10132/kakeibo}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PROVIDER="arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com >/dev/null
fi

TRUST=$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"${PROVIDER}"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},"StringLike":{"token.actions.githubusercontent.com:sub":"repo:${REPO}:ref:refs/heads/main"}}}]}
JSON
)
POLICY=$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::${ACCOUNT}:role/cdk-*"}]}
JSON
)

if aws iam get-role --role-name kakeibo-deploy >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name kakeibo-deploy --policy-document "$TRUST"
else
  aws iam create-role --role-name kakeibo-deploy --assume-role-policy-document "$TRUST" >/dev/null
fi
aws iam put-role-policy --role-name kakeibo-deploy --policy-name cdk-deploy --policy-document "$POLICY"

echo
echo "完了しました。GitHub の Variables に次の値を AWS_DEPLOY_ROLE_ARN として登録してください:"
echo "arn:aws:iam::${ACCOUNT}:role/kakeibo-deploy"
