/**
 * RAG Controller
 * Handles RAG (Retrieval-Augmented Generation) document management and search endpoints
 */

const BaseController = require('./BaseController');
const appEventEmitter = require('../events/EventEmitter');

class RAGController extends BaseController {
  constructor(options = {}) {
    super(options);
    this.llmGateway = options.llmGateway;
    this.metricsService = options.metricsService;
    
    if (!this.llmGateway || !this.llmGateway.ragStorage) {
      throw new Error('LLM Gateway with RAG Storage is required for RAGController');
    }

    // Listen to RAG events from socket
    this.setupEventListeners();
  }

  /**
   * Setup event listeners for socket-driven RAG requests
   */
  setupEventListeners() {
    const { EVENTS } = appEventEmitter;

    // Handle RAG search from WebSocket
    appEventEmitter.onSafe(EVENTS.TEST_SIMULATE_RAG, async (data) => {
      await this.handleSocketRAGSearch(data);
    });

    this.log('RAG event listeners registered');
  }

  /**
   * Add document to RAG storage
   * POST /rag/documents
   */
  addDocument = this.asyncHandler(async (req, res) => {
    const { filename, content } = req.body;

    this.validateRequired(req, ['filename', 'content']);

    this.log('Adding document to RAG storage', { filename, contentLength: content.length });

    const result = await this.llmGateway.ragStorage.addDocument(filename, content);

    return this.successResponse(res, result, `Document ${filename} added to RAG storage`);
  });

  /**
   * Search RAG storage directly
   * POST /rag/search
   */
  searchRAG = this.asyncHandler(async (req, res) => {
    const { query, topK = 5, sessionId = 'rag-session' } = req.body;

    this.validateRequired(req, ['query']);

    this.log('Searching RAG storage', { query, topK, sessionId });

    const startTime = Date.now();
    const results = await this.llmGateway.ragStorage.search(query, topK);
    const processingTime = Date.now() - startTime;

    // Record RAG metrics if service available
    if (this.metricsService) {
      try {
        await this.metricsService.recordRAGSearch(sessionId, {
          query,
          results,
          processingTime,
          hasResults: results.length > 0
        });
        this.log('RAG metrics recorded successfully');
      } catch (error) {
        this.log('Failed to record RAG metrics', { error: error.message });
        // Continue without failing the request
      }
    }

    return this.successResponse(res, {
      query,
      results,
      resultCount: results.length,
      processingTime: `${processingTime}ms`,
      sessionId
    }, `Found ${results.length} relevant documents`);
  });

  /**
   * Get RAG storage statistics
   * GET /rag/stats
   */
  getStats = (req, res) => {
    try {
      const stats = this.llmGateway.ragStorage.getStats();
      return this.successResponse(res, stats, 'RAG storage statistics');
    } catch (error) {
      return this.errorResponse(res, error);
    }
  };

  /**
   * Import documents from S3 to RAG storage
   * POST /rag/import-s3
   */
  importFromS3 = this.asyncHandler(async (req, res) => {
    const { 
      bucket = 'claude-code-snapshots-dev', 
      prefix = 'aws-documentation/', 
      pattern,
      limit = 5 
    } = req.body;
    
    this.log('Importing S3 documents to RAG storage', { bucket, prefix, pattern, limit });

    const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: 'us-east-1' });
    
    // List objects in S3 bucket with prefix
    const listParams = {
      Bucket: bucket,
      Prefix: prefix
    };
    
    const objects = await s3.send(new ListObjectsV2Command(listParams));
    let importedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    // Filter objects by pattern if provided
    const filteredObjects = pattern 
      ? objects.Contents.filter(obj => obj.Key.includes(pattern))
      : objects.Contents;
    
    // Process each object (limit for performance)
    for (const obj of filteredObjects.slice(0, limit)) {
      try {
        // Skip directories and empty files
        if (obj.Key.endsWith('/') || obj.Size === 0) {
          skippedCount++;
          continue;
        }
        
        // Handle PDF files with metadata summary
        if (obj.Key.endsWith('.pdf')) {
          const filename = obj.Key.split('/').pop();
          const textContent = this.generatePDFSummary(filename, obj, bucket);
          
          await this.llmGateway.ragStorage.addDocument(`s3-${filename}.md`, textContent);
          importedCount++;
          
          this.log('Imported PDF summary', { filename, size: obj.Size });
        }
        // Handle text files with actual content
        else if (this.isTextFile(obj.Key)) {
          const getParams = {
            Bucket: bucket,
            Key: obj.Key
          };
          
          const data = await s3.send(new GetObjectCommand(getParams));
          const content = await data.Body.transformToString('utf-8');
          const filename = obj.Key.split('/').pop();
          
          await this.llmGateway.ragStorage.addDocument(filename, content);
          importedCount++;
          
          this.log('Imported text file', { filename, size: content.length });
        }
        else {
          skippedCount++;
        }
      } catch (objError) {
        this.log('Error importing object', { key: obj.Key, error: objError.message });
        errorCount++;
      }
    }
    
