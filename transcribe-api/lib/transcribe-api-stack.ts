// transcribe-api/lib/transcribe-api-stack.ts
//
// CDK Stack：同步语音转写 API
//   API Gateway (HTTP API) -> Lambda(ffmpeg + Amazon Transcribe Streaming)
//
// 无 S3 / SNS / SQS。纯同步，按用量计费，零常驻成本。

import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

export interface TranscribeApiStackProps extends StackProps {
  /** Transcribe 默认语言码，如 zh-CN / en-US */
  transcribeLanguage?: string;
  /** 是否自动识别语言（中英混说推荐 true） */
  identifyLanguage?: boolean;
  /** 自动识别候选语言 */
  languageOptions?: string;
  /** Lambda 架构：x86_64（匹配自带 ffmpeg）或 arm64（需换 ffmpeg binary） */
  architecture?: 'x86_64' | 'arm64';
  /** 可选：API key 简单鉴权（设了就要求请求头 x-api-key 匹配） */
  apiKey?: string;
}

export class TranscribeApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: TranscribeApiStackProps) {
    super(scope, id, props);

    const language = props?.transcribeLanguage ?? 'zh-CN';
    const identify = props?.identifyLanguage ?? true;
    const languageOptions = props?.languageOptions ?? 'zh-CN,en-US';
    const arch = props?.architecture ?? 'x86_64';
    const apiKey = props?.apiKey ?? '';

    const lambdaArch =
      arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

    // ---- ffmpeg Layer ----
    const ffmpegLayer = new lambda.LayerVersion(this, 'FfmpegLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'layers', 'ffmpeg')),
      compatibleArchitectures: [lambdaArch],
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'static ffmpeg binary at /opt/bin/ffmpeg',
    });

    // ---- 日志组（一周保留）----
    const logGroup = new logs.LogGroup(this, 'TranscribeFnLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---- 转写 Lambda ----
    const fn = new lambda.Function(this, 'TranscribeFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambdaArch,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'src', 'lambda'), {
        // 打包时一并安装依赖（见 src/lambda/package.json）
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          // 把 npm 缓存/HOME 指到可写的 /tmp，避开某些主机上 /.npm 被 root 占用导致的 EACCES
          environment: {
            HOME: '/tmp',
            npm_config_cache: '/tmp/.npm',
          },
          command: [
            'bash', '-c',
            'cp -r /asset-input/* /asset-output/ && cd /asset-output && npm install --omit=dev',
          ],
        },
      }),
      layers: [ffmpegLayer],
      timeout: Duration.seconds(60),
      memorySize: 1024, // ffmpeg + streaming 够用
      environment: {
        TRANSCRIBE_LANGUAGE: language,
        TRANSCRIBE_IDENTIFY_LANGUAGE: String(identify),
        TRANSCRIBE_LANGUAGE_OPTIONS: languageOptions,
        FFMPEG_PATH: '/opt/bin/ffmpeg',
        ...(apiKey ? { API_KEY: apiKey } : {}),
      },
      logGroup,
    });

    // ---- IAM：只给 Transcribe Streaming 权限（最小权限）----
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['transcribe:StartStreamTranscription'],
        resources: ['*'], // StartStreamTranscription 不支持资源级限制
      }),
    );

    // ---- HTTP API ----
    const httpApi = new HttpApi(this, 'TranscribeHttpApi', {
      apiName: 'transcribe-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type', 'x-api-key'],
      },
    });

    httpApi.addRoutes({
      path: '/transcribe',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('TranscribeIntegration', fn),
    });

    new CfnOutput(this, 'TranscribeEndpoint', {
      value: `${httpApi.apiEndpoint}/transcribe`,
      description: 'POST 音频到这个 URL 做转写',
    });
    new CfnOutput(this, 'Architecture', { value: arch });
    new CfnOutput(this, 'Language', {
      value: identify ? `auto(${languageOptions}), prefer ${language}` : language,
    });
  }
}
