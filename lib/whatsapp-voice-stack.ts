import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodeLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';

export interface WhatsappVoiceStackProps extends StackProps {
  engine?: string;
  whisperEndpointName?: string;
  whatsAppPhoneNumberId?: string;
  whatsAppSNSTopicArn?: string;
  createNewSnsTopic?: boolean;
}

export class WhatsappVoiceStack extends Stack {
  constructor(scope: Construct, id: string, props?: WhatsappVoiceStackProps) {
    super(scope, id, props);

    // Load configuration
    const configParams = require('../config.params.json');
    const engine = props?.engine || configParams.Engine || 'whisper';
    const whisperEndpointName = props?.whisperEndpointName || configParams.WhisperEndpointName;
    const whatsAppPhoneNumberId = props?.whatsAppPhoneNumberId || configParams.WhatsAppPhoneNumberId;
    const whatsAppSNSTopicArn = props?.whatsAppSNSTopicArn || configParams.WhatsAppSNSTopicArn;
    const createNewSnsTopic = props?.createNewSnsTopic !== undefined 
      ? props.createNewSnsTopic 
      : configParams.CreateNewSnsTopic !== undefined 
        ? configParams.CreateNewSnsTopic 
        : true;
    const enableAudioResponses = configParams.EnableAudioResponses !== undefined
      ? configParams.EnableAudioResponses
      : false;
    const pollyVoiceId = configParams.PollyVoiceId || 'Joanna';
    // Generate dynamic bucket names based on stack name and AWS account/region
    const stackName = id.toLowerCase().replace(/[^a-z0-9]/g, '');
    const mediaBucketPrefix = 'whatsapp-media';
    const logsBucketPrefix = 'whatsapp-logs';

    // We'll use AWS-managed keys instead of a custom CMK to avoid circular dependencies

    ///////// ------ SNS Topic for WhatsApp Messages ------ /////////

    // Either create a new SNS topic or use an existing one
    let whatsappTopic: sns.ITopic;
    
    if (createNewSnsTopic || !whatsAppSNSTopicArn) {
      // Create a new SNS topic with AWS-managed encryption
      whatsappTopic = new sns.Topic(this, 'WhatsappVoiceTopic', {
        displayName: 'WhatsApp Voice Messages Topic',
      });
      
      whatsappTopic.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowSocialMessagingPublish',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('social-messaging.amazonaws.com')],
          actions: ['sns:Publish'],
          resources: [whatsappTopic.topicArn],
        })
      );

      whatsappTopic.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: '__default_statement_ID',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
          actions: [
            'SNS:Publish',
            'SNS:RemovePermission',
            'SNS:SetTopicAttributes',
            'SNS:DeleteTopic',
            'SNS:ListSubscriptionsByTopic',
            'SNS:GetTopicAttributes',
            'SNS:AddPermission',
            'SNS:Subscribe',
          ],
          resources: [whatsappTopic.topicArn],
          conditions: {
            StringEquals: { 'AWS:SourceOwner': this.account },
          },
        })
      );
    } else {
      // Use existing SNS topic
      whatsappTopic = sns.Topic.fromTopicArn(this, 'ImportedWhatsAppTopic', whatsAppSNSTopicArn);
    }

    ///////// ------ SQS Queue for WhatsApp Messages ------ /////////

    const whatsappQueue = new sqs.Queue(this, 'WhatsappVoiceQueue', {
      queueName: 'WhatsappVoiceQueue',
      visibilityTimeout: Duration.seconds(300),
      enforceSSL: true,
    });

    whatsappQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [whatsappQueue.queueArn],
        principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
        conditions: {
          StringEquals: { 'aws:SourceArn': whatsappTopic.topicArn },
        },
      })
    );

    whatsappQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['sqs:*'],
        resources: [whatsappQueue.queueArn],
        principals: [new iam.AnyPrincipal()],
        conditions: { Bool: { 'aws:SecureTransport': 'false' } },
      })
    );

    // Subscribe the SQS queue to the SNS topic
    // Use raw message delivery to avoid circular dependencies
    whatsappTopic.addSubscription(new subs.SqsSubscription(whatsappQueue, {
      rawMessageDelivery: true
    }));

    ///////// ------ S3 Buckets for Audio Storage and Logging ------ /////////

    // Create an S3 bucket for access logs
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      // Generate a unique bucket name based on stack name and AWS account/region
      bucketName: `${logsBucketPrefix}-${stackName}-${this.account.substring(0, 8)}-${this.region}`,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Create an S3 bucket for WhatsApp media (audio files)
    const whatsappMediaBucket = new s3.Bucket(this, 'WhatsappMediaBucket', {
      // Generate a unique bucket name based on stack name and AWS account/region
      bucketName: `${mediaBucketPrefix}-${stackName}-${this.account.substring(0, 8)}-${this.region}`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'logs/whatsapp-media/',
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    ///////// ------ Lambda Layer for FFmpeg ------ /////////

    // Create a Lambda layer with FFmpeg binary for audio processing
    const ffmpegLayer = new lambda.LayerVersion(this, 'FfmpegLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../layers/ffmpeg')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
      description: 'Layer with ffmpeg binary for audio processing',
    });

    ///////// ------ Lambda Function for Processing WhatsApp Messages ------ /////////

    // Create a Lambda function for processing WhatsApp messages
    const processingLambda = new lambda.Function(this, 'WhatsappProcessingLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/lambda')),
      handler: 'dist/whatsapp-processor.handler',
      timeout: Duration.seconds(60),
      memorySize: 1024,
      logRetention: logs.RetentionDays.ONE_WEEK,
      layers: [ffmpegLayer],
      environment: {
        WHATSAPP_MEDIA_BUCKET: whatsappMediaBucket.bucketName,
        WHATSAPP_S3_BUCKET_NAME: whatsappMediaBucket.bucketName,
        WHATSAPP_PHONE_NUMBER_ID: whatsAppPhoneNumberId,
        VOICE_ENGINE: engine.toLowerCase(),
        WHISPER_ENDPOINT_NAME: whisperEndpointName || '',
        // Use a string literal for the topic ARN to break circular dependency
        PROCESSED_MESSAGES_TOPIC_ARN: createNewSnsTopic || !whatsAppSNSTopicArn 
          ? `arn:aws:sns:${this.region}:${this.account}:WhatsappVoiceTopic` 
          : whatsAppSNSTopicArn,
        ENABLE_AUDIO_RESPONSES: enableAudioResponses.toString(),
        POLLY_VOICE_ID: pollyVoiceId,
      },
    });

    // Use escape hatch to manually add the event source mapping
    // instead of using the high-level construct
    const cfnFunction = processingLambda.node.defaultChild as lambda.CfnFunction;
    
    // Create the event source mapping using CloudFormation directly
    const eventSourceMapping = new lambda.CfnEventSourceMapping(this, 'WhatsappQueueEventSourceMapping', {
      functionName: processingLambda.functionName,
      eventSourceArn: whatsappQueue.queueArn,
      batchSize: 1,
    });
    
    // Add explicit dependency to break the circular reference
    eventSourceMapping.addDependsOn(cfnFunction);

    // Add permissions to the Lambda function
    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
        resources: [whatsappQueue.queueArn],
      })
    );

    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'social-messaging:DeleteWhatsAppMessageMedia',
          'social-messaging:SendWhatsAppMessage',
          'social-messaging:PostWhatsAppMessageMedia',
          'social-messaging:GetWhatsAppMessageMedia',
        ],
        resources: [`arn:aws:social-messaging:${this.region}:${this.account}:phone-number-id/*`],
      })
    );

    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [`${whatsappMediaBucket.bucketArn}/*`],
      })
    );

    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [whatsappMediaBucket.bucketArn],
      })
    );

    // Add conditional permissions based on the transcription engine
    if (engine.toLowerCase() === 'whisper') {
      processingLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sagemaker:InvokeEndpoint'],
          resources: [
            `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${whisperEndpointName}`,
          ],
        })
      );
    } else {
      processingLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: ['*'],
        })
      );
    }
    
    // Add Polly permissions for text-to-speech
    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['polly:SynthesizeSpeech'],
        resources: ['*'],
      })
    );

    ///////// ------ Outputs ------ /////////

    new CfnOutput(this, 'WhatsappTopicArn', {
      value: whatsappTopic.topicArn,
      description: 'ARN of the WhatsApp SNS Topic',
    });

    new CfnOutput(this, 'WhatsappQueueUrl', {
      value: whatsappQueue.queueUrl,
      description: 'URL of the WhatsApp SQS Queue',
    });

    new CfnOutput(this, 'WhatsappMediaBucketName', {
      value: whatsappMediaBucket.bucketName,
      description: 'Name of the S3 bucket for WhatsApp media',
    });

    new CfnOutput(this, 'ProcessingLambdaArn', {
      value: processingLambda.functionArn,
      description: 'ARN of the WhatsApp processing Lambda function',
    });
  }
}
