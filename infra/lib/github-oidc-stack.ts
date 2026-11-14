import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  /** "owner/repo" */
  repo: string;
}

// GitHub Actions が OIDC でこのロールを引き受け、CDK のデプロイ用ロール経由でデプロイする。
// GitHub の OIDC プロバイダーは smart-home-dashboard で作成済みなので、ここでは参照するだけ。
export class GithubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubProvider',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'kakeibo-deploy',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${props.repo}:ref:refs/heads/main` },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
