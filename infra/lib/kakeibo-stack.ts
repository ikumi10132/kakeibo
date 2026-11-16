import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_DEV_URL = 'http://localhost:5173';

export interface KakeiboStackProps extends cdk.StackProps {
  /** ログインユーザーのメールアドレス。初回に仮パスワードがメールで届く */
  users?: string[];
  /**
   * 独自ドメイン (例 kakeibo.wakalabo.net)。certificateArn とセットで指定する。
   * 証明書は CloudFront の決まりで us-east-1 に置く必要があり、CloudShell で AWS CLI から作成する (README 参照)。
   * cross-region の CDK スタックは us-east-1 に Lambda を作るため使わない
   */
  domainName?: string;
  certificateArn?: string;
  /** 管理者 (ユーザーの追加などができる) にする Cognito のユーザー名 (sub)。cdk.json の adminUsers */
  adminUsers?: string[];
}

export class KakeiboStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KakeiboStackProps = {}) {
    super(scope, id, props);

    // ---------- データ (DynamoDB) ----------
    // オンデマンド課金: 2 人分の家計簿なら月 1 円にも満たない。保存容量は 25GB まで無料
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // 過去 35 日の任意の時点に戻せるバックアップ (データ量が小さいのでほぼ無料)
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // スタックを消しても家計簿のデータは残す
    });

    // ---------- 画面 (S3 + CloudFront) ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    if (!!props.domainName !== !!props.certificateArn) {
      throw new Error('KAKEIBO_DOMAIN と KAKEIBO_CERT_ARN は両方指定してください');
    }
    if (props.certificateArn && !props.certificateArn.startsWith('arn:aws:acm:us-east-1:')) {
      throw new Error('CloudFront で使う証明書は us-east-1 で作成したものを指定してください');
    }
    const customDomain =
      props.domainName && props.certificateArn ? { name: props.domainName, certificateArn: props.certificateArn } : undefined;

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
      })),
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // 日本を含む
      ...(customDomain && {
        domainNames: [customDomain.name],
        certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', customDomain.certificateArn),
      }),
    });
    const cloudfrontUrl = `https://${distribution.distributionDomainName}`;
    // 独自ドメインを設定しても、cloudfront.net の URL でも引き続き開けるようにしておく
    const siteUrls = customDomain ? [`https://${customDomain.name}`, cloudfrontUrl] : [cloudfrontUrl];
    const siteUrl = siteUrls[0]!;

    // ---------- ログイン (Cognito) ----------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false, // 利用者は CLI で作成する (知らない人は登録できない)
      signInAliases: { email: true },
      passwordPolicy: { minLength: 12 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // 利用者 (新規登録は無効なので、ここに書いた人だけがログインできる)。
    // 一覧から外してもユーザーは削除しない (家計簿のデータが残っているため)。削除は Cognito の画面から行う
    for (const email of props.users ?? []) {
      const user = new cognito.CfnUserPoolUser(this, `User-${email.replace(/[^A-Za-z0-9]/g, '-')}`, {
        userPoolId: userPool.userPoolId,
        username: email,
        userAttributes: [
          { name: 'email', value: email },
          { name: 'email_verified', value: 'true' },
        ],
        desiredDeliveryMediums: ['EMAIL'],
      });
      user.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }

    // 管理者グループ。ログインのトークンに cognito:groups として入り、API で確認する
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admin',
      description: 'ユーザーの追加・停止・削除ができる',
    });
    for (const username of props.adminUsers ?? []) {
      const attach = new cognito.CfnUserPoolUserToGroupAttachment(this, `Admin-${username}`, {
        userPoolId: userPool.userPoolId,
        groupName: 'admin',
        username,
      });
      attach.addDependency(adminGroup);
    }

    const domain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `kakeibo-${this.account}` },
    });
    const client = userPool.addClient('WebClient', {
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [...siteUrls, LOCAL_DEV_URL].map((u) => `${u}/`),
        logoutUrls: [...siteUrls, LOCAL_DEV_URL].map((u) => `${u}/`),
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // ---------- API (API Gateway + Lambda) ----------
    const fn = new nodejs.NodejsFunction(this, 'ApiFunction', {
      entry: path.join(root, 'api/src/handler.ts'),
      projectRoot: root,
      depsLockFilePath: path.join(root, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: { TABLE_NAME: table.tableName, USER_POOL_ID: userPool.userPoolId, NODE_OPTIONS: '--enable-source-maps' },
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(fn);
    // 管理者画面のユーザー管理 (API 側で admin グループのときだけ呼ぶ)
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:ListUsersInGroup',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminDeleteUser',
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    const authorizer = new HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [client.userPoolClientId] },
    );
    const api = new apigw.HttpApi(this, 'HttpApi', {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: [...siteUrls, LOCAL_DEV_URL],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', fn);
    const { GET, POST, PUT, DELETE } = apigw.HttpMethod;
    const routes: [string, apigw.HttpMethod[]][] = [
      ['/categories', [GET, POST]],
      ['/categories/{id}', [PUT, DELETE]],
      ['/transactions', [GET, POST]],
      ['/transactions/{id}', [PUT, DELETE]],
      ['/rules', [GET, POST]],
      ['/rules/{id}', [DELETE]],
      ['/tokens', [GET, POST]],
      ['/tokens/{id}', [DELETE]],
      ['/admin/users', [GET, POST]],
      ['/admin/users/{username}', [PUT, DELETE]],
    ];
    for (const [p, methods] of routes) api.addRoutes({ path: p, methods, integration });

    // iPhone のショートカット用: Cognito ではなく、画面で発行したトークンを Lambda で確認する
    const none = new apigw.HttpNoneAuthorizer();
    api.addRoutes({ path: '/shortcut/transactions', methods: [POST], integration, authorizer: none });
    api.addRoutes({ path: '/shortcut/categories', methods: [GET], integration, authorizer: none });
    api.addRoutes({ path: '/shortcut/mail', methods: [POST], integration, authorizer: none });

    const stage = api.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    // ---------- 画面のデプロイ ----------
    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [
        s3deploy.Source.asset(path.join(root, 'web/dist')),
        s3deploy.Source.jsonData('config.json', {
          apiUrl: api.apiEndpoint,
          userPoolClientId: client.userPoolClientId,
          cognitoDomain: domain.baseUrl(),
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrl });
    // お名前.com で独自ドメインの CNAME の向き先にする値
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
