// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawn } from 'child_process';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import * as path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from '@aws-sdk/client-transcribe-streaming';

const transcribeClient = new TranscribeStreamingClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

export class TranscribeService {
  /**
   * Transcribe audio from S3 using Amazon Transcribe
   */
  static async transcribeAudioFromS3(mediaKey: string) {
    const bucketName = process.env.WHATSAPP_S3_BUCKET_NAME || '';
    const oggPath = path.join(tmpdir(), `${mediaKey}.ogg`);
    const pcmPath = path.join(tmpdir(), `${mediaKey}.pcm`);

    try {
      // Download OGG file
      const { Body } = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: `whatsapp-media/sum_${mediaKey}.ogg`,
        }),
      );

      if (!Body) {
        throw new Error('Empty response body from S3');
      }

      const oggBuffer = await Body.transformToByteArray();
      writeFileSync(oggPath, oggBuffer);

      // Convert OGG to PCM using ffmpeg in Lambda layer
      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn('/opt/bin/ffmpeg', [
          '-i',
          oggPath,
          '-ar',
          '16000',
          '-ac',
          '1',
          '-f',
          's16le',
          pcmPath,
        ]);

        ffmpeg.stderr.on('data', () => {
          // Suppress ffmpeg output
        });
        
        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg failed with code ${code}`));
          }
        });
      });

      // Create async generator that feeds PCM data to Transcribe
      async function* audioStream() {
        const pcmBuffer = readFileSync(pcmPath);
        const chunkSize = 6400; // 100ms of 16kHz mono PCM at 16-bit
        
        for (let i = 0; i < pcmBuffer.length; i += chunkSize) {
          yield { AudioEvent: { AudioChunk: pcmBuffer.slice(i, i + chunkSize) } };
          await new Promise((res) => setTimeout(res, 100)); // simulate real-time streaming
        }
      }

      const command = new StartStreamTranscriptionCommand({
        LanguageCode: 'en-US',
        MediaSampleRateHertz: 16000,
        MediaEncoding: 'pcm',
        AudioStream: audioStream(),
      });

      const response = await transcribeClient.send(command);
      let transcript = '';

      for await (const event of response.TranscriptResultStream || []) {
        if (event.TranscriptEvent) {
          const results = event.TranscriptEvent.Transcript?.Results || [];
          
          for (const result of results) {
            if (!result.IsPartial) {
              transcript += (result.Alternatives?.[0]?.Transcript || '') + ' ';
            }
          }
        }
      }

      // Clean up temporary files
      unlinkSync(oggPath);
      unlinkSync(pcmPath);

      return {
        result: 'success',
        message: 'transcription_completed',
        transcription: transcript.trim(),
        mediaKey,
      };
    } catch (error) {
      console.error('Error using Amazon Transcribe:', error);
      
      // Clean up files even if there's an error
      try {
        unlinkSync(oggPath);
        unlinkSync(pcmPath);
      } catch (cleanupError) {
        console.error('Error cleaning up files:', cleanupError);
      }
      
      throw error;
    }
  }
}
