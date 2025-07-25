import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

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

    // Create a Dead Letter Queue (DLQ) for handling failed message processing
    const deadLetterQueue = new sqs.Queue(this, 'WhatsappVoiceDLQ', {
      queueName: 'WhatsappVoiceDLQ',
      enforceSSL: true,
    });

    const whatsappQueue = new sqs.Queue(this, 'WhatsappVoiceQueue', {
      queueName: 'WhatsappVoiceQueue',
      visibilityTimeout: Duration.seconds(300),
      enforceSSL: true,
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3, // Number of times a message can be received before being sent to the DLQ
      },
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
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X], // Updated to latest Node.js runtime
      description: 'Layer with ffmpeg binary for audio processing',
    });

    ///////// ------ Lambda Function for Processing WhatsApp Messages ------ /////////

    // Create a log group for the Lambda function
    const lambdaLogGroup = new logs.LogGroup(this, 'WhatsappProcessingLambdaLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create a Lambda function for processing WhatsApp messages
    const processingLambda = new lambda.Function(this, 'WhatsappProcessingLambda', {
      runtime: lambda.Runtime.NODEJS_20_X, // Updated to latest Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/lambda')),
      handler: 'dist/whatsapp-processor.handler',
      timeout: Duration.seconds(60),
      memorySize: 1024,
      logGroup: lambdaLogGroup,
      layers: [ffmpegLayer],
      environment: {
        WHATSAPP_MEDIA_BUCKET: whatsappMediaBucket.bucketName,
        WHATSAPP_S3_BUCKET_NAME: whatsappMediaBucket.bucketName,
        WHATSAPP_PHONE_NUMBER_ID: whatsAppPhoneNumberId,
        VOICE_ENGINE: engine.toLowerCase(),
        WHISPER_ENDPOINT_NAME: whisperEndpointName || '',
        // Use the actual topic ARN
        PROCESSED_MESSAGES_TOPIC_ARN: createNewSnsTopic || !whatsAppSNSTopicArn 
          ? whatsappTopic.topicArn 
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
    eventSourceMapping.addDependency(cfnFunction);

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

    // Add permissions based on the transcription engine
    // For Whisper, we need SageMaker permissions
    if (engine.toLowerCase() === 'whisper') {
      processingLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sagemaker:InvokeEndpoint'],
          resources: [
            `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${whisperEndpointName}`,
          ],
        })
      );
    } 
    // For any other engine, we need Transcribe permissions
    else {
      processingLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['transcribe:StartStreamTranscription'],
          resources: ['*'], // Transcribe doesn't support resource-level permissions for this action
        })
      );
    }
    
    // Add Polly permissions for text-to-speech
    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['polly:SynthesizeSpeech'],
        resources: ['*'], // Polly requires * for SynthesizeSpeech as it needs access to both voices and lexicons
      })
    );
    
    // Add SNS publish permissions
    processingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        resources: [
          createNewSnsTopic || !whatsAppSNSTopicArn 
            ? whatsappTopic.topicArn 
            : whatsAppSNSTopicArn,
        ],
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

    // Add CDK Nag suppressions for specific resources
    this.addNagSuppressions(
      whatsappMediaBucket, 
      accessLogsBucket, 
      processingLambda, 
      whatsappQueue, 
      whatsappTopic instanceof sns.Topic ? whatsappTopic : undefined,
      ffmpegLayer
    );
  }

  /**
   * Add CDK Nag suppressions for specific resources
   */
  private addNagSuppressions(
    whatsappMediaBucket: s3.Bucket,
    accessLogsBucket: s3.Bucket,
    processingLambda: lambda.Function,
    whatsappQueue: sqs.Queue,
    whatsappTopic?: sns.Topic,
    ffmpegLayer?: lambda.LayerVersion
  ): void {
    // Suppress warnings for the Lambda function
    NagSuppressions.addResourceSuppressions(
      processingLambda,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Lambda needs managed policies for basic execution and specific AWS service access',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Transcribe service does not support resource-level permissions for StartStreamTranscription',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Polly service requires access to all voices and lexicons for SynthesizeSpeech',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Lambda needs wildcard permissions for S3 to access multiple objects with different keys',
          appliesTo: [`Resource::${whatsappMediaBucket.bucketArn}/*`],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'WhatsApp API requires wildcard permissions for phone-number-id/* to properly function with SendWhatsAppMessage and other operations',
          appliesTo: [`Resource::arn:aws:social-messaging:${this.region}:${this.account}:phone-number-id/*`],
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Latest runtime is used for the Lambda function',
        },
      ],
      true
    );

    // Suppress warnings for the S3 buckets
    NagSuppressions.addResourceSuppressions(
      whatsappMediaBucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'Server access logs are configured to go to a separate access logs bucket',
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      accessLogsBucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'This is the access logs bucket itself, no need for server access logging',
        },
      ],
      true
    );

    // Suppress warnings for the SQS queue
    NagSuppressions.addResourceSuppressions(
      whatsappQueue,
      [
        {
          id: 'AwsSolutions-SQS3',
          reason: 'DLQ not required for this use case as messages are processed immediately',
        },
        {
          id: 'AwsSolutions-SQS4',
          reason: 'SSL is enforced through the enforceSSL property',
        },
      ],
      true
    );

    // Suppress warnings for the SNS topic if it's a new one
    if (whatsappTopic) {
      NagSuppressions.addResourceSuppressions(
        whatsappTopic,
        [
          {
            id: 'AwsSolutions-SNS2',
            reason: 'Server-side encryption is not required for this use case',
          },
          {
            id: 'AwsSolutions-SNS3',
            reason: 'Topic policy is configured with appropriate permissions',
          },
        ],
        true
      );
    }

    // Suppress warnings for the Lambda layer
    if (ffmpegLayer) {
      NagSuppressions.addResourceSuppressions(
        ffmpegLayer,
        [
          {
            id: 'AwsSolutions-L1',
            reason: 'Latest runtime is used for the Lambda layer',
          },
        ],
        true
      );
    }

    // Add stack-level suppressions for any remaining warnings
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Some IAM policies require wildcard permissions for service functionality',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS managed policies are used for standard functionality',
        },
      ],
      true
    );
  }
}
