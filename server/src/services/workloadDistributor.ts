import { WorkerPool } from './workerPool';
import { logger } from '../config/logger';

export interface WorkloadConfig {
  mainVmRole: 'coordinator' | 'hybrid'; // coordinator: only routing, hybrid: light tasks + routing
  distributionStrategy: 'round-robin' | 'least-loaded' | 'capability-based';
  localThreshold: number; // Max concurrent local tasks when hybrid mode
  offloadEverything: boolean; // Offload all tasks to workers
}

export class WorkloadDistributor {
  private workerPool: WorkerPool;
  private config: WorkloadConfig;
  private localTaskCount: number = 0;

  constructor(workerPool: WorkerPool, config: Partial<WorkloadConfig> = {}) {
    this.workerPool = workerPool;
    this.config = {
      mainVmRole: process.env.MAIN_VM_ROLE as any || 'coordinator',
      distributionStrategy: process.env.DISTRIBUTION_STRATEGY as any || 'least-loaded',
      localThreshold: parseInt(process.env.LOCAL_THRESHOLD || '2'),
      offloadEverything: process.env.OFFLOAD_EVERYTHING === 'true',
      ...config
    };

    logger.info(`WorkloadDistributor initialized - Role: ${this.config.mainVmRole}, Strategy: ${this.config.distributionStrategy}`);
  }

  /**
   * Main distribution decision point for all workloads
   */
  async executeTask(taskType: string, payload: any, options: any = {}): Promise<any> {
    const shouldOffload = this.shouldOffloadTask(taskType, payload, options);
    
    if (shouldOffload) {
      logger.info(`Offloading ${taskType} to worker node`);
      return this.executeOnWorker(taskType, payload, options);
    } else {
      logger.info(`Executing ${taskType} locally`);
      return this.executeLocally(taskType, payload, options);
    }
  }

  private shouldOffloadTask(taskType: string, payload: any, options: any): boolean {
    // Force offload everything mode
    if (this.config.offloadEverything) {
      return true;
    }

    // Main VM is coordinator-only mode
    if (this.config.mainVmRole === 'coordinator') {
      return true;
    }

    // Hybrid mode logic
    if (this.config.mainVmRole === 'hybrid') {
      // Always offload heavy tasks
      if (this.isHeavyTask(taskType)) {
        return true;
      }

      // Offload if local threshold exceeded
      if (this.localTaskCount >= this.config.localThreshold) {
        return true;
      }

      // Offload based on system resources
      if (this.isSystemUnderPressure()) {
        return true;
      }
    }

    return false;
  }

  private isHeavyTask(taskType: string): boolean {
    const heavyTasks = [
      // MCP operations
      'context7', 'cipher', 'mcp-call',
      
      // AI operations  
      'llm-call', 'embedding', 'completion',
      
      // File operations
      'large-file-read', 'file-search', 'code-analysis',
      
      // Compute operations
      'compilation', 'testing', 'linting', 'build',
      
      // Data processing
      'json-processing', 'xml-parsing', 'data-transform',
      
      // Network operations
      'web-scraping', 'api-calls', 'download'
    ];

    return heavyTasks.some(heavy => taskType.includes(heavy));
  }

  private isSystemUnderPressure(): boolean {
    const usage = process.memoryUsage();
    const memoryUsage = (usage.rss / (1.8 * 1024 * 1024 * 1024)) * 100; // Assuming 1.8GB total
    
    return memoryUsage > 70; // Under pressure if > 70% memory usage
  }

  private async executeOnWorker(taskType: string, payload: any, options: any): Promise<any> {
    try {
      const timeout = options.timeout || 60000;
      const jobId = await this.workerPool.submitJob(taskType, payload, timeout);
      return await this.workerPool.waitForJob(jobId);
    } catch (error) {
      logger.error(`Worker execution failed for ${taskType}:`, error);
      
      // Fallback to local execution if enabled
      if (options.fallbackLocal !== false && this.config.mainVmRole === 'hybrid') {
        logger.warn(`Falling back to local execution for ${taskType}`);
        return this.executeLocally(taskType, payload, options);
      }
      
      throw error;
    }
  }

  private async executeLocally(taskType: string, payload: any, options: any): Promise<any> {
    this.localTaskCount++;
    
    try {
      // Route to appropriate local handler
      const result = await this.routeLocalTask(taskType, payload, options);
      return result;
    } finally {
      this.localTaskCount = Math.max(0, this.localTaskCount - 1);
    }
  }

  private async routeLocalTask(taskType: string, payload: any, options: any): Promise<any> {
    switch (taskType) {
      case 'health-check':
        return this.handleHealthCheck();
      
      case 'simple-query':
        return this.handleSimpleQuery(payload);
        
      case 'cache-operation':
        return this.handleCacheOperation(payload);
        
      case 'lightweight-file-read':
        return this.handleLightweightFileRead(payload);
        
      default:
        throw new Error(`Unknown local task type: ${taskType}`);
    }
  }

  private handleHealthCheck(): any {
    return {
      status: 'healthy',
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      localTasks: this.localTaskCount,
      role: this.config.mainVmRole
    };
  }

  private handleSimpleQuery(payload: any): any {
    // Handle simple, non-resource-intensive queries
    return { result: `Processed simple query: ${payload.query}` };
  }

  private handleCacheOperation(payload: any): any {
    // Handle lightweight cache operations
    return { success: true, operation: payload.operation };
  }

  private handleLightweightFileRead(payload: any): any {
    // Handle small file reads (< 1MB)
    const fs = require('fs');
    try {
      const content = fs.readFileSync(payload.path, 'utf8');
      if (content.length > 1024 * 1024) { // > 1MB
        throw new Error('File too large for local processing');
      }
      return { content };
    } catch (error) {
      throw new Error(`File read failed: ${error.message}`);
    }
  }

  // Convenience methods for common operations
  async executeContext7(operation: string, params: any): Promise<any> {
    return this.executeTask('context7', { operation, params });
  }

  async executeCipher(command: string, params: any): Promise<any> {
    return this.executeTask('cipher', { command, params });
  }

  async executeLLMCall(model: string, prompt: string, options: any = {}): Promise<any> {
    return this.executeTask('llm-call', { model, prompt, options });
  }

  async executeFileOperation(operation: string, path: string, options: any = {}): Promise<any> {
    const size = options.expectedSize || 0;
    const taskType = size > 1024 * 1024 ? 'large-file-read' : 'lightweight-file-read';
    return this.executeTask(taskType, { operation, path, options });
  }

  async executeCodeAnalysis(files: string[], analysisType: string): Promise<any> {
    return this.executeTask('code-analysis', { files, analysisType });
  }

  async executeBuildTask(buildType: string, params: any): Promise<any> {
    return this.executeTask('build', { buildType, params });
  }

  async executeWebRequest(url: string, options: any = {}): Promise<any> {
    return this.executeTask('api-calls', { url, options });
  }

  getStats(): any {
    const workerStats = this.workerPool.getStats();
    
    return {
      mainVm: {
        role: this.config.mainVmRole,
        localTasks: this.localTaskCount,
        localThreshold: this.config.localThreshold,
        memoryUsage: process.memoryUsage(),
        systemPressure: this.isSystemUnderPressure()
      },
      distribution: {
        strategy: this.config.distributionStrategy,
        offloadEverything: this.config.offloadEverything
      },
      workers: workerStats
    };
  }

  updateConfig(newConfig: Partial<WorkloadConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info(`WorkloadDistributor config updated:`, this.config);
  }
}

// Export singleton instance
export const workloadDistributor = new WorkloadDistributor(
  require('./workerPool').workerPool
);