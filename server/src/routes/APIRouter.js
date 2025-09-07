/**
 * API Router
 * Centralized route management and controller integration
 * Replaces scattered route definitions from testServer.js
 */

class APIRouter {
  constructor(options = {}) {
    this.services = options.services || {};
    this.controllers = {};
  }

  /**
   * Initialize all controllers with services
   */
  initializeControllers() {
    const HealthController = require('../controllers/HealthController');
    const StateController = require('../controllers/StateController');
    const ProcessController = require('../controllers/ProcessController');
    const LLMController = require('../controllers/LLMController');
    const RAGController = require('../controllers/RAGController');
    const S3Controller = require('../controllers/S3Controller');
    const MetricsController = require('../controllers/MetricsController');

    // Initialize controllers with proper services
    this.controllers.health = new HealthController({
      region: 'us-east-1',
      instanceType: 'c8gd.medium'
    });

    this.controllers.state = new StateController({
      stateSync: this.services.stateSync
    });

    this.controllers.process = new ProcessController({
      region: 'us-east-1'
    });

    this.controllers.llm = new LLMController({
      llmGateway: this.services.llmGateway,
      llmCollaboration: this.services.llmCollaboration,
      metricsService: this.services.metricsService
    });

    this.controllers.rag = new RAGController({
      llmGateway: this.services.llmGateway,
      metricsService: this.services.metricsService
    });

    this.controllers.s3 = new S3Controller({
      s3Uploader: this.services.s3Uploader
    });

    this.controllers.metrics = new MetricsController({
      metricsService: this.services.metricsService
    });

    console.log('✅ All controllers initialized with proper services');
  }

  /**
   * Register all routes with Express app
   */
  registerRoutes(app) {
    if (!this.controllers || Object.keys(this.controllers).length === 0) {
      this.initializeControllers();
    }

    // Register controller routes
    Object.entries(this.controllers).forEach(([name, controller]) => {
      if (controller && typeof controller.registerRoutes === 'function') {
        controller.registerRoutes(app);
        console.log(`✅ ${name.charAt(0).toUpperCase() + name.slice(1)}Controller routes registered`);
      }
    });

    // Register additional routes that don't fit into controllers
    this.registerLegacyRoutes(app);
    
    console.log('✅ All API routes registered successfully');
  }

  /**
   * Register legacy routes that haven't been moved to controllers yet
   */
  registerLegacyRoutes(app) {
    // Tokyo test endpoint (region-specific testing)
    app.post('/tokyo/test', async (req, res) => {
      const startTime = Date.now();
      
      try {
        const { message, delay = 0 } = req.body;
        
        // Simulate processing delay
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const response = {
          success: true,
          message: `Tokyo region processed: ${message}`,
          region: 'ap-northeast-1',
          processedAt: new Date().toISOString(),
          processingTime: Date.now() - startTime,
          instanceType: 'c8gd.medium'
        };
        
        console.log(`[${new Date().toISOString()}] Tokyo test processed`, {
          message: message?.substring(0, 50),
          processingTime: response.processingTime
        });
        
        res.json(response);
        
      } catch (error) {
        console.error('Tokyo test error:', error);
        res.status(500).json({
          success: false,
          error: error.message,
          region: 'ap-northeast-1',
          processingTime: Date.now() - startTime
        });
      }
    });

    // Legacy LLM query endpoint (without session ID)
    app.post('/llm/query', async (req, res) => {
      const startTime = Date.now();
      
      try {
        const { query, model = 'claude-4', sessionId = 'legacy-session' } = req.body;
        
        if (!query) {
          return res.status(400).json({
            success: false,
            error: 'Query is required'
          });
        }

        const result = await this.services.llmGateway.queryLLM(model, query, { sessionId });
        
        // Record metrics if service available
        if (this.services.metricsService) {
          await this.services.metricsService.recordLLMRequest(sessionId, {
            model: result.model,
            tokens: result.tokens,
            cost: result.cost,
            latency: result.latency,
            success: result.success
          });
        }
        
        const response = {
          success: true,
          result,
          processingTime: Date.now() - startTime
        };
        
        console.log(`[${new Date().toISOString()}] Legacy LLM query processed`, {
          model,
          sessionId,
          tokens: result.tokens,
          cost: result.cost
        });
        
        res.json(response);
        
      } catch (error) {
        console.error('Legacy LLM query error:', error);
        res.status(500).json({
          success: false,
          error: error.message,
          processingTime: Date.now() - startTime
        });
      }
    });

    // Legacy RAG search endpoint
    app.post('/rag/search', async (req, res) => {
      const startTime = Date.now();
      
      try {
        const { query, topK = 5, sessionId = 'legacy-session' } = req.body;
        
        if (!query) {
          return res.status(400).json({
            success: false,
            error: 'Query is required'
          });
        }

        const results = await this.services.llmGateway.ragStorage.search(query, topK);
        const processingTime = Date.now() - startTime;
        
        // Record metrics if service available
        if (this.services.metricsService) {
          await this.services.metricsService.recordRAGSearch(sessionId, {
            query,
            results,
            processingTime
          });
        }
        
        const response = {
          success: true,
          results,
          processingTime,
          metadata: {
            query,
            topK,
            resultCount: results.length
          }
        };
        
        console.log(`[${new Date().toISOString()}] Legacy RAG search processed`, {
          query: query.substring(0, 50),
          resultCount: results.length,
          processingTime
        });
        
        res.json(response);
        
      } catch (error) {
        console.error('Legacy RAG search error:', error);
        res.status(500).json({
          success: false,
          error: error.message,
          processingTime: Date.now() - startTime
        });
      }
    });

    console.log('✅ Legacy routes registered');
  }

  /**
   * Get route statistics
   */
  getRouteStats() {
    const controllerStats = Object.entries(this.controllers).map(([name, controller]) => ({
      name,
      hasController: !!controller,
      hasRegisterRoutes: !!(controller && typeof controller.registerRoutes === 'function')
    }));

    return {
      totalControllers: Object.keys(this.controllers).length,
      controllers: controllerStats,
      legacyRoutes: 3, // tokyo/test, legacy /llm/query, legacy /rag/search
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = APIRouter;