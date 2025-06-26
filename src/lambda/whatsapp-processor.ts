// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SQSEvent, SQSHandler } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { S3Service } from './services/S3Service';
import { WhatsAppService } from './services/WhatsAppService';
import { WTranscribeService } from './services/WTranscribeService';
import { TranscribeService } from './services/TranscribeService';

const snsClient = new SNSClient({ region: process.env.AWS_REGION });

const {
  WHATSAPP_S3_BUCKET_NAME,
  VOICE_ENGINE = 'whisper',
  PROCESSED_MESSAGES_TOPIC_ARN,
} = process.env;

export const handler: SQSHandler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body);
      const snsMessage = JSON.parse(body.Message);
      
      // Parse WhatsApp message
      const webhook = JSON.parse(snsMessage.whatsAppWebhookEntry);
      const change = webhook?.changes?.[0]?.value;
      
      if (!change || change.statuses) {
        console.log('Not a message or is a status update, skipping');
        continue;
      }
      
      const msg = change.messages[0];
      
      // Skip if not an audio message
      if (msg.type !== 'audio') {
        console.log(`Message type ${msg.type} is not audio, skipping`);
        continue;
      }
      
      // Create base message object
      const message = {
        originationNumber: `+${msg.from}`,
        destinationNumber: `+${change.metadata.display_phone_number}`,
        inboundMessageId: msg.id,
        previousPublishedMessageId: msg.id,
        contactName: change.contacts?.[0]?.profile?.name,
        messageType: msg.type,
      };
      
      console.log(`Processing audio message from ${message.originationNumber}`);
      
      // Mark message as read
      await WhatsAppService.markMessageAsRead(msg.id);
      
      // Download audio file
      const mediaInfo = await WhatsAppService.getWhatsAppMedia(msg.audio.id);
      if (mediaInfo.result !== 'success') {
        console.error(`Failed to process audio: ${mediaInfo.message}`);
        await sendResponse(message, 'Please record shorter voice messages.');
        continue;
      }
      
      try {
        // Transcribe audio based on configured engine
        let transcription;
        
        if (VOICE_ENGINE.toLowerCase() === 'whisper') {
          // Use Whisper
          const startTime = performance.now();
          const result = await WTranscribeService.transcribeAudioFromS3(mediaInfo.s3Key);
          const duration = (performance.now() - startTime) / 1000;
          console.log('Whisper Transcribe duration:', `${duration.toFixed(2)} seconds`);
          transcription = result.transcription;
        } else {
          // Use Amazon Transcribe
          const startTime = performance.now();
          const result = await TranscribeService.transcribeAudioFromS3(mediaInfo.s3Key);
          const duration = (performance.now() - startTime) / 1000;
          console.log('Amazon Transcribe duration:', `${duration.toFixed(2)} seconds`);
          transcription = result.transcription;
        }
        
        // Send transcription back to user
        await sendResponse(message, `*You said:* ${transcription}`);
        
        // Clean up S3 object
        await S3Service.deleteS3Object(WHATSAPP_S3_BUCKET_NAME, `whatsapp-media/sum_${msg.audio.id}.ogg`);
        
        // Publish to SNS topic if configured
        if (PROCESSED_MESSAGES_TOPIC_ARN) {
          const processedMessage = {
            ...message,
            messageBody: transcription,
          };
          
          await snsClient.send(
            new PublishCommand({
              TopicArn: PROCESSED_MESSAGES_TOPIC_ARN,
              Message: JSON.stringify(processedMessage),
              MessageAttributes: {
                messageType: {
                  DataType: 'String',
                  StringValue: 'TranscribedAudio',
                },
              },
            }),
          );
        }
      } catch (err) {
        console.error('Error during transcription:', err);
        // Clean up S3 object if it exists
        await S3Service.deleteS3Object(WHATSAPP_S3_BUCKET_NAME, `whatsapp-media/sum_${msg.audio.id}.ogg`);
        await sendResponse(message, 'Sorry, I couldn\'t process that voice message.');
      }
    } catch (err) {
      console.error('Error processing record:', err);
    }
  }
  
  return { statusCode: 200, message: 'Processing complete' };
};

// Helper function to send WhatsApp response
async function sendResponse(message: any, text: string): Promise<void> {
  await WhatsAppService.sendWhatsAppMessage(
    message.originationNumber.replace('+', ''),
    text
  );
}
