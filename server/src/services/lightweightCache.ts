import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../config/logger';

interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

interface LightweightCacheConfig {
  cacheDir?: string;
  maxMemoryEntries?: number;
  maxFileSize?: number; // MB
  cleanupInterval?: number; // seconds
}

export class LightweightCache {
  private memoryCache: Map<string, CacheEntry> = new Map();
  private cacheDir: string;
  private maxMemoryEntries: number;
  private maxFileSize: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: LightweightCacheConfig = {}) {
    this.cacheDir = config.cacheDir || path.join(process.cwd(), '.cache');
    this.maxMemoryEntries = config.maxMemoryEntries || 50; // Very low for memory-constrained systems
    this.maxFileSize = (config.maxFileSize || 1) * 1024 * 1024; // 1MB default
    
    this.ensureCacheDir();
    this.startCleanup(config.cleanupInterval || 300); // 5 minutes
  }

  private ensureCacheDir(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (error) {
      logger.error('Failed to create cache directory', error);
    }
  }

  private startCleanup(interval: number): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, interval * 1000);
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    // Clean memory cache
    for (const [key, entry] of this.memoryCache.entries()) {
      if (now - entry.timestamp > entry.ttl * 1000) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }

    // Clean file cache
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (!file.endsWith('.cache')) continue;
        
        const filePath = path.join(this.cacheDir, file);
        const stats = fs.statSync(filePath);
        
        // Check if file is older than 1 hour (default TTL)
        if (now - stats.mtime.getTime() > 3600 * 1000) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }
    } catch (error) {
      logger.error('Cache cleanup failed', error);
    }

    if (cleaned > 0) {
      logger.info(`Cache cleanup: removed ${cleaned} expired entries`);
    }
  }

  private getFilePath(key: string): string {
    const hash = Buffer.from(key).toString('base64').replace(/[/+=]/g, '_');
    return path.join(this.cacheDir, `${hash}.cache`);
  }

  async get(key: string): Promise<any> {
    // Try memory cache first
    const memEntry = this.memoryCache.get(key);
    if (memEntry) {
      const now = Date.now();
      if (now - memEntry.timestamp < memEntry.ttl * 1000) {
        logger.debug(`Memory cache hit: ${key}`);
        return memEntry.data;
      } else {
        this.memoryCache.delete(key);
      }
    }

    // Try file cache
    try {
      const filePath = this.getFilePath(key);
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const now = Date.now();
        
        // Check TTL (default 1 hour for files)
        if (now - stats.mtime.getTime() < 3600 * 1000) {
          const content = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(content);
          
          // Move to memory cache if there's space
          if (this.memoryCache.size < this.maxMemoryEntries) {
            this.memoryCache.set(key, {
              data,
              timestamp: now,
              ttl: 3600 // 1 hour
            });
          }
          
          logger.debug(`File cache hit: ${key}`);
          return data;
        } else {
          // File expired, remove it
          fs.unlinkSync(filePath);
        }
      }
    } catch (error) {
      logger.error(`Cache read error for key ${key}:`, error);
    }

    return null;
  }

  async set(key: string, data: any, ttl: number = 3600): Promise<void> {
    const now = Date.now();
    
    try {
      // Store in memory if space available
      if (this.memoryCache.size < this.maxMemoryEntries) {
        this.memoryCache.set(key, {
          data,
          timestamp: now,
          ttl
        });
        logger.debug(`Memory cache set: ${key}`);
      } else {
        // Store in file system for larger/less frequently used items
        const filePath = this.getFilePath(key);
        const content = JSON.stringify(data);
        
        // Check file size limit
        if (Buffer.byteLength(content, 'utf8') <= this.maxFileSize) {
          fs.writeFileSync(filePath, content, 'utf8');
          logger.debug(`File cache set: ${key}`);
        } else {
          logger.warn(`Cache entry too large for key ${key}, skipping`);
        }
      }
    } catch (error) {
      logger.error(`Cache write error for key ${key}:`, error);
    }
  }

  async delete(key: string): Promise<void> {
    this.memoryCache.delete(key);
    
    try {
      const filePath = this.getFilePath(key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      logger.error(`Cache delete error for key ${key}:`, error);
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.cache')) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      logger.info('Cache cleared successfully');
    } catch (error) {
      logger.error('Cache clear error:', error);
    }
  }

  getStats(): any {
    let fileCacheCount = 0;
    let fileCacheSize = 0;
    
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.cache')) {
          fileCacheCount++;
          const stats = fs.statSync(path.join(this.cacheDir, file));
          fileCacheSize += stats.size;
        }
      }
    } catch (error) {
      logger.error('Error getting cache stats:', error);
    }

    return {
      memoryEntries: this.memoryCache.size,
      maxMemoryEntries: this.maxMemoryEntries,
      fileCacheEntries: fileCacheCount,
      fileCacheSize: `${Math.round(fileCacheSize / 1024)}KB`,
      cacheDir: this.cacheDir
    };
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.memoryCache.clear();
  }
}