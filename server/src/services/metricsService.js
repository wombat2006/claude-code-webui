const os = require('os');
const fs = require('fs').promises;
const path = require('path');

class MetricsService {
  constructor(io) {
    this.io = io;
    this.dataDir = path.join(__dirname, '../../../data');
    this.metricsFile = path.join(this.dataDir, 'metrics.json');
    this.sessionsDir = path.join(this.dataDir, 'sessions');
    
    this.metrics = {
      session: new Map(), // per session metrics
      daily: {
        requests: 0,
        tokens: 0,
        cost: 0,
        date: new Date().toDateString()
      },
      llmModels: new Map(),
      rag: {
        totalSearches: 0,
        successfulRetrievals: 0,
        totalProcessingTime: 0,
        averageLatency: 0,
        hitRate: 0,
        lastSearch: null,
        date: new Date().toDateString()
      },
      systemStats: {
        lastUpdate: null
      }
    };
    
    this.systemStatsInterval = null;
    this.init();
  }

  async init() {
    await this.ensureDirectories();
    await this.loadMetrics();
    this.startSystemMonitoring();
    this.startPeriodicCleanup();
    console.log('Metrics service initialized with /data storage');
  }

  async ensureDirectories() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.mkdir(this.sessionsDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create directories:', error);
    }
  }

  async loadMetrics() {
    try {
      const data = await fs.readFile(this.metricsFile, 'utf8');
      const savedMetrics = JSON.parse(data);
      
      // Restore daily metrics if same date
      if (savedMetrics.daily && savedMetrics.daily.date === new Date().toDateString()) {
        this.metrics.daily = savedMetrics.daily;
      }
      
      // Restore LLM model health
      if (savedMetrics.llmModels) {
        this.metrics.llmModels = new Map(Object.entries(savedMetrics.llmModels));
      }
      
      // Restore RAG metrics if same date
      if (savedMetrics.rag && savedMetrics.rag.date === new Date().toDateString()) {
        this.metrics.rag = savedMetrics.rag;
      }
      
      console.log('Metrics loaded from /data/metrics.json');
    } catch (error) {
      console.log('No existing metrics found, starting fresh');
    }
  }

  async saveMetrics() {
    try {
      const dataToSave = {
        daily: this.metrics.daily,
        llmModels: Object.fromEntries(this.metrics.llmModels),
        rag: this.metrics.rag,
        lastSaved: new Date().toISOString()
      };
      
      await fs.writeFile(this.metricsFile, JSON.stringify(dataToSave, null, 2));
    } catch (error) {
      console.error('Failed to save metrics:', error);
    }
  }

  startSystemMonitoring() {
    // Low-frequency system monitoring (every 30 seconds by default)
    this.systemStatsInterval = setInterval(() => {
      this.collectSystemStats();
    }, 30000);
  }

  collectSystemStats() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    const stats = {
      rss: Math.round(memUsage.rss / 1024 / 1024), // MB
      heap: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      cpu: this.getCPUPercent(cpuUsage),
      memory: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024), // MB
      uptime: Math.round(process.uptime()),
      lastUpdated: new Date().toLocaleTimeString()
    };

    this.metrics.systemStats = stats;

    // Broadcast to all connected clients
    this.io.emit('metrics:system', stats);
  }

  getCPUPercent(cpuUsage) {
    // Simple CPU usage approximation
    const totalUsage = cpuUsage.user + cpuUsage.system;
    return Math.round((totalUsage / 1000000) * 100) / 100; // Convert microseconds to percentage
  }

  // Event-driven metric collection
  async recordLLMRequest(sessionId, data) {
    const { model, tokens, cost, latency, success } = data;
    
    // Update session metrics
    if (!this.metrics.session.has(sessionId)) {
      this.metrics.session.set(sessionId, {
        requests: 0,
        tokens: 0,
        cost: 0,
        startTime: Date.now(),
        lastActivity: Date.now()
      });
    }
    
    const sessionMetrics = this.metrics.session.get(sessionId);
    sessionMetrics.requests += 1;
    sessionMetrics.tokens += tokens || 0;
    sessionMetrics.cost += cost || 0;
    sessionMetrics.lastActivity = Date.now();

    // Save session metrics to /data/sessions/
    await this.saveSessionMetrics(sessionId, sessionMetrics);

    // Update daily metrics
    const today = new Date().toDateString();
    if (this.metrics.daily.date !== today) {
      this.metrics.daily = { requests: 0, tokens: 0, cost: 0, date: today };
    }
    
    this.metrics.daily.requests += 1;
    this.metrics.daily.tokens += tokens || 0;
    this.metrics.daily.cost += cost || 0;

    // Update LLM model health
    this.updateLLMHealth(model, { success, latency });

    // Save metrics periodically
    await this.saveMetrics();

    // Emit event-driven update
    this.io.emit('metrics:llm_complete', {
      tokens: tokens || 0,
      cost: cost || 0,
      latency,
      model,
      success
    });
  }

  async saveSessionMetrics(sessionId, metrics) {
    try {
      const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
      await fs.writeFile(sessionFile, JSON.stringify({
        ...metrics,
        sessionId,
        updatedAt: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      console.error(`Failed to save session metrics for ${sessionId}:`, error);
    }
  }

  async recordRAGSearch(sessionId, data) {
    const { query, results, processingTime } = data;
    const hasResults = results && results.length > 0;
    
    // Update RAG metrics for current date
    const today = new Date().toDateString();
    if (this.metrics.rag.date !== today) {
      // Reset metrics for new day
      this.metrics.rag = {
        totalSearches: 0,
        successfulRetrievals: 0,
        totalProcessingTime: 0,
        averageLatency: 0,
        hitRate: 0,
        lastSearch: null,
        date: today
      };
    }
    
    // Update aggregated stats
    this.metrics.rag.totalSearches += 1;
    if (hasResults) {
      this.metrics.rag.successfulRetrievals += 1;
    }
    this.metrics.rag.totalProcessingTime += processingTime || 0;
    this.metrics.rag.averageLatency = Math.round(this.metrics.rag.totalProcessingTime / this.metrics.rag.totalSearches);
    this.metrics.rag.hitRate = Math.round((this.metrics.rag.successfulRetrievals / this.metrics.rag.totalSearches) * 100);
    this.metrics.rag.lastSearch = new Date().toLocaleTimeString();
    
    // Save metrics
    await this.saveMetrics();
    
    // Emit real-time event
    this.io.emit('metrics:rag_search', {
      results: results ? results.length : 0,
      processingTime,
      hasResults
    });
    
    // Emit updated aggregate stats
    this.io.emit('metrics:rag_update', {
      totalSearches: this.metrics.rag.totalSearches,
      hits: this.metrics.rag.successfulRetrievals,
      hitRate: this.metrics.rag.hitRate,
      averageLatency: this.metrics.rag.averageLatency,
      lastSearch: this.metrics.rag.lastSearch
    });
  }

  updateLLMHealth(model, data) {
    const { success, latency } = data;
    
    if (!this.metrics.llmModels.has(model)) {
      this.metrics.llmModels.set(model, {
        status: 'unknown',
        lastLatency: 0,
        successCount: 0,
        failureCount: 0,
        lastCheck: null
      });
    }
    
    const modelHealth = this.metrics.llmModels.get(model);
    const oldStatus = modelHealth.status;
    
    if (success) {
      modelHealth.successCount += 1;
      modelHealth.lastLatency = latency;
    } else {
      modelHealth.failureCount += 1;
    }
    
    // Determine health status
    const totalRequests = modelHealth.successCount + modelHealth.failureCount;
    const successRate = modelHealth.successCount / totalRequests;
    
    let newStatus;
    if (successRate >= 0.95) {
      newStatus = 'healthy';
    } else if (successRate >= 0.8) {
      newStatus = 'degraded';
    } else {
      newStatus = 'unhealthy';
    }
    
    modelHealth.status = newStatus;
    modelHealth.lastCheck = new Date().toLocaleTimeString();
    
    // Only emit if status changed (event-driven)
    if (oldStatus !== newStatus) {
      this.io.emit('metrics:llm_health', {
        model,
        status: newStatus,
        latency: modelHealth.lastLatency,
        successRate: Math.round(successRate * 100)
      });
    }
  }

  // Handle manual system stats request
  handleSystemStatsRequest(socket) {
    if (this.metrics.systemStats.lastUpdate) {
      socket.emit('metrics:system', this.metrics.systemStats);
    } else {
      // Collect stats on-demand
      this.collectSystemStats();
    }
  }

  // Get all metrics for dashboard initialization
  async getMetrics() {
    // Reload from file to get latest data
    await this.loadMetrics();
    
    return {
      daily: this.metrics.daily,
      llmModels: Object.fromEntries(this.metrics.llmModels),
      systemStats: this.metrics.systemStats,
      rag: this.metrics.rag
    };
  }

  getMetricsSummary(sessionId) {
    const sessionMetrics = this.metrics.session.get(sessionId) || {
      requests: 0,
      tokens: 0,
      cost: 0
    };
    
    return {
      session: sessionMetrics,
      daily: this.metrics.daily,
      system: this.metrics.systemStats,
      llmModels: Object.fromEntries(this.metrics.llmModels)
    };
  }

  // Clean up old session files (older than 24 hours)
  async cleanupOldSessions() {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const now = Date.now();
      const dayInMs = 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        const filePath = path.join(this.sessionsDir, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtime.getTime() > dayInMs) {
          await fs.unlink(filePath);
          console.log(`Cleaned up old session file: ${file}`);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old sessions:', error);
    }
  }

  // Start periodic cleanup (every 6 hours)
  startPeriodicCleanup() {
    setInterval(() => {
      this.cleanupOldSessions();
    }, 6 * 60 * 60 * 1000);
  }

  async cleanup() {
    if (this.systemStatsInterval) {
      clearInterval(this.systemStatsInterval);
    }
    
    // Save final metrics before shutdown
    await this.saveMetrics();
    console.log('Metrics service cleaned up and saved to /data');
  }
}

module.exports = MetricsService;