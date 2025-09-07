/**
 * Server Configuration Manager
 * Handles server setup, initialization, and configuration
 * Separated from testServer.js to follow single responsibility principle
 */

const fs = require('fs');
const path = require('path');

class ServerConfiguration {
  constructor(options = {}) {
    this.port = options.port || process.env.PORT || 8080;
    this.region = options.region || 'us-east-1';
    this.instanceType = options.instanceType || 'c8gd.medium';
    this.environment = options.environment || process.env.NODE_ENV || 'development';
    this.mockLLM = options.mockLLM || process.env.MOCK_LLM === 'true';
  }

  /**
   * Configure server settings and middleware
   */
  configureServer(app) {
    // Set timezone to JST
    process.env.TZ = 'Asia/Tokyo';
    
    // Enable JSON parsing
    app.use(require('express').json());
    
    // Setup CORS if needed
    if (this.environment === 'development') {
      app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        next();
      });
    }
    
    this.log('Server configured', {
      port: this.port,
      region: this.region,
      instanceType: this.instanceType,
      environment: this.environment,
      mockLLM: this.mockLLM
    });
  }

  /**
   * Initialize services with configuration
   */
  createServices(io = null) {
    const SimpleStateSync = require('../services/simpleStateSync');
    const SessionSnapshotWriter = require('../services/sessionSnapshotWriter');
    const LLMGatewayService = require('../services/llmGatewayService');
    const LLMCollaborationService = require('../services/llmCollaborationService');
    const WebUICollaborationService = require('../services/webUICollaborationService');
    const MetricsService = require('../services/metricsService');
    const S3SnapshotUploader = require('../services/s3SnapshotUploader');

    // Initialize state sync service
    const stateSync = new SimpleStateSync();

    // Initialize session snapshot writer
    const snapshotWriter = new SessionSnapshotWriter(stateSync, {
      projectRoot: '/ai/prj/claude-code-webui',
      debounceDelay: 3000,
      maxOutputSize: 1024 * 1024, // 1MB
      enableS3Upload: true,
      s3Bucket: 'claude-code-snapshots-dev',
      s3Region: this.region,
      s3KeyPrefix: 'sessions'
    });

    // Initialize LLM Gateway Service
    const llmGateway = new LLMGatewayService({
      snapshotDir: '/tmp/claude-snapshots',
      cacheDir: '/tmp/claude-snapshot-index',
      ragStorageDir: '/tmp/claude-rag-storage',
      maxCacheSize: 50,
      maxContextLength: 8000,
      defaultMaxReferences: 5
    });

    // Initialize LLM Collaboration Service
    const llmCollaboration = new LLMCollaborationService({
      llmGateway,
      minWallBounces: 3,
      maxWallBounces: 5,
      defaultModels: ['gpt-5', 'claude-4', 'gemini-2.5-pro']
    });

    // Initialize WebUI Collaboration Service
    const webUICollaboration = new WebUICollaborationService({
      llmGateway,
      stateSync,
      maxCollaborationDepth: 3
    });

    // Initialize metrics service
    const metricsService = new MetricsService({
      dataFile: path.resolve(__dirname, '../../data/metrics.json'),
      region: this.region,
      io: io // Pass Socket.IO instance
    });

    // Initialize S3 uploader
    const s3Uploader = new S3SnapshotUploader({
      bucket: 'claude-code-snapshots-dev',
      region: this.region,
      keyPrefix: 'test-sessions'
    });

    return {
      stateSync,
      snapshotWriter,
      llmGateway,
      llmCollaboration,
      webUICollaboration,
      metricsService,
      s3Uploader
    };
  }

  /**
   * Start memory monitoring
   */
  startMemoryMonitoring() {
    const monitorMemory = () => {
      const memUsage = process.memoryUsage();
      const memMB = Math.round(memUsage.rss / 1024 / 1024);
      
      if (memMB > 1400) {
        console.warn(`⚠️ Memory usage high: ${memMB}MB (recommended < 1400MB)`);
        if (global.gc) {
          console.log('🧹 Running garbage collection...');
          global.gc();
          const afterGC = Math.round(process.memoryUsage().rss / 1024 / 1024);
          console.log(`✅ Memory after GC: ${afterGC}MB`);
        }
      }
    };

    // Monitor memory every minute
    setInterval(monitorMemory, 60000);
    
    this.log('Memory monitoring started', {
      interval: '60 seconds',
      warningThreshold: '1400MB'
    });
  }

  /**
   * Get system information
   */
  getSystemInfo() {
    const memStats = process.memoryUsage();
    const os = require('os');
    
    return {
      server: {
        port: this.port,
        region: this.region,
        instanceType: this.instanceType,
        environment: this.environment,
        mockLLM: this.mockLLM,
        nodeVersion: process.version,
        uptime: process.uptime()
      },
      memory: {
        rss: `${Math.round(memStats.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memStats.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memStats.heapTotal / 1024 / 1024)}MB`,
        external: `${Math.round(memStats.external / 1024 / 1024)}MB`
      },
      system: {
        freeMem: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
        totalMem: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
        loadAvg: os.loadavg(),
        cpuCount: os.cpus().length,
        platform: os.platform(),
        arch: os.arch()
      },
      limits: {
        recommended: '1400MB',
        maximum: '1800MB'
      }
    };
  }

  /**
   * Get swap optimization settings
   */
  getSwapOptimizations() {
    try {
      return {
        swappiness: fs.readFileSync('/proc/sys/vm/swappiness', 'utf8').trim(),
        vfsCachePressure: fs.readFileSync('/proc/sys/vm/vfs_cache_pressure', 'utf8').trim()
      };
    } catch (error) {
      return {
        swappiness: 'unavailable',
        vfsCachePressure: 'unavailable'
      };
    }
  }

  /**
   * Display server startup banner
   */
  displayStartupBanner() {
    const sysInfo = this.getSystemInfo();
    
    console.log(`
╭─────────────────────────────────────────────────╮
│                                                 │
│   🧪 Claude Code WebUI Server                  │
│                                                 │
│   📍 Port: ${this.port}                                  │
│   🌍 Region: ${this.region} (${this.instanceType})               │
│   💾 Memory: ${sysInfo.memory.rss}                              │
│   🔧 Environment: ${this.environment}                       │
│   🤖 Mock LLM: ${this.mockLLM ? 'Enabled' : 'Disabled'}                        │
│                                                 │
│   Services:                                     │
│   ✅ State Sync                                │
│   ✅ LLM Gateway                               │
│   ✅ RAG Storage                               │
│   ✅ Metrics Collection                        │
│   ✅ WebSocket Handler                         │
│                                                 │
╰─────────────────────────────────────────────────╯
    `);
  }

  /**
   * Logging utility
   */
  log(message, data = {}) {
    console.log(`[${new Date().toISOString()}] [ServerConfig] ${message}`, data);
  }
}

module.exports = ServerConfiguration;