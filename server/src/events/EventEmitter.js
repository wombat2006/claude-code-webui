/**
 * Custom Event Emitter for Socket.IO loose coupling
 * Provides a clean interface between controllers and Socket.IO
 */

const { EventEmitter } = require('events');

class ApplicationEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // Allow many listeners for different components
    
    // Event type constants
    this.EVENTS = {
      // Metrics events
      METRICS_SYSTEM: 'metrics:system',
      METRICS_DAILY_UPDATE: 'metrics:daily_update', 
      METRICS_LLM_HEALTH: 'metrics:llm_health',
      METRICS_RAG_UPDATE: 'metrics:rag_update',
      
      // LLM collaboration events
      LLM_QUERY: 'llm:query',
      LLM_RESPONSE: 'llm:response',
      LLM_COLLABORATION_START: 'llm:start_collaboration',
      LLM_COLLABORATION_COMPLETE: 'llm:collaboration_complete',
      LLM_COLLABORATION_ERROR: 'llm:collaboration_error',
      
      // User session events
      USER_HISTORY_REQUEST: 'llm:get_user_history',
      USER_HISTORY_RESPONSE: 'llm:user_history',
      USER_CONTEXT_RESET: 'llm:reset_user_context',
      
      // Test simulation events
      TEST_SIMULATE_LLM: 'test:simulate_llm',
      TEST_SIMULATE_RAG: 'test:simulate_rag',
      
      // Connection events
      CLIENT_CONNECTED: 'client:connected',
      CLIENT_DISCONNECTED: 'client:disconnected',
      
      // System events
      SYSTEM_STATS_REQUEST: 'metrics:request_system',
      MEMORY_WARNING: 'system:memory_warning'
    };

    this.log = (message, data = {}) => {
      console.log(`[EventEmitter ${new Date().toISOString()}] ${message}`, 
        data && Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '');
    };

    this.log('Application Event Emitter initialized');
  }

  /**
   * Emit event with logging and error handling
   */
  emitSafe(eventName, data) {
    try {
      this.log(`Emitting event: ${eventName}`, { 
        listeners: this.listenerCount(eventName),
        hasData: !!data 
      });
      
      this.emit(eventName, data);
      return true;
    } catch (error) {
      this.log(`Failed to emit event: ${eventName}`, { 
        error: error.message 
      });
      return false;
    }
  }

  /**
   * Register event listener with error handling
   */
  onSafe(eventName, handler) {
    try {
      this.on(eventName, (data) => {
        try {
          handler(data);
        } catch (error) {
          this.log(`Error in event handler for: ${eventName}`, { 
            error: error.message 
          });
        }
      });
      
      this.log(`Event listener registered: ${eventName}`, {
        totalListeners: this.listenerCount(eventName)
      });
    } catch (error) {
      this.log(`Failed to register event listener: ${eventName}`, { 
        error: error.message 
      });
    }
  }

  /**
   * Get all registered events and their listener counts
   */
  getEventStats() {
    const stats = {};
    
    for (const [key, eventName] of Object.entries(this.EVENTS)) {
      stats[eventName] = {
        constantName: key,
        listenerCount: this.listenerCount(eventName)
      };
    }
    
    return stats;
  }

  /**
   * Remove all listeners safely
   */
  cleanupAllListeners() {
    this.log('Cleaning up all event listeners');
    this.removeAllListeners();
  }
}

// Export singleton instance
const appEventEmitter = new ApplicationEventEmitter();

module.exports = appEventEmitter;