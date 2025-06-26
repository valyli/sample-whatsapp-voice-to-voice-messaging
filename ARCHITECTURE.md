# WhatsApp Voice Message Processing System Architecture

## Components and Flow

```
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  WhatsApp     │     │     SNS       │     │     SQS       │
│  Business API ├────►│  Topic (CMK)  ├────►│  Queue (CMK)  │
└───────────────┘     └───────────────┘     └───────┬───────┘
                                                   │
                                                   ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  WhatsApp     │     │   Lambda      │     │     S3        │
│  User         │◄────┤  Function     │◄────┤  Bucket       │
└───────────────┘     └───────┬───────┘     └───────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  Transcription  │
                     │  Service        │
                     │  (Whisper/      │
                     │   Transcribe)   │
                     └─────────────────┘
```

## Data Flow

1. A user sends a voice message to your WhatsApp Business number
2. The WhatsApp Business API publishes the message to an SNS topic
3. An SQS queue subscribed to the SNS topic receives the message
4. A Lambda function triggered by the SQS queue processes the message:
   - Downloads the audio file from WhatsApp
   - Uploads it to an S3 bucket
   - Sends it to the transcription service (Whisper or Amazon Transcribe)
   - Receives the transcription
   - Sends the transcription back to the user via WhatsApp
   - Optionally publishes the processed message to another SNS topic

## Security Features

- SNS topic is encrypted with a Customer Managed Key (CMK)
- SQS queue is encrypted with the same CMK
- S3 bucket enforces SSL and blocks public access
- S3 bucket uses server-side encryption
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
