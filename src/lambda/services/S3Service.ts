// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({ region: process.env.AWS_REGION });

export class S3Service {
  /**
   * Delete an object from S3
   */
  static async deleteS3Object(bucketName: string, key: string) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      });
      
      await s3Client.send(command);
      console.log(`Deleted S3 object: ${bucketName}/${key}`);
      return true;
    } catch (error) {
      console.error('Error deleting S3 object:', error);
      return false;
    }
  }
}
