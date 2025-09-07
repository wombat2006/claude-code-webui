/**
 * Main Application Server
 * Simplified and focused server entry point following single responsibility principle
 * Replaces the monolithic testServer.js structure
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const ServerConfiguration = require('./config/ServerConfiguration');
const APIRouter = require('./routes/APIRouter');
const WebSocketHandler = require('./handlers/WebSocketHandler');

class Application {
  constructor(options = {}) {
    // Initialize configuration
    this.config = new ServerConfiguration({
      port: options.port || process.env.PORT || 8080,
      region: options.region || 'us-east-1',
      instanceType: options.instanceType || 'c8gd.medium',
      environment: options.environment || process.env.NODE_ENV || 'development',
      mockLLM: options.mockLLM || process.env.MOCK_LLM === 'true'
    });

    // Initialize Express app
    this.app = express();
    this.server = http.createServer(this.app);
    
    // Initialize Socket.IO
    this.io = new Server(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    // Initialize services
    this.services = null;
    this.apiRouter = null;
    this.webSocketHandler = null;
  }

  /**
   * Initialize the application
   */
  async initialize() {
    try {
      // Configure server middleware
      this.config.configureServer(this.app);
      
      // Create services with Socket.IO reference
      this.services = this.config.createServices(this.io);
      
      // Initialize API router with services
      this.apiRouter = new APIRouter({
        services: this.services
      });
      
      // Initialize WebSocket handler
      this.webSocketHandler = new WebSocketHandler({
        io: this.io,
        metricsService: this.services.metricsService,
        llmGateway: this.services.llmGateway,
        llmCollaboration: this.services.llmCollaboration,
        webUICollaboration: this.services.webUICollaboration
      });
      
      // Register routes
      this.apiRouter.registerRoutes(this.app);
      
      // Initialize WebSocket handlers
      this.webSocketHandler.initialize();
      
      // Start memory monitoring
      this.config.startMemoryMonitoring();
      
      this.config.log('Application initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize application:', error);
      throw error;
    }
  }

  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.server.listen(this.config.port, () => {
          this.config.log('Server started successfully', {
            port: this.config.port,
            region: this.config.region,
            environment: this.config.environment,
            mockLLM: this.config.mockLLM
          });
          
          // Display startup banner
          this.config.displayStartupBanner();
          
          resolve(this.server);
        });
        
        this.server.on('error', (error) => {
          this.config.log('Server error', { error: error.message });
          reject(error);
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the server gracefully
   */
  async stop() {
    return new Promise((resolve) => {
      this.server.close(() => {
        this.config.log('Server stopped gracefully');
        resolve();
      });
    });
  }

  /**
   * Get application status and statistics
   */
  getStatus() {
    return {
      server: this.config.getSystemInfo(),
      routes: this.apiRouter ? this.apiRouter.getRouteStats() : null,
      websocket: this.webSocketHandler ? this.webSocketHandler.getStats() : null,
      services: {
        stateSync: !!this.services?.stateSync,
        llmGateway: !!this.services?.llmGateway,
        metricsService: !!this.services?.metricsService,
        s3Uploader: !!this.services?.s3Uploader
      },
      timestamp: new Date().toISOString()
    };
  }
}

// Export for module usage
module.exports = Application;

// Run directly if called as main module
if (require.main === module) {
  async function startServer() {
    const app = new Application();
    
    try {
      await app.initialize();
      await app.start();
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }
  
  startServer();
}