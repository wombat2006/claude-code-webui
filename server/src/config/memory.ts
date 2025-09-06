import { logger } from './logger';

interface MemoryConfig {
  maxOldSpaceSize: number; // MB
  maxSemiSpaceSize: number; // MB
  gcInterval: number; // seconds
  memoryThreshold: number; // percentage
}

export class MemoryManager {
  private config: MemoryConfig;
  private gcTimer?: NodeJS.Timeout;
  private lastGC: number = 0;

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = {
      maxOldSpaceSize: parseInt(process.env.NODE_MAX_OLD_SPACE_SIZE || '256'), // Reduced for low memory
      maxSemiSpaceSize: parseInt(process.env.NODE_MAX_SEMI_SPACE_SIZE || '16'), // Reduced
      gcInterval: parseInt(process.env.GC_INTERVAL || '30'), // 30 seconds
      memoryThreshold: parseInt(process.env.MEMORY_THRESHOLD || '80'), // 80%
      ...config
    };

    this.setupMemoryMonitoring();
    this.setupGarbageCollection();
  }

  private setupMemoryMonitoring(): void {
    // Monitor memory every 10 seconds
    setInterval(() => {
      const usage = process.memoryUsage();
      const totalMemory = this.getTotalMemory();
      
      const memoryPercent = (usage.rss / totalMemory) * 100;
      
      if (memoryPercent > this.config.memoryThreshold) {
        logger.warn('High memory usage detected', {
          rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
          external: `${Math.round(usage.external / 1024 / 1024)}MB`,
          percentage: `${memoryPercent.toFixed(1)}%`
        });

        // Force garbage collection if available
        this.forceGC();
      }
    }, 10000);
  }

  private setupGarbageCollection(): void {
    // Periodic garbage collection
    this.gcTimer = setInterval(() => {
      this.forceGC();
    }, this.config.gcInterval * 1000);
  }

  private forceGC(): void {
    const now = Date.now();
    
    // Prevent too frequent GC calls
    if (now - this.lastGC < 5000) return;
    
    if (global.gc) {
      try {
        const before = process.memoryUsage();
        global.gc();
        const after = process.memoryUsage();
        
        this.lastGC = now;
        
        const freed = (before.heapUsed - after.heapUsed) / 1024 / 1024;
        if (freed > 1) { // Only log if significant memory was freed
          logger.info('Garbage collection completed', {
            freed: `${freed.toFixed(1)}MB`,
            heapBefore: `${Math.round(before.heapUsed / 1024 / 1024)}MB`,
            heapAfter: `${Math.round(after.heapUsed / 1024 / 1024)}MB`
          });
        }
      } catch (error) {
        logger.error('Garbage collection failed', error);
      }
    }
  }

  private getTotalMemory(): number {
    try {
      const fs = require('fs');
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const match = meminfo.match(/MemTotal:\s*(\d+)/);
      return match ? parseInt(match[1]) * 1024 : 2 * 1024 * 1024 * 1024; // Default 2GB
    } catch {
      return 2 * 1024 * 1024 * 1024; // Default 2GB
    }
  }

  public getMemoryStats(): any {
    const usage = process.memoryUsage();
    const totalMemory = this.getTotalMemory();
    
    return {
      process: {
        rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
        external: `${Math.round(usage.external / 1024 / 1024)}MB`,
        arrayBuffers: `${Math.round(usage.arrayBuffers / 1024 / 1024)}MB`
      },
      system: {
        total: `${Math.round(totalMemory / 1024 / 1024)}MB`,
        percentage: `${((usage.rss / totalMemory) * 100).toFixed(1)}%`
      },
      config: this.config,
      lastGC: new Date(this.lastGC).toISOString()
    };
  }

  public cleanup(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
    }
  }
}

// Export singleton instance
export const memoryManager = new MemoryManager();