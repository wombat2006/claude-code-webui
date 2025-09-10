import { spawn } from 'child_process';
import logger from '../config/logger';
import { RedisClientType } from 'redis';
import { getRedis } from './redis';
import * as fs from 'fs';
import * as path from 'path';

interface Context7CacheConfig {
  cacheDir?: string;
  ttl?: number; // Time to live in seconds
  maxLibraries?: number;
  useMemoryCache?: boolean; // Use in-memory cache instead of Redis for low memory systems
}

interface LibraryMetadata {
  id: string;
  name: string;
  version?: string;
  description?: string;
  lastUpdated: number;
}

export class Context7Cache {
  private redis: RedisClientType;
  private ttl: number;
  private maxLibraries: number;
  private isConnected: boolean = false;

  constructor(config: Context7CacheConfig = {}) {
    this.redis = null as any; // Will be initialized in init()
    this.ttl = config.ttl || 3600; // 1 hour default
    this.maxLibraries = config.maxLibraries || 1000;
    this.init();
  }

  private async init() {
    try {
      this.redis = await getRedis();
      this.isConnected = true;
      logger.info('Context7Cache: Redis connection established');
    } catch (error) {
      logger.error('Context7Cache: Redis connection failed', error instanceof Error ? error : new Error(String(error)));
      this.isConnected = false;
    }
  }

  private getCacheKey(type: 'library-list' | 'library-docs', query: string): string {
    return `context7:${type}:${Buffer.from(query).toString('base64')}`;
  }

  async searchLibraries(query: string): Promise<LibraryMetadata[]> {
    if (!this.isConnected) {
      return this.directSearchLibraries(query);
    }

    const cacheKey = this.getCacheKey('library-list', query);
    
    try {
      // Try to get from cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        logger.debug(`Context7 Cache: Cache hit for library search: ${query}`);
        return JSON.parse(cached as string);
      }

      // Cache miss, perform direct search
      const results = await this.directSearchLibraries(query);
      
      // Cache the results
      if (results.length > 0) {
        await this.redis.setEx(cacheKey, this.ttl, JSON.stringify(results));
        logger.debug(`Context7 Cache: Cached library search results for: ${query}`);
      }
      
      return results;
    } catch (error) {
      logger.error('Context7 Cache: Error in searchLibraries', error instanceof Error ? error : new Error(String(error)));
      // Fallback to direct search
      return this.directSearchLibraries(query);
    }
  }

  async getLibraryDocs(libraryId: string): Promise<any> {
    if (!this.isConnected) {
      return this.directGetLibraryDocs(libraryId);
    }

    const cacheKey = this.getCacheKey('library-docs', libraryId);
    
    try {
      // Try to get from cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        logger.debug(`Context7 Cache: Cache hit for library docs: ${libraryId}`);
        return JSON.parse(cached as string);
      }

      // Cache miss, fetch directly
      const docs = await this.directGetLibraryDocs(libraryId);
      
      // Cache the documentation
      if (docs) {
        await this.redis.setEx(cacheKey, this.ttl, JSON.stringify(docs));
        logger.debug(`Context7 Cache: Cached library docs for: ${libraryId}`);
      }
      
      return docs;
    } catch (error) {
      logger.error('Context7 Cache: Error in getLibraryDocs', error instanceof Error ? error : new Error(String(error)));
      // Fallback to direct fetch
      return this.directGetLibraryDocs(libraryId);
    }
  }

  private async directSearchLibraries(query: string): Promise<LibraryMetadata[]> {
    return this.callContext7({
      type: 'search-libraries',
      query,
      maxResults: this.maxLibraries
    });
  }

  private async directGetLibraryDocs(libraryId: string): Promise<any> {
    return this.callContext7({
      type: 'get-library-docs',
      libraryId
    });
  }

  private async callContext7(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn('context7', ['--json'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout);
            resolve(result);
          } catch (parseError) {
            logger.error('Context7 Cache: Failed to parse Context7 response', parseError instanceof Error ? parseError : new Error(String(parseError)));
            resolve(null);
          }
        } else {
          logger.error('Context7 Cache: Context7 process error', new Error(`Context7 process failed (code: ${code}): ${stderr}`));
          reject(new Error(`Context7 process failed: ${stderr}`));
        }
      });

      // Send the request
      child.stdin.write(JSON.stringify(request) + '\n');
      child.stdin.end();
    });
  }

  async clearCache(): Promise<void> {
    if (!this.isConnected) return;
    
    try {
      const keys = await this.redis.keys('context7:*');
      if (keys.length > 0) {
        await this.redis.del(keys);
        logger.info(`Context7 Cache: Cleared ${keys.length} cache entries`);
      }
    } catch (error) {
      logger.error('Context7 Cache: Error clearing cache', error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getCacheStats(): Promise<any> {
    if (!this.isConnected) return { connected: false };
    
    try {
      const keys = await this.redis.keys('context7:*');
      const libraryListKeys = keys.filter(k => k.includes(':library-list:'));
      const libraryDocsKeys = keys.filter(k => k.includes(':library-docs:'));
      
      return {
        connected: true,
        totalKeys: keys.length,
        libraryListEntries: libraryListKeys.length,
        libraryDocsEntries: libraryDocsKeys.length,
        ttl: this.ttl
      };
    } catch (error) {
      logger.error('Context7 Cache: Error getting cache stats', error instanceof Error ? error : new Error(String(error)));
      return { connected: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async disconnect(): Promise<void> {
    if (this.isConnected && this.redis) {
      try {
        await this.redis.quit();
        this.isConnected = false;
        logger.info('Context7 Cache: Disconnected from Redis');
      } catch (error) {
        logger.error('Context7 Cache: Error disconnecting from Redis', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}