    const summary = {
      totalObjects: objects.Contents.length,
      filteredObjects: filteredObjects.length,
      imported: importedCount,
      skipped: skippedCount,
      errors: errorCount
    };

    return this.successResponse(res, { summary }, 
      `Successfully imported ${importedCount} documents from S3 to RAG storage`);
  });

  /**
   * RAG-enhanced LLM query
   * POST /rag/query/:sessionId
   */
  queryWithRAG = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { query, contextType, maxReferences, format } = req.body;

    this.validateRequired(req, ['query']);

    this.log('Processing RAG-enhanced LLM query', { sessionId, queryLength: query.length });

    // Use both session snapshots AND RAG storage
    const result = await this.llmGateway.processQuery(query, {
      sessionId,
      contextType: contextType || 'recent',
      maxReferences: maxReferences || 6, // Allow more refs to show both sources
      format: format || 'detailed'
    });

    return res.json(result);
  });

  /**
   * Refresh RAG index
   * POST /rag/refresh
   */
  refreshIndex = this.asyncHandler(async (req, res) => {
    this.log('Refreshing RAG storage index');
    
    await this.llmGateway.ragStorage.refresh();
    
    const stats = this.llmGateway.ragStorage.getStats();
    
    return this.successResponse(res, { stats }, 'RAG storage index refreshed');
  });

  /**
   * Handle RAG search from WebSocket
   */
  async handleSocketRAGSearch(data) {
    try {
      const { query, topK = 5, sessionId = 'socket-rag-session', socketId } = data;
      
      this.log('Socket RAG search received', { query, topK, sessionId });
      
      const startTime = Date.now();
      const results = await this.llmGateway.ragStorage.search(query, topK);
      const processingTime = Date.now() - startTime;
      
      // Record metrics if service available
      if (this.metricsService) {
        await this.metricsService.recordRAGSearch(sessionId, {
          query,
          results,
          processingTime,
          hasResults: results.length > 0
        });
      }
      
      // Emit response event
      appEventEmitter.emitSafe(appEventEmitter.EVENTS.METRICS_RAG_UPDATE, {
        success: true,
        query,
        results,
        resultCount: results.length,
        processingTime: `${processingTime}ms`,
        sessionId,
        socketId
      });
      
    } catch (error) {
      this.log('Socket RAG search failed', { error: error.message });
      
      appEventEmitter.emitSafe(appEventEmitter.EVENTS.METRICS_RAG_UPDATE, {
        success: false,
        error: error.message,
        sessionId: data.sessionId,
        socketId: data.socketId
      });
    }
  }

  /**
   * Helper: Check if file is a text file type
   */
  isTextFile(key) {
    const textExtensions = ['.md', '.txt', '.json', '.yml', '.yaml', '.xml', '.csv'];
    return textExtensions.some(ext => key.endsWith(ext));
  }

  /**
   * Helper: Generate PDF summary content for RAG storage
   */
  generatePDFSummary(filename, obj, bucket) {
    return `# ${filename}

This is a PDF document from AWS documentation. The file contains detailed technical information about AWS services.

Source: s3://${bucket}/${obj.Key}
Size: ${Math.round(obj.Size / 1024 / 1024 * 100) / 100} MB
Last Modified: ${obj.LastModified}

## PDF Content Summary

This document contains AWS API reference material, user guides, and technical specifications. The content includes service descriptions, API endpoints, configuration examples, and best practices for AWS services.

## Keywords

AWS, cloud computing, infrastructure, API, documentation, services, configuration, deployment, management, security`;
  }

  /**
   * Register routes for this controller
   */
  registerRoutes(app) {
    app.post('/rag/documents', this.addDocument);
    app.post('/rag/search', this.searchRAG);
    app.get('/rag/stats', this.getStats);
    app.post('/rag/import-s3', this.importFromS3);
    app.post('/rag/query/:sessionId', this.queryWithRAG);
    app.post('/rag/refresh', this.refreshIndex);
    
    this.log('RAG routes registered', {
      routes: [
        'POST /rag/documents',
        'POST /rag/search', 
        'GET /rag/stats',
        'POST /rag/import-s3',
        'POST /rag/query/:sessionId',
        'POST /rag/refresh'
      ]
    });
  }
}

module.exports = RAGController;