import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
    });
    const siteUrl = `https://${distribution.distributionDomainName}`;

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

    const domain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `kakeibo-${this.account}` },
    });
    const client = userPool.addClient('WebClient', {
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${siteUrl}/`, `${LOCAL_DEV_URL}/`],
        logoutUrls: [`${siteUrl}/`, `${LOCAL_DEV_URL}/`],
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
      environment: { TABLE_NAME: table.tableName, NODE_OPTIONS: '--enable-source-maps' },
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(fn);

    const authorizer = new HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [client.userPoolClientId] },
    );
    const api = new apigw.HttpApi(this, 'HttpApi', {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: [siteUrl, LOCAL_DEV_URL],
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
    ];
    for (const [p, methods] of routes) api.addRoutes({ path: p, methods, integration });

    // iPhone のショートカット用: Cognito ではなく、画面で発行したトークンを Lambda で確認する
    const none = new apigw.HttpNoneAuthorizer();
    api.addRoutes({ path: '/shortcut/transactions', methods: [POST], integration, authorizer: none });
    api.addRoutes({ path: '/shortcut/categories', methods: [GET], integration, authorizer: none });

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
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
