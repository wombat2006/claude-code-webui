/**
 * LLM Controller
 * Handles LLM query processing and collaboration endpoints
 */

const BaseController = require('./BaseController');
const appEventEmitter = require('../events/EventEmitter');

class LLMController extends BaseController {
  constructor(options = {}) {
    super(options);
    this.llmGateway = options.llmGateway;
    this.llmCollaboration = options.llmCollaboration;
    this.metricsService = options.metricsService;
    
    if (!this.llmGateway) {
      throw new Error('LLM Gateway service is required for LLMController');
    }

    // Listen to LLM events from socket
    this.setupEventListeners();
  }

  /**
   * Setup event listeners for socket-driven LLM requests
   */
  setupEventListeners() {
    const { EVENTS } = appEventEmitter;

    // Handle LLM queries from WebSocket
    appEventEmitter.onSafe(EVENTS.LLM_QUERY, async (data) => {
      await this.handleSocketLLMQuery(data);
    });

    // Handle collaboration requests from WebSocket
    appEventEmitter.onSafe(EVENTS.LLM_COLLABORATION_START, async (data) => {
      await this.handleSocketCollaboration(data);
    });

    this.log('LLM event listeners registered');
  }

  /**
   * Process LLM query with session context
   * POST /llm/query/:sessionId
   */
  processQuery = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { query, contextType, maxReferences, format } = req.body;

    this.validateRequired(req, ['query']);

    this.log('Processing LLM query', { sessionId, queryLength: query.length });

    const result = await this.llmGateway.processQuery(query, {
      sessionId,
      contextType: contextType || 'recent',
      maxReferences: maxReferences || 5,
      format: format || 'detailed'
    });

