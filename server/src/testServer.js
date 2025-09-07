const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const SimpleStateSync = require('./services/simpleStateSync');
const SessionSnapshotWriter = require('./services/sessionSnapshotWriter');
const LLMGatewayService = require('./services/llmGatewayService');
const LLMCollaborationService = require('./services/llmCollaborationService');
const WebUICollaborationService = require('./services/webUICollaborationService');
const MetricsService = require('./services/metricsService');
const S3SnapshotUploader = require('./services/s3SnapshotUploader');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const port = process.env.PORT || 8080;

// Set timezone to JST
process.env.TZ = 'Asia/Tokyo';

// Enable JSON parsing
app.use(express.json());

// Initialize state sync service
const stateSync = new SimpleStateSync();

// Initialize session snapshot writer
const snapshotWriter = new SessionSnapshotWriter(stateSync, {
  projectRoot: '/ai/prj/claude-code-webui',
  debounceDelay: 3000,
  maxOutputSize: 1024 * 1024, // 1MB
  enableS3Upload: true,
  s3Bucket: 'claude-code-snapshots-dev',
  s3Region: 'us-east-1',
  s3KeyPrefix: 'sessions'
});

// Initialize LLM Gateway Service
const llmGateway = new LLMGatewayService({
  snapshotDir: '/tmp/claude-snapshots',
  cacheDir: '/tmp/claude-snapshot-index',
  ragStorageDir: '/tmp/claude-rag-storage',
  maxCacheSize: 50,
  ragMaxCacheSize: 20,
  ragBatchSize: 5,
  maxContextLength: 8000,
  defaultMaxReferences: 5
});

// Initialize LLM Collaboration Service (複数LLM協調動作)
const llmCollaboration = new LLMCollaborationService({
  llmGateway: llmGateway,
  minWallBounces: 3,
  maxWallBounces: 5
});

// Initialize WebUI Collaboration Service (Cipher MCP記憶永続化機能付き)
const webUICollaboration = new WebUICollaborationService({
  llmGateway: llmGateway,
  maxSessionHistory: 50,
  contextWindow: 10000,
  retentionDays: 30,
  // Cipher MCP Configuration
  cipherHost: process.env.CIPHER_MCP_HOST || 'localhost',
  cipherPort: parseInt(process.env.CIPHER_MCP_PORT || '3001'),
  cipherTimeout: parseInt(process.env.CIPHER_MCP_TIMEOUT || '5000'),
  cipherEnabled: process.env.CIPHER_MCP_ENABLED === 'true'
});

// Initialize Metrics Service
const metricsService = new MetricsService(io);

// Initialize S3 Snapshot Uploader
const s3Uploader = new S3SnapshotUploader({
  region: 'us-east-1',
  bucket: 'claude-code-snapshots-dev',
  keyPrefix: 'sessions',
  compression: true,
  retryAttempts: 3
});

// Simple logging
const log = (message, data = {}) => {
  console.log(`[${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
};

// Serve metrics dashboard
app.get('/metrics/test-metrics.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../../test-metrics.html'));
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    region: 'us-east-1',
    instanceType: 'c8gd.medium',
    memory: process.memoryUsage()
  });
});

// Process endpoint for receiving tasks
app.post('/process', (req, res) => {
  const startTime = Date.now();
  
  try {
    const task = req.body;
    
    log('Processing received task', {
      type: task.type,
      requestId: task.requestId,
      fromIP: req.ip
    });

    let result;
    
    switch (task.type) {
      case 'memory-test':
        const size = task.data.size || 100;
        const buffer = Buffer.alloc(size * 1024 * 1024); // Allocate specified MB
        buffer.fill('test');
        
        result = {
          message: `Processed ${size}MB memory test on main VM`,
          originalMessage: task.data.message,
          processedAt: new Date().toISOString(),
          region: 'us-east-1'
        };
        break;
        
      case 'computation-test':
        const iterations = task.data.iterations || 1000000;
        let sum = 0;
        for (let i = 0; i < iterations; i++) {
          sum += Math.random();
        }
        
        result = {
          message: `Completed ${iterations} iterations on main VM`,
          result: sum,
          processedAt: new Date().toISOString(),
          region: 'us-east-1'
        };
        break;
        
      case 'ping-test':
        result = {
          message: 'Pong from main VM!',
          originalData: task.data,
          processedAt: new Date().toISOString(),
          region: 'us-east-1'
        };
        break;
        
      default:
        result = {
          message: `Unknown task type: ${task.type} processed on main VM`,
          receivedData: task.data,
          processedAt: new Date().toISOString(),
          region: 'us-east-1'
        };
    }

    const response = {
      success: true,
      result,
      processingTime: Date.now() - startTime,
      memoryUsage: process.memoryUsage(),
      region: 'us-east-1'
    };

    log('Task processed successfully', {
      requestId: task.requestId,
      processingTime: response.processingTime,
      memoryMB: Math.round(response.memoryUsage.rss / 1024 / 1024)
    });

    res.json(response);
    
  } catch (error) {
    log('Task processing failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
      processingTime: Date.now() - startTime,
      memoryUsage: process.memoryUsage(),
      region: 'us-east-1'
    });
  }
});

// State management endpoints
app.post('/state/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const stateData = req.body;
    
    const result = await stateSync.saveState(sessionId, stateData);
    res.json({
      success: true,
      result,
      message: `State saved for session ${sessionId}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code
    });
  }
});

