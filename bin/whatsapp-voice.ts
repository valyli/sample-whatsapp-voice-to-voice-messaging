#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {App, Tags} from 'aws-cdk-lib'
import * as cdk from 'aws-cdk-lib';
import { WhatsappVoiceStack } from '../lib/whatsapp-voice-stack';

const configParams = require('../config.params.json');

const app = new cdk.App();

const tags = configParams['Tags'] || {}; // Use uppercase 'Tags' and provide a default empty object
Object.entries(tags).forEach(([key, value]) => {
    if (typeof value === "string") {
        Tags.of(app).add(key, value);
    }
})

new WhatsappVoiceStack(app, `${configParams.CdkProjectName}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});
