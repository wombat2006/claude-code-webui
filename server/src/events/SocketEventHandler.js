/**
 * Socket Event Handler
 * Handles Socket.IO events with loose coupling through ApplicationEventEmitter
 */

const appEventEmitter = require('./EventEmitter');

class SocketEventHandler {
  constructor(io) {
    this.io = io;
    this.connectedClients = new Set();
    
    this.log = (message, data = {}) => {
      console.log(`[SocketEventHandler ${new Date().toISOString()}] ${message}`, 
        data && Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '');
    };

    this.setupEventListeners();
    this.log('Socket Event Handler initialized');
  }

  /**
   * Setup application event listeners
   */
  setupEventListeners() {
    const { EVENTS } = appEventEmitter;

    // Metrics events
    appEventEmitter.onSafe(EVENTS.METRICS_SYSTEM, (data) => {
      this.broadcast('metrics:system', data);
    });

    appEventEmitter.onSafe(EVENTS.METRICS_DAILY_UPDATE, (data) => {
      this.broadcast('metrics:daily_update', data);
    });

    appEventEmitter.onSafe(EVENTS.METRICS_LLM_HEALTH, (data) => {
      this.broadcast('metrics:llm_health', data);
    });

    appEventEmitter.onSafe(EVENTS.METRICS_RAG_UPDATE, (data) => {
      this.broadcast('metrics:rag_update', data);
    });

    // LLM collaboration events  
    appEventEmitter.onSafe(EVENTS.LLM_COLLABORATION_COMPLETE, (data) => {
      this.broadcastToSession(data.sessionId, 'llm:collaboration_complete', data);
    });

    appEventEmitter.onSafe(EVENTS.LLM_COLLABORATION_ERROR, (data) => {
      this.broadcastToSession(data.sessionId, 'llm:collaboration_error', data);
    });

    appEventEmitter.onSafe(EVENTS.LLM_RESPONSE, (data) => {
      this.broadcastToSession(data.sessionId, 'llm:response', data);
    });

    // User session events
    appEventEmitter.onSafe(EVENTS.USER_HISTORY_RESPONSE, (data) => {
      this.broadcastToSession(data.sessionId, 'llm:user_history', data);
    });

    this.log('Application event listeners registered');
  }

  /**
   * Handle new socket connections
   */
  handleConnection(socket) {
    this.connectedClients.add(socket.id);
    
    this.log('Client connected', { 
      socketId: socket.id,
      totalClients: this.connectedClients.size 
    });

    // Emit connection event to application
    appEventEmitter.emitSafe(appEventEmitter.EVENTS.CLIENT_CONNECTED, {
      socketId: socket.id,
      timestamp: Date.now()
    });

    // Register socket event handlers
    this.registerSocketHandlers(socket);

    // Handle disconnection
    socket.on('disconnect', () => {
      this.handleDisconnection(socket);
    });
  }

  /**
   * Register individual socket event handlers
   */
  registerSocketHandlers(socket) {
    const { EVENTS } = appEventEmitter;

    // System stats request
    socket.on('metrics:request_system', () => {
      appEventEmitter.emitSafe(EVENTS.SYSTEM_STATS_REQUEST, { socketId: socket.id });
    });

    // LLM query handling
    socket.on('llm:query', (data) => {
      appEventEmitter.emitSafe(EVENTS.LLM_QUERY, {
        ...data,
        socketId: socket.id,
        timestamp: Date.now()
      });
    });

    // LLM collaboration start
    socket.on('llm:start_collaboration', (data) => {
      appEventEmitter.emitSafe(EVENTS.LLM_COLLABORATION_START, {
        ...data,
        socketId: socket.id,
        timestamp: Date.now()
      });
    });

    // User history request
    socket.on('llm:get_user_history', (data) => {
      appEventEmitter.emitSafe(EVENTS.USER_HISTORY_REQUEST, {
        ...data,
        socketId: socket.id,
        timestamp: Date.now()
      });
    });

    // User context reset
    socket.on('llm:reset_user_context', (data) => {
      appEventEmitter.emitSafe(EVENTS.USER_CONTEXT_RESET, {
        ...data,
        socketId: socket.id,
        timestamp: Date.now()
      });
    });

    // Test simulation events
    socket.on('test:simulate_llm', (data) => {
      appEventEmitter.emitSafe(EVENTS.TEST_SIMULATE_LLM, {
        ...data,
        socketId: socket.id,
        timestamp: Date.now()
      });
    });

    socket.on('test:simulate_rag', (data) => {
      appEventEmitter.emitSafe(EVENTS.TEST_SIMULATE_RAG, {
        ...data,
        socketId: socket.id,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Handle socket disconnection
   */
  handleDisconnection(socket) {
    this.connectedClients.delete(socket.id);
    
    this.log('Client disconnected', { 
      socketId: socket.id,
      totalClients: this.connectedClients.size 
    });

    // Emit disconnection event to application
    appEventEmitter.emitSafe(appEventEmitter.EVENTS.CLIENT_DISCONNECTED, {
      socketId: socket.id,
      timestamp: Date.now()
    });
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(event, data) {
    try {
      this.io.emit(event, data);
      this.log(`Broadcasted: ${event}`, { 
        clientCount: this.connectedClients.size 
      });
    } catch (error) {
      this.log(`Broadcast failed: ${event}`, { error: error.message });
    }
  }

  /**
   * Broadcast message to specific session
   */
  broadcastToSession(sessionId, event, data) {
    if (!sessionId) {
      return this.broadcast(event, data);
    }

    try {
      this.io.to(sessionId).emit(event, data);
      this.log(`Session broadcast: ${event}`, { sessionId });
    } catch (error) {
      this.log(`Session broadcast failed: ${event}`, { 
        sessionId, 
        error: error.message 
      });
    }
  }

  /**
   * Send message to specific socket
   */
  sendToSocket(socketId, event, data) {
    try {
      this.io.to(socketId).emit(event, data);
      this.log(`Direct message: ${event}`, { socketId });
    } catch (error) {
      this.log(`Direct message failed: ${event}`, { 
        socketId, 
        error: error.message 
      });
    }
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      connectedClients: this.connectedClients.size,
      eventStats: appEventEmitter.getEventStats(),
      timestamp: Date.now()
    };
  }
}

module.exports = SocketEventHandler;