app.get('/state/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const state = await stateSync.getState(sessionId);
    
    if (!state) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found`
      });
    }
    
    res.json({
      success: true,
      state,
      message: `State retrieved for session ${sessionId}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.put('/state/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { data, expectedVersion } = req.body;
    
    const result = await stateSync.updateState(sessionId, data, expectedVersion);
    res.json({
      success: true,
      result,
      message: `State updated for session ${sessionId}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
      currentVersion: error.currentVersion,
      expectedVersion: error.expectedVersion
    });
  }
});

app.get('/state', async (req, res) => {
  try {
    const sessions = await stateSync.listSessions();
    const stats = stateSync.getSyncStats();
    const liveState = stateSync.getLiveState();
    
    res.json({
      success: true,
      sessions,
      stats,
      liveState,
      message: 'State sync statistics'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Cross-region state sync endpoint
app.post('/state/sync/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { remoteUrl } = req.body;
    
    // Get local state
    const localState = await stateSync.getState(sessionId);
    if (!localState) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found locally`
      });
    }

    // Attempt to sync with remote region
    const syncResult = await stateSync.syncWithRemoteRegion(remoteUrl, sessionId);
    
    res.json({
      success: true,
      localState,
      syncResult,
      message: `Cross-region sync attempted for ${sessionId}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Receive state from remote region
app.post('/state/receive/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const remoteState = req.body;
    
    log('Receiving state from remote region', {
      sessionId,
      remoteRegion: remoteState.region,
      remoteVersion: remoteState.version
    });

    // Get local state to check version
    const localState = await stateSync.getState(sessionId);
    
    if (!localState || remoteState.timestamp > localState.timestamp) {
      // Remote state is newer, update local
      const result = await stateSync.saveState(sessionId, remoteState.data, {
        version: remoteState.version,
        syncedFrom: remoteState.region,
        originalTimestamp: remoteState.timestamp
      });
      
      res.json({
        success: true,
        action: 'updated',
        result,
        message: `Local state updated from ${remoteState.region}`
      });
    } else {
      // Local state is newer or same, send back local
      res.json({
        success: true,
        action: 'local_newer',
        localState,
        message: 'Local state is newer, no update needed'
      });
    }
  } catch (error) {
    log('Failed to receive remote state', { sessionId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Tokyo VM test endpoint
app.post('/tokyo/test', async (req, res) => {
  try {
    const testTask = {
      type: 'ping-test',
      data: {
        message: 'Hello from main VM!',
        testSize: req.body.size || 10
      },
      timestamp: Date.now(),
      requestId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    log('Testing Tokyo VM connectivity', { requestId: testTask.requestId });

    // Try to send to Tokyo VM
    const fetch = require('node-fetch');
    const response = await fetch('http://54.65.178.168:3001/process', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testTask),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`Tokyo VM responded with ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    
    log('Tokyo VM test completed', {
      requestId: testTask.requestId,
      success: result.success,
      latency: result.processingTime
    });

    res.json({
      testTask,
      tokyoResponse: result,
      mainVMMemory: process.memoryUsage()
    });

  } catch (error) {
    log('Tokyo VM test failed', { error: error.message });
    res.status(500).json({
      error: 'Tokyo VM test failed',
      details: error.message,
      mainVMMemory: process.memoryUsage()
    });
  }
});

