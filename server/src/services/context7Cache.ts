import { spawn } from 'child_process';
import { logger } from '../config/logger';
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
  private redis: Redis;
  private ttl: number;
  private maxLibraries: number;
  private isConnected: boolean = false;

  constructor(config: Context7CacheConfig = {}) {
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
    this.ttl = config.ttl || 3600; // 1 hour default
    this.maxLibraries = config.maxLibraries || 1000;
    
    this.redis.on('connect', () => {
      this.isConnected = true;
      logger.info('Context7 Cache: Connected to Redis');
    });
    
    this.redis.on('error', (err) => {
      this.isConnected = false;
      logger.error('Context7 Cache: Redis error', err);
    });
  }

  private getCacheKey(type: 'library-list' | 'library-docs', query: string): string {
    return `context7:${type}:${Buffer.from(query).toString('base64')}`;
  }

  async getLibraryList(query?: string): Promise<LibraryMetadata[] | null> {
    if (!this.isConnected) return null;
    
    try {
      const cacheKey = this.getCacheKey('library-list', query || 'all');
      const cached = await this.redis.get(cacheKey);
      
      if (cached) {
        logger.info(`Context7 Cache: Library list cache hit for query: ${query}`);
        return JSON.parse(cached);
      }
      
      logger.info(`Context7 Cache: Library list cache miss for query: ${query}`);
      return null;
    } catch (error) {
      logger.error('Context7 Cache: Error getting library list from cache', error);
      return null;
    }
  }

  async cacheLibraryList(libraries: LibraryMetadata[], query?: string): Promise<void> {
    if (!this.isConnected) return;
    
    try {
      const cacheKey = this.getCacheKey('library-list', query || 'all');
      
      // Limit the number of libraries to cache
      const limitedLibraries = libraries.slice(0, this.maxLibraries);
      
      await this.redis.setex(cacheKey, this.ttl, JSON.stringify(limitedLibraries));
      logger.info(`Context7 Cache: Cached ${limitedLibraries.length} libraries for query: ${query}`);
    } catch (error) {
      logger.error('Context7 Cache: Error caching library list', error);
    }
  }

  async getLibraryDocs(libraryId: string): Promise<string | null> {
    if (!this.isConnected) return null;
    
    try {
      const cacheKey = this.getCacheKey('library-docs', libraryId);
      const cached = await this.redis.get(cacheKey);
      
      if (cached) {
        logger.info(`Context7 Cache: Library docs cache hit for: ${libraryId}`);
        return cached;
      }
      
      logger.info(`Context7 Cache: Library docs cache miss for: ${libraryId}`);
      return null;
    } catch (error) {
      logger.error('Context7 Cache: Error getting library docs from cache', error);
      return null;
    }
  }

  async cacheLibraryDocs(libraryId: string, docs: string): Promise<void> {
    if (!this.isConnected) return;
    
    try {
      const cacheKey = this.getCacheKey('library-docs', libraryId);
      
      // Cache docs for shorter time as they change more frequently
      const docsTtl = Math.floor(this.ttl / 2); // 30 minutes if ttl is 1 hour
      
      await this.redis.setex(cacheKey, docsTtl, docs);
      logger.info(`Context7 Cache: Cached docs for library: ${libraryId}`);
    } catch (error) {
      logger.error('Context7 Cache: Error caching library docs', error);
    }
  }

  async resolveLibraryId(query: string): Promise<any> {
    // Check cache first
    const cached = await this.getLibraryList(query);
    if (cached && cached.length > 0) {
      return cached.find(lib => 
        lib.name.toLowerCase().includes(query.toLowerCase()) ||
        lib.id.toLowerCase().includes(query.toLowerCase())
      );
    }

    // If not in cache, call Context7 directly
    return this.callContext7('resolve-library-id', { query });
  }

  async getLibraryDocumentation(libraryId: string): Promise<string> {
    // Check cache first
    const cached = await this.getLibraryDocs(libraryId);
    if (cached) {
      return cached;
    }

    // If not in cache, call Context7 directly
    const docs = await this.callContext7('get-library-docs', { libraryId });
    
    // Cache the result
    if (docs && typeof docs === 'string') {
      await this.cacheLibraryDocs(libraryId, docs);
    }
    
    return docs;
  }

  private async callContext7(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn('npx', ['--yes', '@upstash/context7-mcp'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const request = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: `tools/call`,
        params: {
          name: method,
          arguments: params
        }
      };

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
            const response = JSON.parse(stdout);
            resolve(response.result || response);
          } catch (error) {
            logger.error('Context7 Cache: Error parsing Context7 response', error);
            resolve(null);
          }
        } else {
          logger.error('Context7 Cache: Context7 process error', { code, stderr });
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
        await this.redis.del(...keys);
        logger.info(`Context7 Cache: Cleared ${keys.length} cache entries`);
      }
    } catch (error) {
      logger.error('Context7 Cache: Error clearing cache', error);
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
      logger.error('Context7 Cache: Error getting cache stats', error);
      return { connected: false, error: error.message };
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
    this.isConnected = false;
    logger.info('Context7 Cache: Disconnected from Redis');
  }
}

// Export singleton instance
export const context7Cache = new Context7Cache({
  ttl: parseInt(process.env.CONTEXT7_CACHE_TTL || '3600'),
  maxLibraries: parseInt(process.env.CONTEXT7_MAX_LIBRARIES || '1000')
});