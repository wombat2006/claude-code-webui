import { distributedStateManager } from './distributedStateManager';
import { sessionManager } from './sessionManager';
import { logger } from '../config/logger';
import { EventEmitter } from 'events';

interface SyncedSession {
  sessionId: string;
  lastSync: number;
  version: number;
}

interface CrossRegionNotification {
  type: 'session_change' | 'task_update';
  sessionId?: string;
  taskId?: string;
  timestamp: number;
  sourceRegion: string;
  data: any;
}

export class SimpleStateSync extends EventEmitter {
  private syncedSessions = new Map<string, SyncedSession>();
  private tokyoEndpoint: string;
  private region: string;
  private pollInterval = 10000; // 10 seconds
  private isPolling = false;

  constructor() {
    super();
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.tokyoEndpoint = process.env.TOKYO_CO_NODE || '54.65.178.168:3003';
  }

  // Simple polling-based sync instead of Streams
  startSync(): void {
    if (this.isPolling) return;
    
    this.isPolling = true;
    this.pollForChanges();
    logger.info('Simple state sync started');
  }

  stopSync(): void {
    this.isPolling = false;
    logger.info('Simple state sync stopped');
  }

  private async pollForChanges(): Promise<void> {
    while (this.isPolling) {
      try {
        await this.checkForSessionChanges();
        await new Promise(resolve => setTimeout(resolve, this.pollInterval));
      } catch (error) {
        logger.error('Error during sync polling:', error);
        await new Promise(resolve => setTimeout(resolve, this.pollInterval));
      }
    }
  }

  private async checkForSessionChanges(): Promise<void> {
    // Get all active sessions from local cache
    const activeSessions = await sessionManager.getActiveSessions();
    
    for (const session of activeSessions) {
      try {
        const currentSync = this.syncedSessions.get(session.sessionId);
        
        // Get latest version from DynamoDB
        const latestSession = await distributedStateManager.getSession(session.sessionId);
        
        if (latestSession && (!currentSync || latestSession.version > currentSync.version)) {
          // Session has been updated from another region
          this.syncedSessions.set(session.sessionId, {
            sessionId: session.sessionId,
            lastSync: Date.now(),
            version: latestSession.version
          });

          // Emit change event to connected WebSocket clients
          this.emit('sessionChanged', {
            sessionId: session.sessionId,
            userId: latestSession.userId,
            changes: {
              workingDirectory: latestSession.workingDirectory,
              currentFile: latestSession.currentFile,
              commandHistory: latestSession.commandHistory,
              version: latestSession.version
            }
          });

          logger.debug(`Session ${session.sessionId} synced from remote (v${latestSession.version})`);
        }
      } catch (error) {
        logger.error(`Failed to sync session ${session.sessionId}:`, error);
      }
    }
  }

  // Simple HTTP-based notification to Tokyo co-node
  async notifyTokyoNode(notification: CrossRegionNotification): Promise<void> {
    try {
      const response = await fetch(`http://${this.tokyoEndpoint}/api/sync/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TOKYO_API_KEY}`
        },
        body: JSON.stringify(notification),
        timeout: 5000
      });

      if (!response.ok) {
        throw new Error(`Tokyo node notification failed: ${response.status}`);
      }

      logger.debug(`Notification sent to Tokyo node: ${notification.type}`);
    } catch (error) {
      logger.warn(`Failed to notify Tokyo node:`, error);
      // Don't throw - app should continue working even if cross-region sync fails
    }
  }

  // Handle incoming notifications from other regions
  async handleRemoteNotification(notification: CrossRegionNotification): Promise<void> {
    try {
      if (notification.type === 'session_change' && notification.sessionId) {
        // Force refresh session from DynamoDB
        await sessionManager.refreshSession(notification.sessionId);
        
        this.emit('remoteSessionChange', {
          sessionId: notification.sessionId,
          sourceRegion: notification.sourceRegion,
          timestamp: notification.timestamp
        });
      }
    } catch (error) {
      logger.error('Failed to handle remote notification:', error);
    }
  }

  // Get sync status
  getSyncStatus(): { region: string; activeSessions: number; lastSync: number } {
    const lastSyncTimes = Array.from(this.syncedSessions.values()).map(s => s.lastSync);
    const lastSync = lastSyncTimes.length > 0 ? Math.max(...lastSyncTimes) : 0;

    return {
      region: this.region,
      activeSessions: this.syncedSessions.size,
      lastSync
    };
  }
}

export const simpleStateSync = new SimpleStateSync();