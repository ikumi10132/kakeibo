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
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_DEV_URL = 'http://localhost:5173';

export interface KakeiboStackProps extends cdk.StackProps {
  /**
   * 独自ドメイン (例 kakeibo.wakalabo.net)。certificateArn とセットで指定する。
   * 証明書は CloudFront の決まりで us-east-1 に置く必要があり、CloudShell で AWS CLI から作成する (README 参照)。
   * cross-region の CDK スタックは us-east-1 に Lambda を作るため使わない
   */
  domainName?: string;
  certificateArn?: string;
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

    // ---------- ログイン: W-SSO (wakalabo 共通ログイン。wakalabo-apps が SSM に置いた値を読む) ----------
    const wssoPoolId = ssm.StringParameter.valueForStringParameter(this, '/wakalabo/auth/user-pool-id');
    const wssoClientId = ssm.StringParameter.valueForStringParameter(this, '/wakalabo/auth/wsso-client-id');
    const ssoUrl = ssm.StringParameter.valueForStringParameter(this, '/wakalabo/auth/sso-url');

    // 以前の家計簿専用のログイン。データを W-SSO のアカウントへ移す (scripts/migrate-to-wsso.mjs) ときに使うので残しておく。
    // 設定を変えると作り直しになるので、このまま変更しない
    const legacyUserPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: { minLength: 12 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
      `https://cognito-idp.${this.region}.amazonaws.com/${wssoPoolId}`,
      { jwtAudience: [wssoClientId] },
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
      ['/push', [GET]],
      ['/push/subscriptions', [POST]],
      ['/push/unsubscribe', [POST]],
      ['/push/settings', [PUT]],
      ['/push/test', [POST]],
      ['/mail/preview', [POST]],
      ['/installments', [GET]],
      ['/installments/settings', [PUT]],
      ['/installments/{id}', [DELETE]],
      ['/installments/{id}/payoff', [POST]],
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
          ssoUrl,
          wssoClientId,
          region: this.region,
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
    new cdk.CfnOutput(this, 'LegacyUserPoolId', { value: legacyUserPool.userPoolId });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });

    // waripo (割り勘アプリ) が、割り勘にした明細に印を付け、相手の家計簿に負担分を作るために読む
    new ssm.StringParameter(this, 'TableNameParam', { parameterName: '/wakalabo/kakeibo/table-name', stringValue: table.tableName });
    new ssm.StringParameter(this, 'TableArnParam', { parameterName: '/wakalabo/kakeibo/table-arn', stringValue: table.tableArn });
  }
}
