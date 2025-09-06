/**
 * S3 Snapshot Uploader
 * AWS SDK v3 based uploader for Session Snapshots
 * Implements memory-efficient streaming uploads
 */

const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { Readable } = require('stream');
const zlib = require('zlib');

class S3SnapshotUploader {
  constructor(options = {}) {
    this.region = options.region || process.env.AWS_REGION || 'us-east-1';
    this.bucket = options.bucket || process.env.S3_SNAPSHOT_BUCKET || 'claude-code-snapshots';
    this.keyPrefix = options.keyPrefix || 'sessions';
    this.compressionEnabled = options.compression !== false; // Default: true
    this.retryAttempts = options.retryAttempts || 3;
    
    // Initialize S3 client with memory optimization
    this.s3Client = new S3Client({
      region: this.region,
      maxAttempts: this.retryAttempts,
      requestHandler: {
        connectionTimeout: 30000,
        socketTimeout: 60000
      },
      // Memory optimization settings
      httpOptions: {
        agent: {
          maxSockets: 5,
          keepAlive: true,
          keepAliveInitialDelay: 1000
        }
      }
    });

    this.log = (message, data = {}) => {
      console.log(`[S3Uploader ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    this.log('S3 Snapshot Uploader initialized', {
      region: this.region,
      bucket: this.bucket,
      compression: this.compressionEnabled
    });
  }

  /**
   * Upload session snapshot to S3
   */
  async uploadSnapshot(snapshot, options = {}) {
    try {
      const startTime = Date.now();
      const key = this.generateS3Key(snapshot, options);
      
      this.log('Starting snapshot upload', {
        sessionId: snapshot.sessionId,
        key,
        sizeMB: Math.round(JSON.stringify(snapshot).length / 1024 / 1024 * 100) / 100
      });

      // Create upload stream
      const uploadResult = await this.streamUpload(snapshot, key, options);

      const duration = Date.now() - startTime;
      this.log('Snapshot upload completed', {
        sessionId: snapshot.sessionId,
        key,
        etag: uploadResult.ETag,
        location: uploadResult.Location,
        durationMs: duration
      });

      return {
        success: true,
        key,
        etag: uploadResult.ETag,
        location: uploadResult.Location,
        uploadDuration: duration
      };
    } catch (error) {
      this.log('Snapshot upload failed', {
        sessionId: snapshot.sessionId,
        error: error.message,
        code: error.code
      });
      throw error;
    }
  }

  /**
   * Generate S3 key for snapshot
   */
  generateS3Key(snapshot, options = {}) {
    const { sessionId, projectId, timestamp, triggerEvent } = snapshot;
    const date = new Date(timestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    
    // S3 key structure: sessions/{projectId}/{sessionId}/{year}/{month}/{day}/{timestamp}_{triggerEvent}.json[.gz]
    const baseKey = `${this.keyPrefix}/${projectId}/${sessionId}/${year}/${month}/${day}/${Date.parse(timestamp)}_${triggerEvent}.json`;
    
    return this.compressionEnabled ? `${baseKey}.gz` : baseKey;
  }

  /**
   * Stream-based upload with optional compression
   */
  async streamUpload(snapshot, key, options = {}) {
    const snapshotData = JSON.stringify(snapshot, null, 2);
    
    // Create readable stream from JSON data
    const sourceStream = Readable.from([snapshotData]);
    
    let uploadStream = sourceStream;
    let contentType = 'application/json';
    let contentEncoding = undefined;

    // Apply gzip compression if enabled
    if (this.compressionEnabled) {
      uploadStream = sourceStream.pipe(zlib.createGzip({
        level: zlib.constants.Z_BEST_COMPRESSION,
        memLevel: 8 // Memory optimization
      }));
      contentEncoding = 'gzip';
    }

    // Use AWS SDK v3 Upload for multipart handling
    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: uploadStream,
        ContentType: contentType,
        ContentEncoding: contentEncoding,
        Metadata: {
          sessionId: snapshot.sessionId,
          projectId: snapshot.projectId,
          triggerEvent: snapshot.triggerEvent,
          timestamp: snapshot.timestamp,
          region: snapshot.source.split('-').pop() || 'unknown',
          version: String(snapshot.metadata?.version || 1)
        },
        // Server-side encryption
        ServerSideEncryption: 'AES256'
      },
      // Memory optimization: smaller part size
      partSize: 5 * 1024 * 1024, // 5MB parts
      queueSize: 2 // Limit concurrent uploads
    });

    // Handle upload progress (optional)
    upload.on('httpUploadProgress', (progress) => {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      if (percent % 25 === 0) { // Log every 25%
        this.log('Upload progress', {
          sessionId: snapshot.sessionId,
          percent,
          loadedMB: Math.round(progress.loaded / 1024 / 1024 * 100) / 100,
          totalMB: Math.round(progress.total / 1024 / 1024 * 100) / 100
        });
      }
    });

    return await upload.done();
  }

  /**
   * Check if snapshot already exists in S3
   */
  async snapshotExists(snapshot, options = {}) {
    try {
      const key = this.generateS3Key(snapshot, options);
      
      await this.s3Client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key
      }));
      
      return true;
    } catch (error) {
      if (error.name === 'NotFound' || error.code === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Batch upload multiple snapshots
   */
  async uploadBatch(snapshots, options = {}) {
    const results = [];
    const concurrency = options.concurrency || 3; // Limit concurrent uploads

    for (let i = 0; i < snapshots.length; i += concurrency) {
      const batch = snapshots.slice(i, i + concurrency);
      
      const batchPromises = batch.map(async (snapshot) => {
        try {
          // Check if already exists (optional)
          if (options.skipExisting && await this.snapshotExists(snapshot)) {
            return {
              sessionId: snapshot.sessionId,
              skipped: true,
              reason: 'already_exists'
            };
          }
          
          return await this.uploadSnapshot(snapshot, options);
        } catch (error) {
          return {
            sessionId: snapshot.sessionId,
            success: false,
            error: error.message
          };
        }
      });

      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults.map(result => result.value || result.reason));
    }

    this.log('Batch upload completed', {
      total: snapshots.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success && !r.skipped).length,
      skipped: results.filter(r => r.skipped).length
    });

    return results;
  }

  /**
   * Get upload statistics
   */
  getUploadStats() {
    return {
      region: this.region,
      bucket: this.bucket,
      compression: this.compressionEnabled,
      retryAttempts: this.retryAttempts,
      timestamp: Date.now()
    };
  }

  /**
   * Test S3 connectivity and permissions
   */
  async testConnection() {
    try {
      // Try to head the bucket
      await this.s3Client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: 'test-connectivity-probe'
      }));
      
      return { connected: true, bucket: this.bucket, region: this.region };
    } catch (error) {
      // Expected for test probe, but confirms S3 access
      if (error.name === 'NotFound') {
        return { connected: true, bucket: this.bucket, region: this.region };
      }
      
      this.log('S3 connection test failed', {
        error: error.message,
        code: error.code
      });
      
      return { 
        connected: false, 
        error: error.message,
        bucket: this.bucket, 
        region: this.region 
      };
    }
  }

  /**
   * Clean up resources
   */
  async destroy() {
    if (this.s3Client) {
      await this.s3Client.destroy();
      this.log('S3 client destroyed');
    }
  }
}

module.exports = S3SnapshotUploader;