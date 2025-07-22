# WhatsApp Voice Message Processing System Architecture

## Components and Flow

```
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  WhatsApp     │     │     SNS       │     │     SQS       │
│  Business API ├────►│  Topic (KMS)  ├────►│  Queue (KMS)  │
└───────────────┘     └───────────────┘     └───────┬───────┘
                                                   │
                                                   ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  WhatsApp     │◄────┤   Lambda      │◄────┤     S3        │
│  User         │     │  Function     │     │  Bucket       │
└───────────────┘     └───────┬───────┘     └───────────────┘
        ▲                     │
        │                     ▼
        │            ┌─────────────────┐
        │            │  Transcription  │
        │            │  Service        │
        │            │  (Whisper/      │
        │            │   Transcribe)   │
        │            └─────────────────┘
        │                     │
        │                     ▼
        │            ┌─────────────────┐
        └────────────┤  Amazon Polly   │
                     │  (Optional)     │
                     └─────────────────┘
```

## Data Flow

1. **Text Messages**:
   - A user sends a text message to your WhatsApp Business number
   - The WhatsApp Business API publishes the message to an SNS topic
   - An SQS queue subscribed to the SNS topic receives the message
   - A Lambda function processes the text message and sends a response
   - If audio responses are enabled, it also:
     - Converts the text to speech using Amazon Polly
     - Uploads the audio file to S3
     - Uploads the audio to WhatsApp and gets a media ID
     - Sends the audio back to the user via WhatsApp
     - Cleans up temporary files and media

2. **Voice Messages**:
   - A user sends a voice message to your WhatsApp Business number
   - The WhatsApp Business API publishes the message to an SNS topic
   - An SQS queue subscribed to the SNS topic receives the message
   - A Lambda function triggered by the SQS queue processes the message:
     - Downloads the audio file from WhatsApp
     - Uploads it to an S3 bucket
     - Sends it to the transcription service (Whisper or Amazon Transcribe)
     - Receives the transcription
     - Sends the transcription back to the user via WhatsApp
     - If audio responses are enabled, it also:
       - Converts the transcription to speech using Amazon Polly
       - Uploads the audio file to S3
       - Uploads the audio to WhatsApp and gets a media ID
       - Sends the audio back to the user via WhatsApp
       - Cleans up temporary files and media
     - Optionally publishes the processed message to another SNS topic

## Security Features

- SNS topic is encrypted with AWS KMS
- SQS queue is encrypted with AWS KMS
- S3 bucket enforces SSL and blocks public access
- S3 bucket uses server-side encryption with AWS KMS
- Access logs are stored in a separate S3 bucket
- IAM policies follow the principle of least privilege

## Scalability

- The system uses serverless components that scale automatically
- SQS provides buffering to handle traffic spikes
- Lambda concurrency can be adjusted based on load requirements

## Monitoring

- CloudWatch Logs for Lambda function
- S3 access logs for bucket operations
- CloudWatch Metrics for SNS, SQS, and Lambda
