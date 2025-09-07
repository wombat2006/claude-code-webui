import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import { 
  ipWhitelist, 
  generalLimiter, 
  securityHeaders, 
  corsOptions, 
  auditRequest,
  validateContentType,
  limitRequestSize 
} from './middleware/security';
import { 
  loginLimiter, 
  validateLogin, 
  verifyToken, 
  login, 
  logout, 
  getCurrentUser 
} from './middleware/auth';
import { handleValidationErrors } from './middleware/security';
import { SocketService } from './services/socketService';
import { claudeCodeWrapper } from './services/claudeCodeWrapper';
import { AuthenticatedRequest, ServerConfig } from './types';
import logger from './config/logger';
import context7Routes from './routes/context7Routes';
import { taskDistribution, TaskRequest } from './services/basicTaskDistribution';

// Load environment variables
dotenv.config();

// Server configuration with proper typing
const config: ServerConfig = {
  port: parseInt(process.env.PORT || (process.env.NODE_ENV === 'production' ? '3001' : '3001')),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || '30'),
  claudeCodePath: process.env.CLAUDE_CODE_PATH || 'claude',
  claudeWorkingDir: process.env.CLAUDE_WORKING_DIR || '/tmp/claude-sessions',
  allowedIPs: process.env.ALLOWED_IPS ? process.env.ALLOWED_IPS.split(',') : undefined,
  sslCertPath: process.env.SSL_CERT_PATH,
  sslKeyPath: process.env.SSL_KEY_PATH,
  logLevel: process.env.LOG_LEVEL || 'info',
  logFile: process.env.LOG_FILE,
  maxSessions: parseInt(process.env.MAX_SESSIONS || '10'),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100')
};

// Validate critical configuration
if (config.jwtSecret === 'dev-secret-change-in-production' && process.env.NODE_ENV === 'production') {
  logger.error('Critical security error: JWT_SECRET must be set in production');
  process.exit(1);
}

// Create Express app
const app = express();

// Create HTTP server (SSL termination handled by nginx)
const httpServer = createServer(app);

// Log server type
logger.info(`Starting HTTP server on port ${config.port} (SSL handled by nginx in production)`);

// Trust proxy settings (important for rate limiting and IP detection)
app.set('trust proxy', 1);

// Security middleware (applied first)
app.use(securityHeaders);
app.use(ipWhitelist);
app.use(auditRequest);

// CORS middleware
app.use(cors(corsOptions));

// Body parsing middleware with size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request size validation
app.use(limitRequestSize(1024 * 1024)); // 1MB

// Rate limiting
app.use(generalLimiter);

// Health check endpoint (public)
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// Authentication routes
app.post('/auth/login', 
  loginLimiter,
  validateContentType('application/json'),
  validateLogin,
  handleValidationErrors,
  login
);

app.post('/auth/logout', 
  verifyToken,
  logout
);

app.get('/auth/me', 
  verifyToken,
  getCurrentUser
);

// API routes (all require authentication)
app.use('/api', verifyToken);

// Context7 routes
app.use('/api/context7', context7Routes);

// Server info endpoint
app.get('/api/server-info', (req: AuthenticatedRequest, res) => {
  const sessionStats = claudeCodeWrapper.getSessionStats();
  
  res.json({
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version,
      platform: process.platform,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV
    },
    user: {
      username: req.user?.username,
      role: req.user?.role
    },
    sessions: sessionStats,
    config: {
      maxSessions: config.maxSessions,
      sessionTimeout: config.sessionTimeout,
      claudeCodePath: config.claudeCodePath
    }
  });
});

// Claude Code session management endpoints
app.post('/api/session/create', async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const sessionId = await claudeCodeWrapper.createSession(req.user);
    await claudeCodeWrapper.startSession(sessionId);

    logger.audit('Session created via API', {
      sessionId,
      username: req.user.username,
      ip: req.ip
    });

    res.json({
      success: true,
      sessionId,
      message: 'Session created successfully'
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to create session', error as Error, {
      username: req.user?.username,
      ip: req.ip
    });
    
    res.status(500).json({
      error: 'Failed to create session',
      details: errorMessage
    });
  }
});

app.get('/api/session/stats', (req: AuthenticatedRequest, res) => {
  try {
    const stats = claudeCodeWrapper.getSessionStats();
    const activeSessions = claudeCodeWrapper.getActiveSessions();
    
    res.json({
      stats,
      activeSessions: activeSessions.length,
      maxSessions: config.maxSessions
    });
  } catch (error) {
    logger.error('Failed to get session stats', error as Error);
    res.status(500).json({ error: 'Failed to get session statistics' });
  }
});

