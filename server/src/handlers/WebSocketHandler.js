/**
 * WebSocket Handler
 * Manages Socket.IO connections and real-time communication
 * Separated from testServer.js to follow single responsibility principle
 */

const appEventEmitter = require('../events/EventEmitter');

class WebSocketHandler {
  constructor(options = {}) {
    this.io = options.io;
    this.metricsService = options.metricsService;
    this.llmGateway = options.llmGateway;
    this.llmCollaboration = options.llmCollaboration;
    this.webUICollaboration = options.webUICollaboration;
    
    if (!this.io) {
      throw new Error('Socket.IO instance is required for WebSocketHandler');
    }
  }

  /**
   * Initialize WebSocket event handlers
   */
  initialize() {
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });
    
    // Start system stats broadcasting
    this.startSystemStatsBroadcast();
  }

  /**
   * Handle new socket connection
   */
  async handleConnection(socket) {
    console.log('Client connected to metrics dashboard');
    
    try {
      // Send initial metrics data
      await this.sendInitialData(socket);
      console.log('Initial metrics data sent to client');
    } catch (error) {
      console.error('Failed to send initial metrics:', error);
    }
    
    // Register socket event handlers
    this.registerSocketHandlers(socket);
  }

  /**
   * Send initial data to newly connected client
   */
  async sendInitialData(socket) {
    if (!this.metricsService) return;
    
    const existingMetrics = await this.metricsService.getMetrics();
    
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
    this.metricsService.handleSystemStatsRequest(socket);
  }

  /**
   * Register all socket event handlers
   */
  registerSocketHandlers(socket) {
    // System metrics requests
    socket.on('metrics:request_system', () => {
      if (this.metricsService) {
        this.metricsService.handleSystemStatsRequest(socket);
      }
    });
    
    // Test simulation handlers
    socket.on('test:simulate_llm', async (data) => {
      await this.handleSimulateLLM(socket, data);
    });
    
    socket.on('test:simulate_rag', async (data) => {
      await this.handleSimulateRAG(socket, data);
    });
    
    // LLM query handler
    socket.on('llm:query', async (data) => {
      await this.handleLLMQuery(socket, data);
    });
    
    // RAG search handler
    socket.on('rag:search', async (data) => {
      await this.handleRAGSearch(socket, data);
    });
    
    // LLM collaboration handler
    socket.on('llm:collaboration', async (data) => {
      await this.handleLLMCollaboration(socket, data);
    });
    
    // WebUI collaboration handler
    socket.on('webui:collaboration', async (data) => {
      await this.handleWebUICollaboration(socket, data);
    });
  }

  /**
   * Handle LLM simulation for testing
   */
  async handleSimulateLLM(socket, data) {
    if (!this.metricsService) return;
    
    await this.metricsService.recordLLMRequest(data.sessionId || 'test-session', {
      model: data.model || 'claude-4',
      tokens: data.tokens || 1024,
      cost: data.cost || 0.003,
      latency: data.latency || 1500,
      success: data.success !== false
    });
  }

  /**
   * Handle RAG simulation for testing
   */
  async handleSimulateRAG(socket, data) {
    if (!this.metricsService) return;
    
    await this.metricsService.recordRAGSearch(data.sessionId || 'test-session', {
      query: data.query || 'test query',
      results: data.results || [{id: 1, title: 'Test Document'}],
      processingTime: data.processingTime || 200
    });
  }

  /**
   * Handle LLM query via WebSocket
   */
  async handleLLMQuery(socket, data) {
    const { query, model = 'claude-4', sessionId = 'default-session' } = data;
    
    console.log('LLM query received:', { model, sessionId, queryLength: query.length });
    
    try {
      if (!this.llmGateway) {
        throw new Error('LLM Gateway not available');
      }
      
      // Use LLM Gateway Service to process query
      const result = await this.llmGateway.queryLLM(model, query, { sessionId });
      
      // Record metrics
      if (this.metricsService) {
        await this.metricsService.recordLLMRequest(sessionId, {
          model: result.model,
          tokens: result.tokens,
          cost: result.cost,
          latency: result.latency,
          success: result.success
        });
      }
      
      // Send response back to client
      socket.emit('llm:response', {
        success: true,
        result,
        sessionId
      });
      
    } catch (error) {
      console.error('LLM query error:', error);
      socket.emit('llm:response', {
        success: false,
        error: error.message,
        sessionId
      });
    }
  }

  /**
   * Handle RAG search via WebSocket
   */
  async handleRAGSearch(socket, data) {
    const { query, topK = 5, sessionId = 'default-session' } = data;
    
    console.log('RAG search received:', { query, topK, sessionId });
    
    try {
      if (!this.llmGateway || !this.llmGateway.ragStorage) {
        throw new Error('RAG Storage not available');
      }
      
      const startTime = Date.now();
      const results = await this.llmGateway.ragStorage.search(query, topK);
      const processingTime = Date.now() - startTime;
      
      // Record metrics
      if (this.metricsService) {
        await this.metricsService.recordRAGSearch(sessionId, {
          query,
          results,
          processingTime
        });
      }
      
      // Send response back to client
      socket.emit('rag:response', {
        success: true,
        results,
        processingTime,
        sessionId
      });
      
    } catch (error) {
      console.error('RAG search error:', error);
      socket.emit('rag:response', {
        success: false,
        error: error.message,
        sessionId
      });
    }
  }

  /**
   * Handle LLM collaboration via WebSocket
   */
  async handleLLMCollaboration(socket, data) {
    const { query, sessionId = 'default-session', models } = data;
    
    console.log('LLM collaboration received:', { query, sessionId, models });
    
    try {
      if (!this.llmCollaboration) {
        throw new Error('LLM Collaboration service not available');
      }
      
      const result = await this.llmCollaboration.processCollaborativeQuery(query, {
        sessionId,
        models
      });
      
      socket.emit('llm:collaboration_response', {
        success: true,
        result,
        sessionId
      });
      
    } catch (error) {
      console.error('LLM collaboration error:', error);
      socket.emit('llm:collaboration_response', {
        success: false,
        error: error.message,
        sessionId
      });
    }
  }

  /**
   * Handle WebUI collaboration via WebSocket
   */
  async handleWebUICollaboration(socket, data) {
    const { query, sessionId = 'default-session', collaborationType } = data;
    
    console.log('WebUI collaboration received:', { query, sessionId, collaborationType });
    
    try {
      if (!this.webUICollaboration) {
        throw new Error('WebUI Collaboration service not available');
      }
      
      const result = await this.webUICollaboration.processCollaborativeQuery(query, {
        sessionId,
        collaborationType
      });
      
      socket.emit('webui:collaboration_response', {
        success: true,
        result,
        sessionId
      });
      
    } catch (error) {
      console.error('WebUI collaboration error:', error);
      socket.emit('webui:collaboration_response', {
        success: false,
        error: error.message,
        sessionId
      });
    }
  }

  /**
   * Start system stats broadcasting
   */
  startSystemStatsBroadcast() {
    // Broadcast system stats every 5 minutes
    setInterval(() => {
      if (this.io && this.io.sockets && this.io.engine.clientsCount > 0 && this.metricsService) {
        this.metricsService.collectSystemStats();
        const systemStats = this.metricsService.metrics.systemStats;
        this.io.emit('metrics:system', systemStats);
      }
    }, 300000); // 5 minutes
  }

  /**
   * Get WebSocket statistics
   */
  getStats() {
    return {
      connectedClients: this.io ? this.io.engine.clientsCount : 0,
      totalConnections: this.io ? this.io.engine.metrics?.totalConnections || 0 : 0,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = WebSocketHandler;