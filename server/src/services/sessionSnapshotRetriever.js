/**
 * Session Snapshot Retriever
 * Implements lightweight search and retrieval for Session Snapshots
 * Based on O3 design: local file-based search with structured queries
 */

const fs = require('fs').promises;
const path = require('path');

class SessionSnapshotRetriever {
  constructor(options = {}) {
    this.snapshotDir = options.snapshotDir || '/tmp/claude-snapshots';
    this.cacheDir = options.cacheDir || '/tmp/claude-snapshot-index';
    this.cache = new Map();
    this.maxCacheSize = options.maxCacheSize || 100;
    this.cacheTtl = options.cacheTtl || 300000; // 5 minutes
    
    this.log = (message, data = {}) => {
      console.log(`[SnapshotRetriever ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    this.initializeCache();
  }

  async initializeCache() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      this.log('Snapshot retriever initialized', {
        snapshotDir: this.snapshotDir,
        cacheDir: this.cacheDir
      });
    } catch (error) {
      this.log('Failed to initialize cache directory', { error: error.message });
    }
  }

  /**
   * Retrieve last N snapshots for a session
   */
  async getLastSnapshots(sessionId, count = 5) {
    try {
      this.log('Retrieving last snapshots', { sessionId, count });

      const snapshots = await this.findSnapshotsBySession(sessionId);
      
      // Sort by timestamp (newest first)
      snapshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      const result = snapshots.slice(0, count);
      
      this.log('Retrieved snapshots', {
        sessionId,
        found: result.length,
        requested: count
      });

      return result;
    } catch (error) {
      this.log('Failed to retrieve snapshots', {
        sessionId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Find snapshots by session ID
   */
  async findSnapshotsBySession(sessionId) {
    try {
      const files = await fs.readdir(this.snapshotDir);
      const sessionFiles = files.filter(file => 
        file.startsWith(`${sessionId}_`) && file.endsWith('.json')
      );

      const snapshots = [];
      for (const file of sessionFiles) {
        try {
          const snapshot = await this.loadSnapshot(path.join(this.snapshotDir, file));
          if (snapshot) {
            snapshots.push(snapshot);
          }
        } catch (error) {
          this.log('Failed to load snapshot file', { file, error: error.message });
        }
      }

      return snapshots;
    } catch (error) {
      this.log('Failed to scan snapshot directory', { error: error.message });
      return [];
    }
  }

  /**
   * Load and parse snapshot from file with caching
   */
  async loadSnapshot(filePath) {
    const cacheKey = filePath;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.loadedAt < this.cacheTtl) {
      return cached.snapshot;
    }

    try {
      const data = await fs.readFile(filePath, 'utf8');
      const snapshot = JSON.parse(data);
      
      // Cache the snapshot
      this.cache.set(cacheKey, {
        snapshot,
        loadedAt: Date.now()
      });
      
      // Maintain cache size
      if (this.cache.size > this.maxCacheSize) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }
      
      return snapshot;
    } catch (error) {
      this.log('Failed to load snapshot', { filePath, error: error.message });
      return null;
    }
  }

  /**
   * Search snapshots by criteria
   */
  async searchSnapshots(criteria = {}) {
    try {
      const {
        sessionId,
        projectId,
        triggerEvent,
        exitCode,
        timeRange,
        maxResults = 20
      } = criteria;

      this.log('Searching snapshots', criteria);

      let snapshots = [];

      if (sessionId) {
        // Session-specific search
        snapshots = await this.findSnapshotsBySession(sessionId);
      } else {
        // Global search
        snapshots = await this.loadAllSnapshots();
      }

      // Apply filters
      let filtered = snapshots;

      if (projectId) {
        filtered = filtered.filter(s => s.projectId === projectId);
      }

      if (triggerEvent) {
        filtered = filtered.filter(s => s.triggerEvent === triggerEvent);
      }

      if (exitCode !== undefined) {
        filtered = filtered.filter(s => 
          s.context?.execution?.exitCode === exitCode
        );
      }

      if (timeRange) {
        const { start, end } = timeRange;
        filtered = filtered.filter(s => {
          const timestamp = new Date(s.timestamp);
          return timestamp >= new Date(start) && timestamp <= new Date(end);
        });
      }

      // Sort by timestamp (newest first)
      filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      const result = filtered.slice(0, maxResults);

      this.log('Search completed', {
        total: snapshots.length,
        filtered: filtered.length,
        returned: result.length
      });

      return result;
    } catch (error) {
      this.log('Search failed', { error: error.message });
      return [];
    }
  }

  /**
   * Load all snapshots (with caching)
   */
  async loadAllSnapshots() {
    try {
      const files = await fs.readdir(this.snapshotDir);
      const snapshotFiles = files.filter(file => file.endsWith('.json'));

      const snapshots = [];
      for (const file of snapshotFiles) {
        const snapshot = await this.loadSnapshot(path.join(this.snapshotDir, file));
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }

      return snapshots;
    } catch (error) {
      this.log('Failed to load all snapshots', { error: error.message });
      return [];
    }
  }

  /**
   * Find error patterns - identify failed commands and their context
   */
  async findErrorPatterns(sessionId = null, limit = 10) {
    try {
      const criteria = {
        sessionId,
        exitCode: 1, // Non-zero exit codes
        maxResults: limit * 2 // Get more to analyze patterns
      };

      const errorSnapshots = await this.searchSnapshots(criteria);
      
      const patterns = errorSnapshots.map(snapshot => ({
        sessionId: snapshot.sessionId,
        timestamp: snapshot.timestamp,
        command: snapshot.context?.execution?.command,
        stderr: snapshot.context?.execution?.stderr,
        exitCode: snapshot.context?.execution?.exitCode,
        fileChanges: snapshot.context?.fileSystem?.lastChangedFile,
        triggerEvent: snapshot.triggerEvent
      }));

      this.log('Found error patterns', {
        sessionId,
        errors: patterns.length,
        limit
      });

      return patterns.slice(0, limit);
    } catch (error) {
      this.log('Failed to find error patterns', { error: error.message });
      return [];
    }
  }

  /**
   * Get session context for LLM prompt construction
   */
  async getSessionContext(sessionId, contextType = 'recent') {
    try {
      let snapshots = [];
      
      switch (contextType) {
        case 'recent':
          snapshots = await this.getLastSnapshots(sessionId, 5);
          break;
        case 'errors':
          snapshots = await this.findErrorPatterns(sessionId, 5);
          break;
        case 'commands':
          snapshots = await this.searchSnapshots({
            sessionId,
            triggerEvent: 'command_execution',
            maxResults: 10
          });
          break;
        default:
          snapshots = await this.getLastSnapshots(sessionId, 3);
      }

      // Build structured context for LLM
      const context = {
        sessionId,
        contextType,
        snapshotCount: snapshots.length,
        timeRange: snapshots.length > 0 ? {
          earliest: snapshots[snapshots.length - 1]?.timestamp,
          latest: snapshots[0]?.timestamp
        } : null,
        executionHistory: [],
        fileChanges: [],
        errorPatterns: []
      };

      snapshots.forEach(snapshot => {
        if (snapshot.context?.execution) {
          context.executionHistory.push({
            command: snapshot.context.execution.command,
            exitCode: snapshot.context.execution.exitCode,
            timestamp: snapshot.timestamp,
            duration: snapshot.context.execution.duration
          });
        }

        if (snapshot.context?.fileSystem?.lastChangedFile) {
          context.fileChanges.push({
            file: snapshot.context.fileSystem.lastChangedFile,
            timestamp: snapshot.timestamp
          });
        }

        if (snapshot.context?.execution?.exitCode !== 0) {
          context.errorPatterns.push({
            command: snapshot.context.execution.command,
            stderr: snapshot.context.execution.stderr,
            timestamp: snapshot.timestamp
          });
        }
      });

      this.log('Built session context', {
        sessionId,
        contextType,
        executionHistory: context.executionHistory.length,
        fileChanges: context.fileChanges.length,
        errorPatterns: context.errorPatterns.length
      });

      return context;
    } catch (error) {
      this.log('Failed to build session context', {
        sessionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Get retrieval statistics
   */
  getStats() {
    return {
      cacheSize: this.cache.size,
      maxCacheSize: this.maxCacheSize,
      cacheTtl: this.cacheTtl,
      snapshotDir: this.snapshotDir,
      timestamp: Date.now()
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    this.log('Cache cleared');
  }
}

module.exports = SessionSnapshotRetriever;