// Health check for Claude Code wrapper
app.get('/api/claude/health', async (req, res) => {
  try {
    const health = await claudeCodeWrapper.healthCheck();
    res.json(health);
  } catch (error) {
    logger.error('Claude Code health check failed', error as Error);
    res.status(500).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Tokyo VM connectivity test endpoint
app.get('/api/tokyo/health', async (req: AuthenticatedRequest, res) => {
  try {
    const health = await taskDistribution.healthCheck();
    res.json({
      tokyoVM: health,
      timestamp: new Date().toISOString(),
      checkedBy: req.user?.username
    });
  } catch (error) {
    logger.error('Tokyo VM health check failed', error as Error);
    res.status(500).json({
      error: 'Tokyo VM health check failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Test task distribution endpoint
app.post('/api/tokyo/test', async (req: AuthenticatedRequest, res) => {
  try {
    const testTask: TaskRequest = {
      type: 'memory-test',
      data: {
        size: req.body.size || 100, // MB
        message: 'Hello from main VM!'
      },
      timestamp: Date.now(),
      requestId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    const result = await taskDistribution.sendToTokyo(testTask);
    
    logger.audit('Tokyo VM test completed', {
      username: req.user?.username,
      requestId: testTask.requestId,
      success: result.success,
      processingTime: result.processingTime
    });

    res.json({
      taskRequest: testTask,
      result,
      localMemory: process.memoryUsage()
    });
  } catch (error) {
    logger.error('Tokyo VM test failed', error as Error);
    res.status(500).json({
      error: 'Tokyo VM test failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Process endpoint (for receiving tasks from Tokyo VM or other nodes)
app.post('/process', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const task = req.body as TaskRequest;
    
    logger.info('Processing received task', {
      taskType: task.type,
      requestId: task.requestId,
      timestamp: task.timestamp?.toString()
    });

    // Simple task processing based on type
    let result: any;
    
    switch (task.type) {
      case 'memory-test':
        // Simulate memory-intensive task
        const size = task.data.size || 100;
        const buffer = Buffer.alloc(size * 1024 * 1024); // Allocate specified MB
        buffer.fill('test');
        
        result = {
          message: `Processed ${size}MB memory test`,
          originalMessage: task.data.message,
          processedAt: new Date().toISOString()
        };
        break;
        
      case 'computation-test':
        // Simulate CPU-intensive task
        const iterations = task.data.iterations || 1000000;
        let sum = 0;
        for (let i = 0; i < iterations; i++) {
          sum += Math.random();
        }
        
        result = {
          message: `Completed ${iterations} iterations`,
          result: sum,
          processedAt: new Date().toISOString()
        };
        break;
        
      default:
        result = {
          message: `Unknown task type: ${task.type}`,
          receivedData: task.data,
          processedAt: new Date().toISOString()
        };
    }

    const response = {
      success: true,
      result,
      processingTime: Date.now() - startTime,
      memoryUsage: process.memoryUsage()
    };

    res.json(response);
    
  } catch (error) {
    logger.error('Task processing failed', error as Error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      processingTime: Date.now() - startTime,
      memoryUsage: process.memoryUsage()
    });
  }
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error', err, {
    path: req.path,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  if (res.headersSent) {
    return next(err);
  }

  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(500).json({
    error: 'Internal server error',
    message: isDevelopment ? err.message : 'Something went wrong',
    stack: isDevelopment ? err.stack : undefined
  });
});

// 404 handler
app.use('*', (req, res) => {
  logger.audit('404 Not Found', {
    path: req.path,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Initialize Socket.IO service
const socketService = new SocketService(httpServer);

// Graceful shutdown handler
const gracefulShutdown = (signal: string) => {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  
  httpServer.close(() => {
    logger.info('HTTP server closed');
    
    // Close all active Claude Code sessions
    const activeSessions = claudeCodeWrapper.getActiveSessions();
    Promise.all(
      activeSessions.map(sessionId => claudeCodeWrapper.terminateSession(sessionId))
    ).then(() => {
      logger.info('All Claude Code sessions terminated');
      process.exit(0);
    }).catch(error => {
      logger.error('Error during session cleanup', error);
      process.exit(1);
    });
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Forceful shutdown after timeout');
    process.exit(1);
  }, 10000);
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', new Error(String(reason)), {
    promise: promise.toString()
  });
  process.exit(1);
});

// Start server
httpServer.listen(config.port, () => {
  logger.info('Claude Code WebUI Server started', {
    port: config.port,
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    maxSessions: config.maxSessions,
    sessionTimeout: config.sessionTimeout,
    claudeCodePath: config.claudeCodePath
  });

  // Log configuration warnings
  if (config.jwtSecret === 'dev-secret-change-in-production') {
    logger.warn('Using default JWT secret - change in production!');
  }
  
  if (!config.allowedIPs && process.env.NODE_ENV === 'production') {
    logger.warn('No IP whitelist configured - all IPs allowed in production!');
  }
  
  console.log(`
╭─────────────────────────────────────────────────╮
│                                                 │
│   🚀 Claude Code WebUI Server                   │
│                                                 │
│   📍 Server: https://localhost:${config.port}          │
│   🌍 Environment: ${process.env.NODE_ENV || 'development'}                    │
│   🔒 Sessions: ${config.maxSessions} max                        │
│   ⏱️  Timeout: ${config.sessionTimeout} minutes                    │
│                                                 │
╰─────────────────────────────────────────────────╯
  `);
});

// Export for testing
export { app, httpServer, config };