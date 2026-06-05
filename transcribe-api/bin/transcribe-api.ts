#!/usr/bin/env node
// transcribe-api/bin/transcribe-api.ts
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TranscribeApiStack } from '../lib/transcribe-api-stack';

const app = new cdk.App();

// 配置从 context 或环境变量读，默认值适配中文场景
const cfg = {
  transcribeLanguage: app.node.tryGetContext('language') || process.env.TRANSCRIBE_LANGUAGE || 'zh-CN',
  identifyLanguage:
    (app.node.tryGetContext('identifyLanguage') ?? process.env.TRANSCRIBE_IDENTIFY_LANGUAGE ?? 'true')
      .toString()
      .toLowerCase() === 'true',
  languageOptions: app.node.tryGetContext('languageOptions') || process.env.TRANSCRIBE_LANGUAGE_OPTIONS || 'zh-CN,en-US',
  architecture: (app.node.tryGetContext('arch') || process.env.LAMBDA_ARCH || 'x86_64') as 'x86_64' | 'arm64',
  apiKey: app.node.tryGetContext('apiKey') || process.env.API_KEY || '',
};

new TranscribeApiStack(app, 'TranscribeApiStack', {
  ...cfg,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  },
});
