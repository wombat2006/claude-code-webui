/**
 * S3 Controller
 * Handles S3 snapshot sync operations for session data storage
 */

const BaseController = require('./BaseController');

class S3Controller extends BaseController {
  constructor(options = {}) {
    super(options);
    this.s3Uploader = options.s3Uploader;
    
    if (!this.s3Uploader) {
      throw new Error('S3 Uploader service is required for S3Controller');
    }
  }

  /**
   * Upload session snapshot to S3
   * POST /s3/upload
   */
  uploadSnapshot = this.asyncHandler(async (req, res) => {
    const { sessionId, projectId, snapshot } = req.body;

    this.validateRequired(req, ['sessionId', 'snapshot']);

    this.log('Uploading session snapshot to S3', { sessionId, projectId });

    const snapshotData = {
      sessionId,
      projectId: projectId || 'claude-code-webui',
      timestamp: new Date().toISOString(),
      triggerEvent: 'manual_upload',
      source: 'us-east-1-api',
      metadata: {
        version: 1,
        uploadedAt: new Date().toISOString()
      },
      content: snapshot
    };

    const result = await this.s3Uploader.uploadSnapshot(snapshotData);

    return this.successResponse(res, result, `Snapshot uploaded to S3 for session ${sessionId}`);
  });

  /**
   * Check if snapshot exists in S3
   * POST /s3/check
   */
  checkSnapshot = this.asyncHandler(async (req, res) => {
    const { sessionId, projectId, timestamp, triggerEvent } = req.body;

    this.validateRequired(req, ['sessionId']);

    this.log('Checking if snapshot exists in S3', { sessionId, projectId });

    const snapshotData = {
      sessionId,
      projectId: projectId || 'claude-code-webui',
      timestamp: timestamp || new Date().toISOString(),
      triggerEvent: triggerEvent || 'manual_check'
    };

    const exists = await this.s3Uploader.snapshotExists(snapshotData);

    return this.successResponse(res, {
      exists,
      sessionId
    }, exists ? 'Snapshot exists in S3' : 'Snapshot not found in S3');
  });

  /**
   * Batch upload multiple snapshots
   * POST /s3/batch-upload
   */
  batchUpload = this.asyncHandler(async (req, res) => {
    const { snapshots, options } = req.body;

    if (!snapshots || !Array.isArray(snapshots)) {
      return res.status(400).json({
        success: false,
        error: 'snapshots array is required'
      });
    }

    this.log('Starting batch upload to S3', { count: snapshots.length });

    const results = await this.s3Uploader.uploadBatch(snapshots, {
      concurrency: options?.concurrency || 3,
      skipExisting: options?.skipExisting || false
    });

    // Analyze results
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;

    const summary = {
      total: snapshots.length,
      successful,
      failed,
      skipped
    };

    return this.successResponse(res, {
      results,
      summary
    }, `Batch upload completed: ${successful} successful, ${failed} failed, ${skipped} skipped`);
  });

  /**
   * Test S3 connection
   * GET /s3/test
   */
  testConnection = this.asyncHandler(async (req, res) => {
    this.log('Testing S3 connection');
    
    const connectionTest = await this.s3Uploader.testConnection();
    
    return this.successResponse(res, {
      connectionTest,
      stats: this.s3Uploader.getUploadStats()
    }, connectionTest.connected ? 'S3 connection successful' : 'S3 connection failed');
  });

  /**
   * Get S3 uploader statistics
   * GET /s3/stats
   */
  getStats = (req, res) => {
    try {
      const stats = this.s3Uploader.getUploadStats();
      
      return this.successResponse(res, stats, 'S3 uploader statistics');
    } catch (error) {
      return this.errorResponse(res, error);
    }
  };

  /**
   * Register routes for this controller
   */
  registerRoutes(app) {
    app.post('/s3/upload', this.uploadSnapshot);
    app.post('/s3/check', this.checkSnapshot);
    app.post('/s3/batch-upload', this.batchUpload);
    app.get('/s3/test', this.testConnection);
    app.get('/s3/stats', this.getStats);
    
    this.log('S3 routes registered', {
      routes: [
        'POST /s3/upload',
        'POST /s3/check',
        'POST /s3/batch-upload',
        'GET /s3/test',
        'GET /s3/stats'
      ]
    });
  }
}

module.exports = S3Controller;