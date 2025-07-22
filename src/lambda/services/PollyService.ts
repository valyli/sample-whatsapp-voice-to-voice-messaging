// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PollyClient, SynthesizeSpeechCommand, VoiceId } from '@aws-sdk/client-polly';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';

const pollyClient = new PollyClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

export class PollyService {
  /**
   * Convert text to speech using Amazon Polly and store in S3
   */
  static async textToSpeech(text: string, voiceId: string = 'Joanna') {
    // Cast the voiceId string to VoiceId type
    const pollyVoiceId = voiceId as VoiceId;
    try {
      // Generate a unique key for the audio file
      const audioKey = `polly-audio/${randomUUID()}.mp3`;
      
      // Synthesize speech using Polly
      const command = new SynthesizeSpeechCommand({
        OutputFormat: 'mp3',
        Text: text,
        VoiceId: pollyVoiceId,
        Engine: 'neural',
        TextType: 'text'
      });
      
      const response = await pollyClient.send(command);
      
      if (!response.AudioStream) {
        throw new Error('No audio stream returned from Polly');
      }
      
      // Convert AudioStream to Buffer
      const chunks: Buffer[] = [];
      const audioStream = response.AudioStream as Readable;
      
      for await (const chunk of audioStream) {
        chunks.push(Buffer.from(chunk));
      }
      
      const audioBuffer = Buffer.concat(chunks);
      
      // Upload to S3
      const uploadCommand = new PutObjectCommand({
        Bucket: process.env.WHATSAPP_S3_BUCKET_NAME,
        Key: audioKey,
        Body: audioBuffer,
        ContentType: 'audio/mpeg'
      });
      
      await s3Client.send(uploadCommand);
      
      return {
        result: 'success',
        message: 'audio_generated',
        s3Key: audioKey,
        audioBuffer
      };
    } catch (error: any) {
      console.error('Error generating audio with Polly:', error);
      throw new Error(`Failed to generate audio: ${error.message}`);
    }
  }
}
