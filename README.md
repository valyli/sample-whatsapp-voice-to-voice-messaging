# WhatsApp Voice Message Processing System

This project provides an AWS CDK stack for processing WhatsApp voice messages with transcription capabilities. It allows you to receive voice messages via WhatsApp, transcribe them using either Amazon Whisper (via SageMaker) or Amazon Transcribe, and send the transcription back to the user.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for a detailed architecture diagram and description.

The system consists of the following components:

1. **SNS Topic**: Receives WhatsApp messages from the WhatsApp Business API
2. **SQS Queue**: Subscribes to the SNS topic and buffers messages for processing
3. **Lambda Function**: Processes voice messages from the queue
4. **S3 Buckets**: Store audio files and access logs
5. **KMS**: Customer Managed Key (CMK) for encrypting SNS and SQS data

## Features

- **Secure Communication**: All data is encrypted using Customer Managed Keys (CMK)
- **Flexible Configuration**: Use existing SNS topics or create new ones
- **Dual Transcription Options**: Choose between Whisper (SageMaker) or Amazon Transcribe
- **Scalable Architecture**: Leverages serverless components for automatic scaling
- **Comprehensive Logging**: Access logs for S3 operations and CloudWatch logs for Lambda

## Prerequisites

- AWS Account with appropriate permissions
- Node.js 14.x or later
- AWS CDK v2 installed (`npm install -g aws-cdk`)
- WhatsApp Business API account with a registered phone number
- For Whisper: A deployed SageMaker endpoint running Whisper

## Configuration

The system is configured through the `config.params.json` file:

```json
{
    "CdkProjectName": "WhatsappVoiceStack",
    "Engine": "whisper",
    "WhisperEndpointName": "your-whisper-endpoint-name",
    "WhatsAppPhoneNumberId": "YOUR_WHATSAPP_PHONE_NUMBER_ID",
    "WhatsAppSNSTopicArn": "",
    "CreateNewSnsTopic": true,
    "S3BucketConfig": {
        "MediaBucketName": "whatsapp-voice-media",
        "LogsBucketName": "whatsapp-voice-logs"
    },
    "Tags": {
        "Project": "WhatsAppVoice",
        "Environment": "Development"
    }
}
```

### Configuration Options

| Parameter | Description |
|-----------|-------------|
| `CdkProjectName` | Name of the CDK stack |
| `Engine` | Transcription engine to use (`whisper` or `transcribe`) |
| `WhisperEndpointName` | Name of the SageMaker endpoint running Whisper (required if Engine is `whisper`) |
| `WhatsAppPhoneNumberId` | Your WhatsApp Business API phone number ID |
| `WhatsAppSNSTopicArn` | ARN of an existing SNS topic (leave empty to create a new one) |
| `CreateNewSnsTopic` | Whether to create a new SNS topic (`true`) or use existing (`false`) |
| `S3BucketConfig` | Configuration for S3 buckets |
| `Tags` | AWS resource tags |

## Deployment

1. Clone this repository
2. Update the `config.params.json` file with your settings
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the project:
   ```bash
   npm run build
   ```
5. Deploy the stack:
   ```bash
   cdk deploy
   ```

## Usage

Once deployed, the system will automatically process WhatsApp voice messages:

1. A user sends a voice message to your WhatsApp Business number
2. The message is published to the SNS topic
3. The SQS queue receives the message
4. The Lambda function processes the voice message:
   - Downloads the audio file
   - Transcribes it using the configured engine
   - Sends the transcription back to the user
   - Stores the audio in S3

## Lambda Function Structure

The Lambda function consists of several modules:

- `whatsapp-processor.ts`: Main handler for processing messages
- `services/WhatsAppService.ts`: Service for interacting with WhatsApp API
- `services/S3Service.ts`: Service for S3 operations
- `services/WTranscribeService.ts`: Service for Whisper transcription
- `services/TranscribeService.ts`: Service for Amazon Transcribe

### FFmpeg Lambda Layer

The system includes an FFmpeg Lambda layer for audio processing:

- Located in `layers/ffmpeg/`
- Contains the FFmpeg binary executable in `bin/ffmpeg`
- Used for converting audio formats (OGG to WAV/PCM) before transcription
- Automatically attached to the Lambda function during deployment

## Security Considerations

- All data in transit and at rest is encrypted
- SNS and SQS use Customer Managed Keys (CMK)
- S3 buckets enforce SSL and block public access
- IAM policies follow the principle of least privilege

## Monitoring and Logging

- CloudWatch Logs for Lambda function
- S3 access logs for bucket operations
- CloudWatch Metrics for SNS, SQS, and Lambda

## Cleanup

To remove all resources created by this stack:

```bash
cdk destroy
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.
