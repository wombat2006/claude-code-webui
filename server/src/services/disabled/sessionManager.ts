import { distributedStateManager } from './distributedStateManager';
import { logger } from '../config/logger';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

interface SessionData {
  sessionId: string;
  userId: string;
  workingDirectory: string;
  currentFile?: string;
  commandHistory: string[];
  environmentVars: Record<string, string>;
  homeRegion: string;
  metadata?: Record<string, any>;
}

interface SessionUpdateOptions {
  optimisticUpdate?: boolean;
  retryOnConflict?: boolean;
  maxRetries?: number;
}

interface SessionConflictInfo {
  sessionId: string;
  expectedVersion: number;
  currentVersion: number;
  conflictType: 'version' | 'concurrent_update';
}

export class SessionManager extends EventEmitter {
  private localCache = new Map<string, { data: SessionData; version: number; lastAccess: number }>();
  private cacheTimeout = 30000; // 30 seconds cache TTL
  private region: string;
  private maxRetries = 3;
  private retryBackoffMs = 100;

  constructor() {
    super();
    this.region = process.env.AWS_REGION || 'us-east-1';
    
    // Start cache cleanup interval
    setInterval(() => {
      this.cleanupLocalCache();
    }, 60000); // Clean up every minute

    logger.info('SessionManager initialized');
  }

