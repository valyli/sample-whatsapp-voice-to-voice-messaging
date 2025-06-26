// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SageMakerRuntimeClient, InvokeEndpointCommand } from '@aws-sdk/client-sagemaker-runtime';

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const sagemakerClient = new SageMakerRuntimeClient({ region: process.env.AWS_REGION });

export class WTranscribeService {
  /**
   * Transcribe audio from S3 using Whisper
   */
  static async transcribeAudioFromS3(mediaKey: string) {
    const bucketName = process.env.WHATSAPP_S3_BUCKET_NAME || '';
    const oggPath = path.join(tmpdir(), `${mediaKey}.ogg`);
    const wavPath = path.join(tmpdir(), `${mediaKey}.wav`);

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

      // Convert OGG to WAV using ffmpeg in Lambda layer
      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn('/opt/bin/ffmpeg', [
          '-i',
          oggPath,
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wavPath,
        ]);

        ffmpeg.stderr.on('data', (data) => {});

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg failed with code ${code}`));
          }
        });
      });

      // Read the converted WAV file and convert to hex
      const wavBuffer = readFileSync(wavPath);
      const audioHex = Buffer.from(wavBuffer).toString('hex');

      // Create payload for Whisper model
      const payload = {
        audio_input: audioHex,
        language: 'english',
        task: 'transcribe',
        top_p: 0.9,
      };

      // Invoke the SageMaker endpoint running Whisper
      const command = new InvokeEndpointCommand({
        EndpointName: process.env.WHISPER_ENDPOINT_NAME || '',
        ContentType: 'application/json',
        Body: JSON.stringify(payload),
      });

      const response = await sagemakerClient.send(command);
      
      if (!response.Body) {
        throw new Error('Empty response from Whisper endpoint');
      }
      
      const responseBody = JSON.parse(new TextDecoder().decode(response.Body));
      const transcriptionText = responseBody.text.toString();

      // Clean up temporary files
      unlinkSync(oggPath);
      unlinkSync(wavPath);

      return {
        result: 'success',
        message: 'transcription_completed',
        transcription: transcriptionText,
        mediaKey,
      };
    } catch (error) {
      console.error('Error invoking Whisper endpoint:', error);
      
      // Clean up files even if there's an error
      try {
        unlinkSync(oggPath);
        unlinkSync(wavPath);
      } catch (cleanupError) {
        console.error('Error cleaning up files:', cleanupError);
      }
      
      throw error;
    }
  }
}
