// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { S3Client, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';

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
  
  /**
   * Check if an object exists in S3
   */
  static async objectExists(bucketName: string, key: string) {
    try {
      const command = new HeadObjectCommand({
        Bucket: bucketName,
        Key: key,
      });
      
      await s3Client.send(command);
      console.log(`S3 object exists: ${bucketName}/${key}`);
      return true;
    } catch (error) {
      console.error(`S3 object does not exist: ${bucketName}/${key}`, error);
      return false;
    }
  }
  
  /**
   * List objects in an S3 bucket with a prefix
   */
  static async listObjects(bucketName: string, prefix: string = '') {
    try {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        MaxKeys: 10, // Limit to 10 objects for debugging
      });
      
      const response = await s3Client.send(command);
      console.log(`Listed S3 objects in ${bucketName} with prefix ${prefix}:`);
      response.Contents?.forEach(item => {
        console.log(`- ${item.Key} (${item.Size} bytes)`);
      });
      
      return response.Contents || [];
    } catch (error) {
      console.error('Error listing S3 objects:', error);
      return [];
    }
  }
}