  async createSession(userId: string, workingDirectory: string = '/tmp'): Promise<SessionData> {
    const sessionId = uuidv4();
    const now = Date.now();
    
    const sessionData: SessionData = {
      sessionId,
      userId,
      workingDirectory,
      commandHistory: [],
      environmentVars: {
        HOME: workingDirectory,
        USER: userId,
        PWD: workingDirectory
      },
      homeRegion: this.region
    };

    try {
      const saved = await distributedStateManager.saveSession({
        ...sessionData,
        createdAt: now,
        updatedAt: now,
        version: 1
      });

      // Cache locally
      this.localCache.set(sessionId, {
        data: sessionData,
        version: saved.version,
        lastAccess: Date.now()
      });

      this.emit('sessionCreated', sessionData);
      logger.info(`Session created: ${sessionId} for user: ${userId}`);
      
      return sessionData;
    } catch (error) {
      logger.error(`Failed to create session for user ${userId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async getSession(sessionId: string, useCache = true): Promise<SessionData | null> {
    try {
      // Check local cache first if enabled
      if (useCache && this.localCache.has(sessionId)) {
        const cached = this.localCache.get(sessionId)!;
        if (Date.now() - cached.lastAccess < this.cacheTimeout) {
          cached.lastAccess = Date.now();
          return cached.data;
        } else {
          this.localCache.delete(sessionId);
        }
      }

      // Fetch from DynamoDB
      const sessionState = await distributedStateManager.getSession(sessionId);
      
      if (!sessionState) {
        return null;
      }

      const sessionData: SessionData = {
        sessionId: sessionState.sessionId,
        userId: sessionState.userId,
        workingDirectory: sessionState.workingDirectory,
        currentFile: sessionState.currentFile,
        commandHistory: sessionState.commandHistory,
        environmentVars: sessionState.environmentVars,
        homeRegion: sessionState.homeRegion,
        metadata: sessionState.metadata
      };

      // Update local cache
      this.localCache.set(sessionId, {
        data: sessionData,
        version: sessionState.version,
        lastAccess: Date.now()
      });

      return sessionData;
    } catch (error) {
      logger.error(`Failed to get session ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Omit<SessionData, 'sessionId' | 'homeRegion'>>,
    options: SessionUpdateOptions = {}
  ): Promise<SessionData> {
    const {
      optimisticUpdate = true,
      retryOnConflict = true,
      maxRetries = this.maxRetries
    } = options;

    let retryCount = 0;
    
    while (retryCount <= maxRetries) {
      try {
        // Get current session data
        const currentSession = await this.getSession(sessionId, true);
        
        if (!currentSession) {
          throw new Error(`Session ${sessionId} not found`);
        }

        const cached = this.localCache.get(sessionId);
        const expectedVersion = cached?.version;

        // Merge updates
        const updatedData: SessionData = {
          ...currentSession,
          ...updates
        };

        // Optimistic update to local cache first
        if (optimisticUpdate && cached) {
          this.localCache.set(sessionId, {
            data: updatedData,
            version: cached.version + 1,
            lastAccess: Date.now()
          });

          // Emit optimistic update event
          this.emit('sessionUpdated', updatedData, { optimistic: true });
        }

        // Attempt to save to DynamoDB with version check
        const savedSession = await distributedStateManager.saveSession({
          ...updatedData,
          createdAt: (await distributedStateManager.getSession(sessionId))?.createdAt || Date.now(),
          updatedAt: Date.now(),
          version: expectedVersion || 1
        }, expectedVersion);

        // Update cache with confirmed version
        this.localCache.set(sessionId, {
          data: updatedData,
          version: savedSession.version,
          lastAccess: Date.now()
        });

        this.emit('sessionUpdated', updatedData, { optimistic: false, confirmed: true });
        
        logger.debug(`Session ${sessionId} updated successfully (attempt ${retryCount + 1})`);
        return updatedData;

      } catch (error: any) {
        if (error.message === 'SESSION_VERSION_CONFLICT') {
          if (retryOnConflict && retryCount < maxRetries) {
            retryCount++;
            
            // Exponential backoff
            const backoffMs = this.retryBackoffMs * Math.pow(2, retryCount - 1);
            await new Promise(resolve => setTimeout(resolve, backoffMs));

            // Clear local cache to force fresh fetch
            this.localCache.delete(sessionId);

            const conflictInfo: SessionConflictInfo = {
              sessionId,
              expectedVersion: this.localCache.get(sessionId)?.version || 0,
              currentVersion: 0, // Will be determined on retry
              conflictType: 'version'
            };

            this.emit('sessionConflict', conflictInfo);
            logger.warn(`Session version conflict for ${sessionId}, retrying (${retryCount}/${maxRetries})`);
            
            continue;
          } else {
            logger.error(`Session update failed after ${retryCount} retries: ${sessionId}`);
            
            // Revert optimistic update
            if (optimisticUpdate) {
              const originalData = await this.getSession(sessionId, false); // Force DB fetch
              if (originalData) {
                this.emit('sessionReverted', originalData);
              }
            }
            
            throw new Error('SESSION_UPDATE_CONFLICT');
          }
        } else {
          logger.error(`Failed to update session ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
          
          // Revert optimistic update on other errors too
          if (optimisticUpdate) {
            const originalData = await this.getSession(sessionId, false);
            if (originalData) {
              this.emit('sessionReverted', originalData);
            }
          }
          
          throw error;
        }
      }
    }

    throw new Error(`Session update failed after ${maxRetries} retries`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await distributedStateManager.deleteSession(sessionId);
      this.localCache.delete(sessionId);
      
      this.emit('sessionDeleted', sessionId);
      logger.info(`Session deleted: ${sessionId}`);
    } catch (error) {
      logger.error(`Failed to delete session ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Convenience methods for common updates
  async updateWorkingDirectory(sessionId: string, newDirectory: string): Promise<SessionData> {
    return this.updateSession(sessionId, {
      workingDirectory: newDirectory,
      environmentVars: { PWD: newDirectory }
    });
  }

  async addCommandToHistory(sessionId: string, command: string): Promise<SessionData> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const updatedHistory = [...session.commandHistory, command];
    
    // Keep only last 1000 commands to prevent unbounded growth
    if (updatedHistory.length > 1000) {
      updatedHistory.splice(0, updatedHistory.length - 1000);
    }

    return this.updateSession(sessionId, {
      commandHistory: updatedHistory
    });
  }

  async setCurrentFile(sessionId: string, filePath?: string): Promise<SessionData> {
    return this.updateSession(sessionId, {
      currentFile: filePath
    });
  }

  async updateEnvironmentVar(sessionId: string, key: string, value: string): Promise<SessionData> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    return this.updateSession(sessionId, {
      environmentVars: {
        ...session.environmentVars,
        [key]: value
      }
    });
  }

  // Session listing and management
  async getActiveSessions(userId?: string): Promise<SessionData[]> {
    // This would require a GSI on userId, for now return cached sessions
    const activeSessions: SessionData[] = [];
    
    for (const [sessionId, cached] of this.localCache.entries()) {
      if (!userId || cached.data.userId === userId) {
        if (Date.now() - cached.lastAccess < this.cacheTimeout * 2) {
          activeSessions.push(cached.data);
        }
      }
    }

    return activeSessions;
  }

  // Health check for session management
  async healthCheck(): Promise<{ healthy: boolean; cachedSessions: number; region: string }> {
    try {
      const dbHealth = await distributedStateManager.healthCheck();
      
      return {
        healthy: dbHealth.healthy,
        cachedSessions: this.localCache.size,
        region: this.region
      };
    } catch (error) {
      logger.error('SessionManager health check failed:', error instanceof Error ? error : new Error(String(error)));
      return {
        healthy: false,
        cachedSessions: this.localCache.size,
        region: this.region
      };
    }
  }

  // Cleanup methods
  private cleanupLocalCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, cached] of this.localCache.entries()) {
      if (now - cached.lastAccess > this.cacheTimeout) {
        this.localCache.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`Cleaned up ${cleanedCount} expired cache entries`);
    }
  }

  // Force refresh session from DB (bypass cache)
  async refreshSession(sessionId: string): Promise<SessionData | null> {
    this.localCache.delete(sessionId);
    return this.getSession(sessionId, false);
  }

  // Get session statistics
  getSessionStats(): { totalCached: number; cacheHitRate: number; region: string } {
    // This would require more detailed metrics tracking in production
    return {
      totalCached: this.localCache.size,
      cacheHitRate: 0, // Would need to implement hit/miss tracking
      region: this.region
    };
  }
}

export const sessionManager = new SessionManager();