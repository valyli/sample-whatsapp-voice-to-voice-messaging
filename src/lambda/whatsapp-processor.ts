// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SQSEvent, SQSHandler } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { S3Service } from './services/S3Service';
import { WhatsAppService } from './services/WhatsAppService';
import { WTranscribeService } from './services/WTranscribeService';
import { TranscribeService } from './services/TranscribeService';
import { PollyService } from './services/PollyService';

const snsClient = new SNSClient({ region: process.env.AWS_REGION });

const {
  WHATSAPP_S3_BUCKET_NAME = '',
  VOICE_ENGINE = 'whisper',
  PROCESSED_MESSAGES_TOPIC_ARN,
  ENABLE_AUDIO_RESPONSES = 'false',
  POLLY_VOICE_ID = 'Joanna'
} = process.env;

export const handler: SQSHandler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    try {
      console.log('Processing SQS record:', record.body);
      
      // Check if the body is already an object (might be pre-parsed by SQS)
      let body;
      try {
        body = typeof record.body === 'string' ? JSON.parse(record.body) : record.body;
      } catch (parseError) {
        console.error('Error parsing record body:', parseError);
        console.log('Raw record body:', record.body);
        continue;
      }
      
      // Parse WhatsApp message - handle both direct webhook and SNS message formats
      let webhook;
      try {
        // Check if this is a direct webhook message or an SNS message
        if (body.whatsAppWebhookEntry && typeof body.whatsAppWebhookEntry === 'string') {
          // Direct webhook format
          console.log('Processing direct webhook message');
          webhook = JSON.parse(body.whatsAppWebhookEntry);
        } else if (body.Message && typeof body.Message === 'string') {
          // SNS message format
          console.log('Processing SNS message');
          const snsMessage = JSON.parse(body.Message);
          
          if (!snsMessage.whatsAppWebhookEntry || typeof snsMessage.whatsAppWebhookEntry !== 'string') {
            console.error('Invalid SNS message format, missing whatsAppWebhookEntry property or not a string');
            console.log('SNS Message:', JSON.stringify(snsMessage));
            continue;
          }
          
          webhook = JSON.parse(snsMessage.whatsAppWebhookEntry);
        } else {
          console.error('Unsupported message format, missing both whatsAppWebhookEntry and Message properties');
          console.log('Body:', JSON.stringify(body));
          continue;
        }
      } catch (parseError) {
        console.error('Error parsing webhook entry:', parseError);
        console.log('Body:', JSON.stringify(body));
        continue;
      }
      
      const change = webhook?.changes?.[0]?.value;
      
      if (!change || change.statuses) {
        console.log('Not a message or is a status update, skipping');
        continue;
      }
      
      const msg = change.messages[0];
      
      // Create base message object
      const message = {
        originationNumber: `+${msg.from}`,
        destinationNumber: `+${change.metadata.display_phone_number}`,
        inboundMessageId: msg.id,
        previousPublishedMessageId: msg.id,
        contactName: change.contacts?.[0]?.profile?.name,
        messageType: msg.type,
      };
      
      // Handle different message types
      if (msg.type === 'text') {
        console.log(`Processing text message from ${message.originationNumber}`);
        
        // Extract text content
        const textContent = msg.text?.body || '';
        
        // Send a response
        await sendResponse(message, `You said: ${textContent}`);
        
        // If audio responses are enabled, generate and send audio response
        if (ENABLE_AUDIO_RESPONSES.toLowerCase() === 'true') {
          try {
            console.log('Generating audio response using Polly');
            
            // Generate audio from text using Polly
            const pollyResult = await PollyService.textToSpeech(
              textContent,
              POLLY_VOICE_ID
            );
            
            if (pollyResult.result === 'success') {
              console.log('Audio generated successfully, uploading to WhatsApp');
              
              // Upload audio to WhatsApp
              const uploadResult = await WhatsAppService.uploadWhatsAppAudio(pollyResult.s3Key);
              
              if (uploadResult.result === 'success' && uploadResult.mediaId) {
                console.log('Audio uploaded successfully, sending to user');
                
                // Send audio message
                await WhatsAppService.sendWhatsAppAudio(
                  message.originationNumber,
                  uploadResult.mediaId
                );
                
                // Delete the WhatsApp media after sending
                await WhatsAppService.deleteWhatsAppMedia(uploadResult.mediaId);
              }
            }
          } catch (audioError) {
            console.error('Error processing audio response:', audioError);
          }
        }
        
        continue;
      }
      
      // Skip if not an audio message
      if (msg.type !== 'audio') {
        console.log(`Message type ${msg.type} is not supported, skipping`);
        continue;
      }
      
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
      
      // Log the S3 key for debugging
      console.log(`S3 key for audio file: ${mediaInfo.s3Key}`);
      
      // Add a delay to ensure the S3 object is fully available
      console.log('Waiting for S3 object to be fully available...');
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      
      // Check if the S3 object exists in either format
      console.log('Checking if S3 object exists...');
      let objectExists = await S3Service.objectExists(WHATSAPP_S3_BUCKET_NAME, mediaInfo.s3Key || '');
      
      // If the standard format doesn't exist, try the alternate format
      if (!objectExists && mediaInfo.alternateS3Key) {
        console.log(`Standard S3 key not found, trying alternate key: ${mediaInfo.alternateS3Key}`);
        objectExists = await S3Service.objectExists(WHATSAPP_S3_BUCKET_NAME, mediaInfo.alternateS3Key);
        
        // If the alternate format exists, update the s3Key in mediaInfo
        if (objectExists) {
          console.log(`Found object with alternate key: ${mediaInfo.alternateS3Key}`);
          mediaInfo.s3Key = mediaInfo.alternateS3Key;
        }
      }
      
      if (!objectExists) {
        console.log('S3 object does not exist in any format, listing objects in bucket...');
        await S3Service.listObjects(WHATSAPP_S3_BUCKET_NAME, 'whatsapp-media/');
        throw new Error('S3 object does not exist');
      }
      
      try {
        // Transcribe audio based on configured engine
        let transcription;
        
        if (VOICE_ENGINE.toLowerCase() === 'whisper') {
          // Use Whisper
          const startTime = performance.now();
          const result = await WTranscribeService.transcribeAudioFromS3(mediaInfo.s3Key || '');
          const duration = (performance.now() - startTime) / 1000;
          console.log('Whisper Transcribe duration:', `${duration.toFixed(2)} seconds`);
          transcription = result.transcription;
        } else {
          // Use Amazon Transcribe
          const startTime = performance.now();
          const result = await TranscribeService.transcribeAudioFromS3(mediaInfo.s3Key || '');
          const duration = (performance.now() - startTime) / 1000;
          console.log('Amazon Transcribe duration:', `${duration.toFixed(2)} seconds`);
          transcription = result.transcription;
        }
        
        // Send transcription back to user as text
        await sendResponse(message, `*You said:* ${transcription}`);
        
        // If audio responses are enabled, generate and send audio response
        if (ENABLE_AUDIO_RESPONSES.toLowerCase() === 'true') {
          try {
            console.log('Generating audio response using Polly');
            
            // Generate audio from transcription using Polly
            const pollyResult = await PollyService.textToSpeech(
              transcription,
              POLLY_VOICE_ID
            );
            
            if (pollyResult.result === 'success') {
              console.log('Audio generated successfully, uploading to WhatsApp');
              
              // Upload audio to WhatsApp
              const uploadResult = await WhatsAppService.uploadWhatsAppAudio(pollyResult.s3Key);
              
              if (uploadResult.result === 'success' && uploadResult.mediaId) {
                console.log('Audio uploaded successfully, sending to user');
                
                // Send audio message
                await WhatsAppService.sendWhatsAppAudio(
                  message.originationNumber,
                  uploadResult.mediaId
                );
                
                // Delete the WhatsApp media after sending
                await WhatsAppService.deleteWhatsAppMedia(uploadResult.mediaId);
              }
            }
          } catch (audioError) {
            console.error('Error processing audio response:', audioError);
          }
        }
        
        // Clean up S3 object - use the same S3 key that was returned from getWhatsAppMedia
        await S3Service.deleteS3Object(WHATSAPP_S3_BUCKET_NAME, mediaInfo.s3Key || '');
        
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
        try {
          await S3Service.deleteS3Object(WHATSAPP_S3_BUCKET_NAME, mediaInfo.s3Key || '');
        } catch (deleteErr) {
          console.error('Error deleting S3 object:', deleteErr);
          // Continue execution even if deletion fails
        }
        
        // Only send error message if there was a real transcription error
        if (err instanceof Error && err.message !== 'media_deleted') {
          await sendResponse(message, 'Sorry, I couldn\'t process that voice message.');
        }
      }
    } catch (err) {
      console.error('Error processing record:', err);
    }
  }
  
  // Lambda handlers for SQS events don't need to return anything
};

// Helper function to send WhatsApp response
async function sendResponse(message: any, text: string): Promise<void> {
  await WhatsAppService.sendWhatsAppTextMessage(
    message.originationNumber,
    text
  );
}
