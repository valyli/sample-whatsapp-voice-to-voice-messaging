// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  SocialMessagingClient,
  SendWhatsAppMessageCommand,
  GetWhatsAppMessageMediaCommand,
  PostWhatsAppMessageMediaCommand,
  DeleteWhatsAppMessageMediaCommand
} from '@aws-sdk/client-socialmessaging';

const client = new SocialMessagingClient({ region: process.env.AWS_REGION });

export class WhatsAppService {
  /**
   * Mark a WhatsApp message as read
   */
  static async markMessageAsRead(messageId: string) {
    const message = {
      messaging_product: 'whatsapp',
      message_id: messageId,
      status: 'read',
      typing_indicator: {
        type: 'text',
      },
    };

    const params = {
      originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      message: new TextEncoder().encode(JSON.stringify(message)),
      metaApiVersion: 'v19.0',
    };

    try {
      const command = new SendWhatsAppMessageCommand(params);
      const response = await client.send(command);
      return response;
    } catch (error: any) {
      console.error('WhatsAppService.markMessageAsRead: ', error);
      throw new Error(error.message);
    }
  }

  /**
   * Send a WhatsApp message (generic function for both text and audio)
   */
  static async sendWhatsAppMessage(
    destinationNumber: string,
    content: string | { mediaId: string },
    options: {
      type: 'text' | 'audio',
      previewUrl?: boolean,
      sessionId?: string
    } = { type: 'text' }
  ) {
    // Log the phone number for debugging
    console.log(`Sending ${options.type} message to phone number: ${destinationNumber}`);
    
    // Ensure the phone number is in the correct format (with + prefix)
    let formattedNumber = destinationNumber;
    
    // Add + prefix if not present
    if (!formattedNumber.startsWith('+')) {
      formattedNumber = `+${formattedNumber}`;
    }
    
    console.log(`Formatted phone number: ${formattedNumber}`);
    
    // Create the base message object
    const message: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedNumber,
      type: options.type,
    };
    
    // Add content based on message type
    if (options.type === 'text' && typeof content === 'string') {
      message.text = {
        preview_url: options.previewUrl || false,
        body: content,
      };
    } else if (options.type === 'audio' && typeof content === 'object' && 'mediaId' in content) {
      message.audio = {
        id: content.mediaId
      };
    }
    
    // Add session ID if provided
    if (options.sessionId) {
      message.biz_opaque_callback_data = options.sessionId;
    }

    const params = {
      originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      message: new TextEncoder().encode(JSON.stringify(message)),
      metaApiVersion: 'v19.0',
    };

    try {
      const command = new SendWhatsAppMessageCommand(params);
      const response = await client.send(command);
      return response;
    } catch (error: any) {
      console.error(`WhatsAppService.sendWhatsApp${options.type === 'text' ? 'Message' : 'Audio'}: `, error);
      throw new Error(error.message);
    }
  }
  
  /**
   * Send a WhatsApp text message (convenience method)
   */
  static async sendWhatsAppTextMessage(
    destinationNumber: string,
    outboundMessage: string,
    previewUrl = false,
    sessionId?: string,
  ) {
    return this.sendWhatsAppMessage(
      destinationNumber,
      outboundMessage,
      { type: 'text', previewUrl, sessionId }
    );
  }

  /**
   * Download WhatsApp media
   */
  static async getWhatsAppMedia(mediaId: string, maxSizeKB = 30120) {
    const metadataParams = {
      mediaId: mediaId,
      originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      metadataOnly: true,
    };

    // Construct the possible S3 key formats
    const s3KeyBase = `whatsapp-media/sum_`;
    const bucketName = process.env.WHATSAPP_S3_BUCKET_NAME || '';
    
    // The WhatsApp API sometimes creates files with duplicated mediaId, sometimes without
    const standardS3Key = `${s3KeyBase}${mediaId}.ogg`;
    const duplicatedS3Key = `${s3KeyBase}${mediaId}.ogg${mediaId}.ogg`;
    
    // Log the S3 key and bucket name for debugging
    console.log(`Downloading media with ID ${mediaId} to S3 bucket: ${bucketName}`);
    console.log(`Possible S3 key patterns: ${standardS3Key} or ${duplicatedS3Key}`);

    const mediaParams = {
      mediaId: mediaId,
      originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      destinationS3File: {
        bucketName: bucketName,
        key: s3KeyBase,
      },
    };

    try {
      // Get metadata
      const metadataCommand = new GetWhatsAppMessageMediaCommand(metadataParams);
      const metadataResponse = await client.send(metadataCommand);
      console.log(metadataResponse.fileSize);

      // Check file size
      if (metadataResponse.fileSize && metadataResponse.fileSize > maxSizeKB) {
        return {
          result: 'error',
          message: 'size_exceeded',
        };
      }

      // Get actual media
      const mediaCommand = new GetWhatsAppMessageMediaCommand(mediaParams);
      await client.send(mediaCommand);

      // Return success response with the standard S3 key first (we'll check both formats later)
      return {
        result: 'success',
        message: 'media_downloaded',
        s3Key: standardS3Key,
        alternateS3Key: duplicatedS3Key,
        fileSizeKB: metadataResponse.fileSize,
      };
    } catch (error: any) {
      console.error('WhatsAppService.getWhatsAppMedia: ', error);
      return {
        result: 'error',
        message: error.message,
      };
    }
  }

  /**
   * Upload audio file to WhatsApp from S3
   */
  static async uploadWhatsAppAudio(s3Key: string) {
    try {
      const params = {
        originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        sourceS3File: {
          bucketName: process.env.WHATSAPP_S3_BUCKET_NAME,
          key: s3Key
        }
      };

      const command = new PostWhatsAppMessageMediaCommand(params);
      const response = await client.send(command);

      return {
        result: 'success',
        message: 'audio_uploaded',
        mediaId: response.mediaId
      };
    } catch (error: any) {
      console.error('WhatsAppService.uploadWhatsAppAudio: ', error);
      return {
        result: 'error',
        message: error.message
      };
    }
  }

  /**
   * Send a WhatsApp audio message (convenience method)
   */
  static async sendWhatsAppAudio(
    destinationNumber: string,
    mediaId: string,
    sessionId?: string
  ) {
    return this.sendWhatsAppMessage(
      destinationNumber,
      { mediaId },
      { type: 'audio', sessionId }
    );
  }

  /**
   * Delete WhatsApp media
   */
  static async deleteWhatsAppMedia(mediaId: string) {
    try {
      const params = {
        mediaId: mediaId,
        originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID
      };

      const command = new DeleteWhatsAppMessageMediaCommand(params);
      const response = await client.send(command);

      return {
        result: 'success',
        message: 'media_deleted',
        success: response.success
      };
    } catch (error: any) {
      console.error('WhatsAppService.deleteWhatsAppMedia: ', error);
      return {
        result: 'error',
        message: error.message
      };
    }
  }
}