    return this.successResponse(res, result);
  });

  /**
   * Get debugging context for error analysis
   * GET /llm/debug/:sessionId
   */
  getDebugContext = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { errorQuery } = req.query;

    this.log('Building debug context', { sessionId });

    const debugContext = await this.llmGateway.getDebugContext(sessionId, errorQuery || '');
    
    if (!debugContext) {
      return res.status(404).json({
        success: false,
        error: `Debug context not found for session ${sessionId}`,
        timestamp: new Date().toISOString()
      });
    }

    return this.successResponse(res, debugContext, `Debug context built for session ${sessionId}`);
  });

  /**
   * Search snapshots with criteria
   * POST /llm/search
   */
  searchSnapshots = this.asyncHandler(async (req, res) => {
    const { criteria } = req.body;

    this.log('Searching snapshots', criteria);

    const snapshots = await this.llmGateway.snapshotRetriever.searchSnapshots(criteria);

    const searchResults = {
      results: snapshots.map(s => ({
        sessionId: s.sessionId,
        timestamp: s.timestamp,
        triggerEvent: s.triggerEvent,
        command: s.context?.execution?.command,
        exitCode: s.context?.execution?.exitCode,
        lastChangedFile: s.context?.fileSystem?.lastChangedFile
      })),
      count: snapshots.length
    };

    return this.successResponse(res, searchResults, `Found ${snapshots.length} matching snapshots`);
  });

  /**
   * Get gateway statistics
   * GET /llm/stats
   */
  getStats = (req, res) => {
    try {
      const stats = this.llmGateway.getStats();
      return this.successResponse(res, stats, 'LLM Gateway statistics');
    } catch (error) {
      return this.errorResponse(res, error);
    }
  };

  /**
   * HTTP LLM query endpoint (without session context)
   * POST /llm/query
   */
  queryLLM = this.asyncHandler(async (req, res) => {
    const { query, model = 'claude-4', sessionId = 'http-session' } = req.body;
    
    this.validateRequired(req, ['query']);
    
    this.log('HTTP LLM query', { model, sessionId, queryLength: query.length });
    
    const result = await this.llmGateway.queryLLM(model, query, { sessionId });
    
    // Record metrics if service available
    if (this.metricsService) {
      await this.metricsService.recordLLMRequest(sessionId, {
        model: result.model,
        tokens: result.tokens,
        cost: result.cost,
        latency: result.latency,
        success: result.success
      });
    }
    
    return res.json(result);
  });

  /**
   * LLM collaboration endpoint (CLAUDE.md wall-bounce)
   * POST /llm/collaboration/:sessionId
   */
  processCollaboration = this.asyncHandler(async (req, res) => {
    const sessionId = req.params.sessionId;
    const { 
      query, 
      taskType = 'general',
      models = ['gpt-5', 'claude-4', 'gemini-2.5-pro']
    } = req.body;
    
    this.validateRequired(req, ['query']);

    this.log('Processing collaborative query', {
      sessionId,
      queryLength: query.length,
      taskType,
      models
    });

    if (!this.llmCollaboration) {
      return this.errorResponse(res, new Error('LLM Collaboration service not available'), 503);
    }

    const startTime = Date.now();
    
    // Execute multi-LLM collaboration
    const result = await this.llmCollaboration.processCollaborativeQuery(query, {
      sessionId,
      taskType,
      models
    });
    
    const processingTime = Date.now() - startTime;
    result.metadata.processingTime = processingTime;

    this.log('Collaborative query completed', {
      sessionId,
      wallBounceCount: result.wallBounceCount,
      modelsUsed: result.metadata.modelsUsed,
      processingTime: `${processingTime}ms`
    });

    return res.json(result);
  });

  /**
   * Handle LLM query from WebSocket
   */
  async handleSocketLLMQuery(data) {
    try {
      const { query, model = 'claude-4', sessionId = 'default-session', socketId } = data;
      
      this.log('Socket LLM query received', { model, sessionId, queryLength: query.length });
      
      // Use LLM Gateway Service to process query
      const result = await this.llmGateway.queryLLM(model, query, { sessionId });
      
      // Record metrics if service available
      if (this.metricsService) {
        await this.metricsService.recordLLMRequest(sessionId, {
          model: result.model,
          tokens: result.tokens,
          cost: result.cost,
          latency: result.latency,
          success: result.success
        });
      }
      
      // Emit response event
      appEventEmitter.emitSafe(appEventEmitter.EVENTS.LLM_RESPONSE, {
        id: data.id, // For request/response matching
        success: result.success,
        response: result.response,
        model: result.model,
        latency: result.latency,
        tokens: result.tokens,
        cost: result.cost,
        contextReferences: result.context?.references || 0,
        sessionId,
        socketId
      });
      
    } catch (error) {
      this.log('Socket LLM query failed', { error: error.message });
      
      appEventEmitter.emitSafe(appEventEmitter.EVENTS.LLM_RESPONSE, {
        id: data.id,
        success: false,
        error: error.message,
        model: data.model,
        sessionId: data.sessionId,
        socketId: data.socketId
      });
    }
  }

  /**
   * Handle collaboration request from WebSocket
   */
  async handleSocketCollaboration(data) {
    try {
      const { query, taskType = 'general', models, sessionId, userId = 'webui-user' } = data;
      
      this.log('Socket collaboration started', { 
        userId, sessionId, taskType, 
        queryLength: query.length, 
        models 
      });

      if (!this.llmCollaboration) {
        throw new Error('LLM Collaboration service not available');
      }

      // Use appropriate collaboration service (WebUI or standard)
      const result = this.llmCollaboration.processWebUICollaboration ? 
        await this.llmCollaboration.processWebUICollaboration({
          query,
          taskType,
          models,
          sessionId,
          userId,
          useMemory: true
        }) :
        await this.llmCollaboration.processCollaborativeQuery(query, {
          sessionId,
          taskType,
          models
        });

      // Emit completion event
      appEventEmitter.emitSafe(appEventEmitter.EVENTS.LLM_COLLABORATION_COMPLETE, {
        ...result,
        sessionId,
        socketId: data.socketId
      });
      
      // Record metrics if available
      if (this.metricsService) {
        await this.metricsService.recordLLMComplete(sessionId, {
          model: 'collaboration-' + models.join(','),
          tokens: result.finalResponse.length / 4, // Rough estimate
          cost: 0.001 * models.length, // Rough estimate
          latency: result.metadata.processingTime || 5000,
          success: result.success
        });
      }

    } catch (error) {
      this.log('Socket collaboration error', { 
        error: error.message, 
        sessionId: data.sessionId 
      });
      
      appEventEmitter.emitSafe(appEventEmitter.EVENTS.LLM_COLLABORATION_ERROR, { 
        error: error.message,
        sessionId: data.sessionId,
        socketId: data.socketId
      });
    }
  }

  /**
   * Register routes for this controller
   */
  registerRoutes(app) {
    app.post('/llm/query/:sessionId', this.processQuery);
    app.get('/llm/debug/:sessionId', this.getDebugContext);
    app.post('/llm/search', this.searchSnapshots);
    app.get('/llm/stats', this.getStats);
    app.post('/llm/query', this.queryLLM);
    app.post('/llm/collaboration/:sessionId', this.processCollaboration);
    
    this.log('LLM routes registered', {
      routes: [
        'POST /llm/query/:sessionId',
        'GET /llm/debug/:sessionId',
        'POST /llm/search',
        'GET /llm/stats',
        'POST /llm/query',
        'POST /llm/collaboration/:sessionId'
      ]
    });
  }
}

module.exports = LLMController;