const express = require('express');
const SimpleStateSync = require('./services/simpleStateSync');
const SessionSnapshotWriter = require('./services/sessionSnapshotWriter');
const LLMGatewayService = require('./services/llmGatewayService');

const app = express();
const port = 3002;

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

// Simple logging
const log = (message, data = {}) => {
  console.log(`[${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
};

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

// Start server
app.listen(port, () => {
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