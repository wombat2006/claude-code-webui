/**
 * Simple State Synchronization Service
 * Phase 1 implementation for distributed state management
 */

const fs = require('fs').promises;
const path = require('path');

class SimpleStateSync {
  constructor() {
    this.cacheDir = '/tmp/claude-state-cache';
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.nodeId = `${this.region}-${Date.now()}`;
    this.cache = new Map();
    this.eventListeners = new Map();
    
    this.log = (message, data = {}) => {
      console.log(`[StateSync ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    // Initialize cache directory
    this.initCacheDir();
  }

  async initCacheDir() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      this.log('Cache directory initialized', { cacheDir: this.cacheDir });
    } catch (error) {
      this.log('Failed to initialize cache directory', { error: error.message });
    }
  }

  /**
   * Save session state
   */
  async saveState(sessionId, data, options = {}) {
    try {
      const timestamp = Date.now();
      const stateData = {
        sessionId,
        data,
        timestamp,
        region: this.region,
        nodeId: this.nodeId,
        version: options.version || 1,
        ...options
      };

      // Local cache
      this.cache.set(sessionId, stateData);

      // File-based persistence for now (later: DynamoDB)
      const filePath = path.join(this.cacheDir, `${sessionId}.json`);
      await fs.writeFile(filePath, JSON.stringify(stateData, null, 2));

      this.log('State saved', {
        sessionId,
        region: this.region,
        dataSize: JSON.stringify(data).length,
        timestamp
      });

      // Emit state_saved event
      this.emitEvent('state_saved', {
        sessionId,
        stateData,
        action: 'save'
      });

      return stateData;
    } catch (error) {
      this.log('Failed to save state', { 
        sessionId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get session state
   */
  async getState(sessionId) {
    try {
      // Try cache first
      if (this.cache.has(sessionId)) {
        const cached = this.cache.get(sessionId);
        this.log('State retrieved from cache', {
          sessionId,
          age: Date.now() - cached.timestamp
        });
        return cached;
      }

      // Try file system
      const filePath = path.join(this.cacheDir, `${sessionId}.json`);
      try {
        const fileData = await fs.readFile(filePath, 'utf8');
        const stateData = JSON.parse(fileData);
        
        // Update cache
        this.cache.set(sessionId, stateData);
        
        this.log('State retrieved from file', {
          sessionId,
          region: stateData.region,
          age: Date.now() - stateData.timestamp
        });
        
        return stateData;
      } catch (fileError) {
        this.log('State not found', { sessionId });
        return null;
      }
    } catch (error) {
      this.log('Failed to get state', { 
        sessionId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Update state with optimistic locking
   */
  async updateState(sessionId, updateData, expectedVersion) {
    try {
      const currentState = await this.getState(sessionId);
      
      if (!currentState) {
        // Create new state
        return await this.saveState(sessionId, updateData, { version: 1 });
      }

      if (expectedVersion && currentState.version !== expectedVersion) {
        const error = new Error('Version conflict - state was modified by another process');
        error.code = 'VERSION_CONFLICT';
        error.currentVersion = currentState.version;
        error.expectedVersion = expectedVersion;
        throw error;
      }

      // Merge updates
      const mergedData = {
        ...currentState.data,
        ...updateData
      };

      const result = await this.saveState(sessionId, mergedData, { 
        version: currentState.version + 1 
      });

      // Emit state_updated event
      this.emitEvent('state_updated', {
        sessionId,
        previousVersion: currentState.version,
        newVersion: result.version,
        updateData,
        action: 'update'
      });

      return result;
    } catch (error) {
      this.log('Failed to update state', { 
        sessionId, 
        error: error.message,
        code: error.code
      });
      throw error;
    }
  }

  /**
   * Delete state
   */
  async deleteState(sessionId) {
    try {
      // Remove from cache
      this.cache.delete(sessionId);

      // Remove file
      const filePath = path.join(this.cacheDir, `${sessionId}.json`);
      try {
        await fs.unlink(filePath);
      } catch (fileError) {
        // File might not exist, ignore
      }

      this.log('State deleted', { sessionId });
      return true;
    } catch (error) {
      this.log('Failed to delete state', { 
        sessionId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * List all sessions
   */
  async listSessions() {
    try {
      const files = await fs.readdir(this.cacheDir);
      const sessions = files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''));

      this.log('Sessions listed', { count: sessions.length });
      return sessions;
    } catch (error) {
      this.log('Failed to list sessions', { error: error.message });
      return [];
    }
  }

  /**
   * Get sync statistics
   */
  getSyncStats() {
    return {
      region: this.region,
      nodeId: this.nodeId,
      cacheSize: this.cache.size,
      cacheDir: this.cacheDir,
      uptime: process.uptime(),
      timestamp: Date.now()
    };
  }

  /**
   * Get current live state for all sessions
   */
  getLiveState() {
    const sessions = {};
    for (const [sessionId, stateData] of this.cache.entries()) {
      sessions[sessionId] = {
        sessionId: stateData.sessionId,
        timestamp: stateData.timestamp,
        version: stateData.version,
        region: stateData.region,
        nodeId: stateData.nodeId,
        dataSize: JSON.stringify(stateData.data).length
      };
    }
    return {
      region: this.region,
      nodeId: this.nodeId,
      sessions,
      totalSessions: this.cache.size,
      timestamp: Date.now()
    };
  }

  /**
   * Event subscription system
   */
  onEvent(eventType, callback) {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set());
    }
    this.eventListeners.get(eventType).add(callback);
    
    this.log('Event listener registered', { eventType });
    
    // Return unsubscribe function
    return () => {
      const listeners = this.eventListeners.get(eventType);
      if (listeners) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this.eventListeners.delete(eventType);
        }
      }
    };
  }

  /**
   * Emit event to all listeners
   */
  emitEvent(eventType, data) {
    const listeners = this.eventListeners.get(eventType);
    if (listeners && listeners.size > 0) {
      this.log('Emitting event', { eventType, listenerCount: listeners.size });
      for (const callback of listeners) {
        try {
          callback(data);
        } catch (error) {
          this.log('Event callback error', { eventType, error: error.message });
        }
      }
    }
  }

  /**
   * Sync with remote region via HTTP
   */
  async syncWithRemoteRegion(remoteUrl, sessionId) {
    try {
      const localState = await this.getState(sessionId);
      if (!localState) {
        this.log('No local state to sync', { sessionId });
        return null;
      }

      this.log('Starting cross-region sync', {
        sessionId,
        remoteUrl,
        localVersion: localState.version,
        localRegion: this.region
      });

      // Attempt HTTP sync with remote region (using Node.js 18+ built-in fetch)
      const response = await fetch(`${remoteUrl}/state/receive/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localState),
        timeout: 5000
      });

      if (!response.ok) {
        throw new Error(`Remote sync failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      this.log('Cross-region sync completed', {
        sessionId,
        remoteUrl,
        action: result.action,
        success: result.success
      });

      return result;
    } catch (error) {
      this.log('Failed to sync with remote region', { 
        sessionId, 
        remoteUrl, 
        error: error.message 
      });
      throw error;
    }
  }
}

module.exports = SimpleStateSync;