// Memory monitoring function
const monitorMemory = () => {
  const usage = process.memoryUsage();
  const rssUsageMB = Math.round(usage.rss / 1024 / 1024);
  
  log('Memory Monitor', {
    rss: `${rssUsageMB}MB`,
    heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
    external: `${Math.round(usage.external / 1024 / 1024)}MB`,
    freeMemory: `${Math.round(require('os').freemem() / 1024 / 1024)}MB`,
    totalMemory: `${Math.round(require('os').totalmem() / 1024 / 1024)}MB`
  });

  // Alert if memory usage is high (>1.4GB for 1.8GB system)
  if (rssUsageMB > 1400) {
    log('⚠️  HIGH MEMORY WARNING', {
      currentUsage: `${rssUsageMB}MB`,
      limit: '1800MB',
      recommendation: 'Consider offloading to Tokyo VM'
    });
  }
  
  return usage;
};

// Session Snapshot test endpoint
app.post('/snapshot/test/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { command, stdout, stderr, exitCode } = req.body;

    log('Testing session snapshot creation', { sessionId, command });

    // Simulate command execution result
    const commandResult = {
      stdout: stdout || 'Test command executed successfully',
      stderr: stderr || '',
      exitCode: exitCode || 0,
      cwd: '/ai/prj/claude-code-webui',
      duration: 150
    };

    // Register command execution to trigger snapshot
    snapshotWriter.registerCommandExecution(sessionId, command || 'npm test', commandResult);

    res.json({
      success: true,
      message: `Session snapshot test initiated for ${sessionId}`,
      command: command || 'npm test',
      result: commandResult
    });
  } catch (error) {
    log('Session snapshot test failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// LLM Gateway API endpoints

// Process query with session context
app.post('/llm/query/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { query, contextType, maxReferences, format } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    log('Processing LLM query', { sessionId, queryLength: query.length });

    const result = await llmGateway.processQuery(query, {
      sessionId,
      contextType: contextType || 'recent',
      maxReferences: maxReferences || 5,
      format: format || 'detailed'
    });

    res.json(result);
  } catch (error) {
    log('LLM query processing failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get debugging context for error analysis
app.get('/llm/debug/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { errorQuery } = req.query;

    log('Building debug context', { sessionId });

    const debugContext = await llmGateway.getDebugContext(sessionId, errorQuery || '');
    
    if (!debugContext) {
      return res.status(404).json({
        success: false,
        error: `Debug context not found for session ${sessionId}`
      });
    }

    res.json({
      success: true,
      debugContext,
      message: `Debug context built for session ${sessionId}`
    });
  } catch (error) {
    log('Debug context building failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Search snapshots with criteria
app.post('/llm/search', async (req, res) => {
  try {
    const { criteria } = req.body;

    log('Searching snapshots', criteria);

    const snapshots = await llmGateway.snapshotRetriever.searchSnapshots(criteria);

    res.json({
      success: true,
      results: snapshots.map(s => ({
        sessionId: s.sessionId,
        timestamp: s.timestamp,
        triggerEvent: s.triggerEvent,
        command: s.context?.execution?.command,
        exitCode: s.context?.execution?.exitCode,
        lastChangedFile: s.context?.fileSystem?.lastChangedFile
      })),
      count: snapshots.length,
      message: `Found ${snapshots.length} matching snapshots`
    });
  } catch (error) {
    log('Snapshot search failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get gateway statistics  
app.get('/llm/stats', (req, res) => {
  try {
    const stats = llmGateway.getStats();
    
    res.json({
      success: true,
      stats,
      message: 'LLM Gateway statistics'
    });
  } catch (error) {
    log('Failed to get gateway stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// RAG Storage API endpoints

// Add document to RAG storage
app.post('/rag/documents', async (req, res) => {
  try {
    const { filename, content } = req.body;

    if (!filename || !content) {
      return res.status(400).json({
        success: false,
        error: 'filename and content are required'
      });
    }

    log('Adding document to RAG storage', { filename, contentLength: content.length });

    const result = await llmGateway.ragStorage.addDocument(filename, content);

    res.json({
      success: true,
      result,
      message: `Document ${filename} added to RAG storage`
    });
  } catch (error) {
    log('Failed to add RAG document', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Search RAG storage directly
app.post('/rag/search', async (req, res) => {
  try {
    const { query, topK } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'query is required'
      });
    }

    log('Searching RAG storage', { query, topK: topK || 3 });

    const results = await llmGateway.ragStorage.search(query, topK || 3);

    res.json({
      success: true,
      query,
      results,
      count: results.length,
      message: `Found ${results.length} relevant documents`
    });
  } catch (error) {
    log('RAG search failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get RAG storage statistics
app.get('/rag/stats', (req, res) => {
  try {
    const stats = llmGateway.ragStorage.getStats();
    
    res.json({
      success: true,
      stats,
      message: 'RAG storage statistics'
    });
  } catch (error) {
    log('Failed to get RAG stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Import documents from S3 to RAG storage
app.post('/rag/import-s3', async (req, res) => {
  try {
    const { bucket = 'claude-code-snapshots-dev', prefix = 'aws-documentation/', pattern } = req.body;
    
    log('Importing S3 documents to RAG storage', { bucket, prefix, pattern });

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
    
    // Process each object
    for (const obj of filteredObjects.slice(0, 5)) { // Limit to first 5 for testing
      try {
        // Skip directories and non-text files
        if (obj.Key.endsWith('/') || obj.Size === 0) {
          skippedCount++;
          continue;
        }
        
        // For PDF files, we'll create a text summary for now
        if (obj.Key.endsWith('.pdf')) {
          const filename = obj.Key.split('/').pop();
          const textContent = `# ${filename}\n\nThis is a PDF document from AWS documentation. The file contains detailed technical information about AWS services.\n\nSource: s3://${bucket}/${obj.Key}\nSize: ${Math.round(obj.Size / 1024 / 1024 * 100) / 100} MB\nLast Modified: ${obj.LastModified}\n\n## PDF Content Summary\n\nThis document contains AWS API reference material, user guides, and technical specifications. The content includes service descriptions, API endpoints, configuration examples, and best practices for AWS services.\n\n## Keywords\n\nAWS, cloud computing, infrastructure, API, documentation, services, configuration, deployment, management, security`;
          
          await llmGateway.ragStorage.addDocument(`s3-${filename}.md`, textContent);
          importedCount++;
          
          log('Imported PDF summary', { filename, size: obj.Size });
        }
        // For text files, get actual content
        else if (obj.Key.endsWith('.md') || obj.Key.endsWith('.txt') || obj.Key.endsWith('.json')) {
          const getParams = {
            Bucket: bucket,
            Key: obj.Key
          };
          
          const data = await s3.send(new GetObjectCommand(getParams));
          const content = await data.Body.transformToString('utf-8');
          const filename = obj.Key.split('/').pop();
          
          await llmGateway.ragStorage.addDocument(filename, content);
          importedCount++;
          
          log('Imported text file', { filename, size: content.length });
        }
        else {
          skippedCount++;
        }
      } catch (objError) {
        log('Error importing object', { key: obj.Key, error: objError.message });
        errorCount++;
      }
    }
    
    res.json({
      success: true,
      summary: {
        totalObjects: objects.Contents.length,
        filteredObjects: filteredObjects.length,
        imported: importedCount,
        skipped: skippedCount,
        errors: errorCount
      },
      message: `Successfully imported ${importedCount} documents from S3 to RAG storage`
    });
    
  } catch (error) {
    log('Error importing S3 documents', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to import documents from S3'
    });
  }
});

// Test RAG-enhanced LLM query
app.post('/rag/query/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { query, contextType, maxReferences, format } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    log('Processing RAG-enhanced LLM query', { sessionId, queryLength: query.length });

    // This will now use both session snapshots AND RAG storage
    const result = await llmGateway.processQuery(query, {
      sessionId,
      contextType: contextType || 'recent',
      maxReferences: maxReferences || 6, // Allow more refs to show both sources
      format: format || 'detailed'
    });

    res.json(result);
  } catch (error) {
    log('RAG-enhanced query processing failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Refresh RAG index
app.post('/rag/refresh', async (req, res) => {
  try {
    log('Refreshing RAG storage index');
    
    await llmGateway.ragStorage.refresh();
    
    const stats = llmGateway.ragStorage.getStats();
    
    res.json({
      success: true,
      stats,
      message: 'RAG storage index refreshed'
    });
  } catch (error) {
    log('Failed to refresh RAG index', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// S3 Snapshot Sync API endpoints

// Upload session snapshot to S3
app.post('/s3/upload', async (req, res) => {
  try {
    const { sessionId, projectId, snapshot } = req.body;

    if (!sessionId || !snapshot) {
      return res.status(400).json({
        success: false,
        error: 'sessionId and snapshot are required'
      });
    }

    log('Uploading session snapshot to S3', { sessionId, projectId });

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

    const result = await s3Uploader.uploadSnapshot(snapshotData);

    res.json({
      success: true,
      result,
      message: `Snapshot uploaded to S3 for session ${sessionId}`
    });
  } catch (error) {
    log('Failed to upload snapshot to S3', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check if snapshot exists in S3
app.post('/s3/check', async (req, res) => {
  try {
    const { sessionId, projectId, timestamp, triggerEvent } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required'
      });
    }

    log('Checking if snapshot exists in S3', { sessionId, projectId });

    const snapshotData = {
      sessionId,
      projectId: projectId || 'claude-code-webui',
      timestamp: timestamp || new Date().toISOString(),
      triggerEvent: triggerEvent || 'manual_check'
    };

    const exists = await s3Uploader.snapshotExists(snapshotData);

    res.json({
      success: true,
      exists,
      sessionId,
      message: exists ? 'Snapshot exists in S3' : 'Snapshot not found in S3'
    });
  } catch (error) {
    log('Failed to check snapshot existence in S3', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Batch upload multiple snapshots
app.post('/s3/batch-upload', async (req, res) => {
  try {
    const { snapshots, options } = req.body;

    if (!snapshots || !Array.isArray(snapshots)) {
      return res.status(400).json({
        success: false,
        error: 'snapshots array is required'
      });
    }

    log('Starting batch upload to S3', { count: snapshots.length });

    const results = await s3Uploader.uploadBatch(snapshots, {
      concurrency: options?.concurrency || 3,
      skipExisting: options?.skipExisting || false
    });

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;

    res.json({
      success: true,
      results,
      summary: {
        total: snapshots.length,
        successful,
        failed,
        skipped
      },
      message: `Batch upload completed: ${successful} successful, ${failed} failed, ${skipped} skipped`
    });
  } catch (error) {
    log('Failed to batch upload snapshots', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test S3 connection
app.get('/s3/test', async (req, res) => {
  try {
    log('Testing S3 connection');
    
    const connectionTest = await s3Uploader.testConnection();
    
    res.json({
      success: true,
      connectionTest,
      stats: s3Uploader.getUploadStats(),
      message: connectionTest.connected ? 'S3 connection successful' : 'S3 connection failed'
    });
  } catch (error) {
    log('Failed to test S3 connection', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get S3 uploader statistics
app.get('/s3/stats', (req, res) => {
  try {
    const stats = s3Uploader.getUploadStats();
    
    res.json({
      success: true,
      stats,
      message: 'S3 uploader statistics'
    });
  } catch (error) {
    log('Failed to get S3 stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Memory endpoint for monitoring
app.get('/memory', (req, res) => {
  const memStats = monitorMemory();
  res.json({
    timestamp: new Date().toISOString(),
    region: 'us-east-1',
    memory: memStats,
    limits: {
      recommended: '1400MB',
      maximum: '1800MB'
    },
    os: {
      freeMem: `${Math.round(require('os').freemem() / 1024 / 1024)}MB`,
      totalMem: `${Math.round(require('os').totalmem() / 1024 / 1024)}MB`,
      loadAvg: require('os').loadavg()
    }
  });
});

// Start memory monitoring (every minute)
setInterval(monitorMemory, 60000);

// Start system stats broadcasting (every 5 minutes for background updates)
setInterval(() => {
  if (io && io.sockets && io.engine.clientsCount > 0) {
    metricsService.collectSystemStats();
    const systemStats = metricsService.metrics.systemStats;
    io.emit('metrics:system', systemStats);
  }
}, 300000); // 5 minutes

// Socket.IO event handlers for dashboard metrics
io.on('connection', async (socket) => {
  console.log('Client connected to metrics dashboard');
  
  // Send initial data on connection
  try {
    // Send existing metrics data
    const existingMetrics = await metricsService.getMetrics();
    if (existingMetrics.daily) {
      socket.emit('metrics:daily_update', existingMetrics.daily);
    }
    if (existingMetrics.llmModels) {
      Object.entries(existingMetrics.llmModels).forEach(([model, data]) => {
        socket.emit('metrics:llm_health', { model, ...data });
      });
    }
    if (existingMetrics.rag) {
      socket.emit('metrics:rag_update', existingMetrics.rag);
    }
    
    // Send system stats immediately
    metricsService.handleSystemStatsRequest(socket);
    
    console.log('Initial metrics data sent to client');
  } catch (error) {
    console.error('Failed to send initial metrics:', error);
  }
  
  // Handle system stats requests
  socket.on('metrics:request_system', () => {
    metricsService.handleSystemStatsRequest(socket);
  });
  
  // Simulate LLM request for testing
  socket.on('test:simulate_llm', async (data) => {
    await metricsService.recordLLMRequest(data.sessionId || 'test-session', {
      model: data.model || 'claude-4',
      tokens: data.tokens || 1024,
      cost: data.cost || 0.003,
      latency: data.latency || 1500,
      success: data.success !== false
    });
  });
  
  // Simulate RAG search for testing
  socket.on('test:simulate_rag', async (data) => {
    await metricsService.recordRAGSearch(data.sessionId || 'test-session', {
      query: data.query || 'test query',
      results: data.results || [{id: 1, title: 'Test Document'}],
      processingTime: data.processingTime || 200
    });
  });
  
  // LLM Query endpoint
  socket.on('llm:query', async (data) => {
    const { query, model = 'claude-4', sessionId = 'default-session' } = data;
    
    console.log('LLM query received:', { model, sessionId, queryLength: query.length });
    
    try {
      // Use LLM Gateway Service to process query
      const result = await llmGateway.queryLLM(model, query, { sessionId });
      
      // Record metrics
      await metricsService.recordLLMRequest(sessionId, {
        model: result.model,
        tokens: result.tokens,
        cost: result.cost,
        latency: result.latency,
        success: result.success
      });
      
      // Send response back to client
      socket.emit('llm:response', {
        id: data.id, // For request/response matching
        success: result.success,
        response: result.response,
        model: result.model,
        latency: result.latency,
        tokens: result.tokens,
        cost: result.cost,
        contextReferences: result.context?.references || 0
      });
      
    } catch (error) {
      socket.emit('llm:response', {
        id: data.id,
        success: false,
        error: error.message,
        model
      });
    }
  });

  // WebUI LLM Collaboration Events（記憶継続保持機能付き）
  socket.on('llm:start_collaboration', async (data) => {
    try {
      const { query, taskType = 'general', models, sessionId, userId = 'webui-user' } = data;
      
      log('WebUI collaboration started', { 
        userId, sessionId, taskType, 
        queryLength: query.length, 
        models 
      });

      const result = await webUICollaboration.processWebUICollaboration({
        query,
        taskType,
        models,
        sessionId,
        userId,
        useMemory: true
      });

      socket.emit('llm:collaboration_complete', result);
      
      // メトリクス記録
      await metricsService.recordLLMComplete(sessionId, {
        model: 'collaboration-' + models.join(','),
        tokens: result.finalResponse.length / 4, // 概算
        cost: 0.001 * models.length, // 概算
        latency: result.metadata.processingTime || 5000,
        success: result.success
      });

    } catch (error) {
      log('WebUI collaboration error', { 
        error: error.message, 
        sessionId: data.sessionId 
      });
      socket.emit('llm:collaboration_error', { 
        error: error.message,
        sessionId: data.sessionId 
      });
    }
  });

  // ユーザーの協調動作履歴を取得
  socket.on('llm:get_user_history', async (data) => {
    try {
      const { userId = 'webui-user', limit = 10 } = data;
      
      const history = await webUICollaboration.getUserCollaborationHistory(userId, limit);
      socket.emit('llm:user_history', history);
      
    } catch (error) {
      log('Get user history error', { error: error.message });
      socket.emit('llm:user_history_error', { error: error.message });
    }
  });

  // ユーザーコンテキストのリセット
  socket.on('llm:reset_user_context', async (data) => {
    try {
      const { userId = 'webui-user' } = data;
      
      const success = await webUICollaboration.resetUserContext(userId);
      socket.emit('llm:context_reset', { success, userId });
      
    } catch (error) {
      log('Reset user context error', { error: error.message });
      socket.emit('llm:context_reset_error', { error: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected from metrics dashboard');
  });
});

// LLM Query HTTP endpoint
app.post('/llm/query', async (req, res) => {
  try {
    const { query, model = 'claude-4', sessionId = 'http-session' } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    console.log('HTTP LLM query:', { model, sessionId, queryLength: query.length });
    
    const result = await llmGateway.queryLLM(model, query, { sessionId });
    
    // Record metrics
    await metricsService.recordLLMRequest(sessionId, {
      model: result.model,
      tokens: result.tokens,
      cost: result.cost,
      latency: result.latency,
      success: result.success
    });
    
    res.json(result);
    
  } catch (error) {
    console.error('LLM query error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// RAG Search endpoint
app.post('/rag/search', async (req, res) => {
  try {
    const { query, topK = 5, sessionId = 'rag-session' } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    console.log('RAG search query:', { sessionId, queryLength: query.length, topK });
    
    const startTime = Date.now();
    const results = await ragStorage.search(query, topK);
    const processingTime = Date.now() - startTime;
    
    // Record RAG metrics
    try {
      console.log('Recording RAG metrics:', { sessionId, resultsCount: results.length, processingTime });
      await metricsService.recordRAGSearch(sessionId, {
        query,
        results,
        processingTime,
        hasResults: results.length > 0
      });
      console.log('RAG metrics recorded successfully');
    } catch (error) {
      console.error('Failed to record RAG metrics:', error.message);
      // Continue without failing the request
    }
    
    res.json({
      success: true,
      query,
      results,
      resultCount: results.length,
      processingTime: `${processingTime}ms`,
      sessionId
    });
    
  } catch (error) {
    console.error('RAG search error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 複数LLM協調動作エンドポイント (CLAUDE.mdに従った壁打ち機能)
app.post('/llm/collaboration/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const { 
      query, 
      taskType = 'general',
      models = ['gpt-5', 'claude-4', 'gemini-2.5-pro']
    } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    console.log(`[${new Date().toISOString()}] Processing collaborative query`, {
      sessionId,
      queryLength: query.length,
      taskType,
      models
    });

    const startTime = Date.now();
    
    // 複数LLM協調動作を実行
    const result = await llmCollaboration.processCollaborativeQuery(query, {
      sessionId,
      taskType,
      models
    });
    
    const processingTime = Date.now() - startTime;
    result.metadata.processingTime = processingTime;

    console.log(`[${new Date().toISOString()}] Collaborative query completed`, {
      sessionId,
      wallBounceCount: result.wallBounceCount,
      modelsUsed: result.metadata.modelsUsed,
      processingTime: `${processingTime}ms`
    });

    res.json(result);
    
  } catch (error) {
    console.error('Collaborative query error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      sessionId: req.params.sessionId
    });
  }
});

// Start server
server.listen(port, () => {
  log('Test server started', {
    port,
    region: 'us-east-1',
    nodeVersion: process.version,
    memory: process.memoryUsage(),
    swapOptimizations: {
      swappiness: require('fs').readFileSync('/proc/sys/vm/swappiness', 'utf8').trim(),
      vfsCachePressure: require('fs').readFileSync('/proc/sys/vm/vfs_cache_pressure', 'utf8').trim()
    }
  });
  
  console.log(`
╭─────────────────────────────────────────────────╮
│                                                 │
│   🧪 Phase 0 Test Server                       │
│                                                 │
│   📍 Port: ${port}                                  │
│   🌍 Region: us-east-1 (Main VM)               │
│   💾 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB                              │
│                                                 │
│   Endpoints:                                    │
│   GET  /health                                  │
│   POST /process                                 │
│   POST /tokyo/test                              │
│                                                 │
╰─────────────────────────────────────────────────╯
  `);
});

module.exports = app;