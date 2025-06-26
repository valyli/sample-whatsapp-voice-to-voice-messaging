// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  SocialMessagingClient,
  SendWhatsAppMessageCommand,
  GetWhatsAppMessageMediaCommand,
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
   * Send a WhatsApp text message
   */
  static async sendWhatsAppMessage(
    destinationNumber: string,
    outboundMessage: string,
    previewUrl = false,
    sessionId?: string,
  ) {
    const message: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destinationNumber,
      type: 'text',
      text: {
        preview_url: previewUrl,
        body: outboundMessage,
      },
    };
    
    if (sessionId) {
      message.biz_opaque_callback_data = sessionId;
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
      console.error('WhatsAppService.sendWhatsAppMessage: ', error);
      throw new Error(error.message);
    }
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

    const s3Key = `whatsapp-media/sum_`;

    const mediaParams = {
      mediaId: mediaId,
      originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      destinationS3File: {
        bucketName: process.env.WHATSAPP_S3_BUCKET_NAME,
        key: s3Key,
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

      // Return success response
      return {
        result: 'success',
        message: 'media_downloaded',
        s3Key: mediaId,
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
}
