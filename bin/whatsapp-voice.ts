#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {App, Tags, Aspects} from 'aws-cdk-lib'
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { WhatsappVoiceStack } from '../lib/whatsapp-voice-stack';

const configParams = require('../config.params.json');

const app = new cdk.App();

const tags = configParams['Tags'] || {}; // Use uppercase 'Tags' and provide a default empty object
Object.entries(tags).forEach(([key, value]) => {
    if (typeof value === "string") {
        Tags.of(app).add(key, value);
    }
})

// Add CDK Nag AwsSolutionsChecks to the app with enhanced debug logging
const nagPackProps = {
  verbose: true,
  logIgnores: true,
};
Aspects.of(app).add(new AwsSolutionsChecks(nagPackProps));

new WhatsappVoiceStack(app, `${configParams.CdkProjectName}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});
