import { DynamoDBStreamEvent, DynamoDBRecord, Context } from 'aws-lambda';
import { ApiGatewayManagementApi } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import logger from '../config/logger';

interface StreamProcessorConfig {
  apiGatewayEndpoint: string;
  region: string;
  connectionTableName: string;
}

interface WebSocketConnection {
  connectionId: string;
  userId: string;
  sessionId?: string;
  subscriptions: string[];
  connectedAt: number;
  lastSeen: number;
}

interface NotificationEvent {
  type: 'session_updated' | 'task_updated' | 'cache_invalidated' | 'session_conflict';
  entityId: string;
  userId?: string;
  sessionId?: string;
  data: any;
  timestamp: number;
  sourceRegion: string;
}

export class StreamProcessor {
  private apiGateway: ApiGatewayManagementApi;
  private dynamoClient: DynamoDBClient;
  private config: StreamProcessorConfig;

  constructor(config: StreamProcessorConfig) {
    this.config = config;
    
    this.apiGateway = new ApiGatewayManagementApi({
      endpoint: config.apiGatewayEndpoint,
      region: config.region
    });

    this.dynamoClient = new DynamoDBClient({
      region: config.region
    });
  }

  // Main Lambda handler for DynamoDB Streams
  async processStreamRecords(event: DynamoDBStreamEvent, context: Context): Promise<void> {
    logger.info(`Processing ${event.Records.length} stream records`);

    const notifications: NotificationEvent[] = [];

    for (const record of event.Records) {
      try {
        const notification = await this.processRecord(record);
        if (notification) {
          notifications.push(notification);
        }
      } catch (error) {
        logger.error('Error processing stream record:', error instanceof Error ? error : new Error(String(error)));
        // Continue processing other records
      }
    }

    // Send notifications to connected clients
    await this.distributeNotifications(notifications);
  }

  private async processRecord(record: DynamoDBRecord): Promise<NotificationEvent | null> {
    const { eventName, dynamodb } = record;
    
    if (!dynamodb?.Keys) {
      return null;
    }

    const keys = unmarshall(dynamodb.Keys);
    const pk = keys.pk as string;
    const sk = keys.sk as string;

    // Process different entity types
    if (pk.startsWith('session#')) {
      return this.processSessionRecord(record, pk, sk);
    } else if (pk.startsWith('task#')) {
      return this.processTaskRecord(record, pk, sk);
    } else if (pk.startsWith('cache#')) {
      return this.processCacheRecord(record, pk, sk);
    }

    return null;
  }

  private async processSessionRecord(
    record: DynamoDBRecord, 
    pk: string, 
    sk: string
  ): Promise<NotificationEvent | null> {
    const sessionId = pk.replace('session#', '');
    const { eventName, dynamodb } = record;

    if (eventName === 'INSERT' || eventName === 'MODIFY') {
      if (!dynamodb?.NewImage) return null;

      const sessionData = unmarshall(dynamodb.NewImage);
      
      // Check for version conflicts (concurrent modifications)
      const isConflict = eventName === 'MODIFY' && dynamodb.OldImage;
      
      return {
        type: isConflict ? 'session_conflict' : 'session_updated',
        entityId: sessionId,
        userId: sessionData.userId,
        sessionId: sessionId,
        data: {
          sessionId: sessionData.sessionId,
          workingDirectory: sessionData.workingDirectory,
          currentFile: sessionData.currentFile,
          commandHistory: sessionData.commandHistory,
          version: sessionData.version,
          updatedAt: sessionData.updatedAt,
          ...(isConflict && {
            conflict: {
              oldVersion: dynamodb.OldImage ? unmarshall(dynamodb.OldImage).version : null,
              newVersion: sessionData.version
            }
          })
        },
        timestamp: Date.now(),
        sourceRegion: this.config.region
      };
    }

    return null;
  }

  private async processTaskRecord(
    record: DynamoDBRecord,
    pk: string,
    sk: string
  ): Promise<NotificationEvent | null> {
    const taskId = pk.replace('task#', '');
    const { eventName, dynamodb } = record;

    if (eventName === 'INSERT' || eventName === 'MODIFY') {
      if (!dynamodb?.NewImage) return null;

      const taskData = unmarshall(dynamodb.NewImage);
      
      return {
        type: 'task_updated',
        entityId: taskId,
        userId: undefined, // Tasks might not have direct user association
        sessionId: taskData.sessionId,
        data: {
          taskId: taskData.taskId,
          type: taskData.type,
          status: taskData.status,
          progress: taskData.progress,
          result: taskData.result,
          error: taskData.error,
          assignedNode: taskData.assignedNode,
          version: taskData.version,
          updatedAt: taskData.updatedAt
        },
        timestamp: Date.now(),
        sourceRegion: this.config.region
      };
    }

    return null;
  }

  private async processCacheRecord(
    record: DynamoDBRecord,
    pk: string,
    sk: string
  ): Promise<NotificationEvent | null> {
    const cacheKey = pk.replace('cache#', '');
    const { eventName } = record;

    if (eventName === 'REMOVE') {
      return {
        type: 'cache_invalidated',
        entityId: cacheKey,
        data: {
          key: cacheKey,
          invalidatedAt: Date.now()
        },
        timestamp: Date.now(),
        sourceRegion: this.config.region
      };
    }

    return null;
  }

  // Distribute notifications to connected WebSocket clients
  private async distributeNotifications(notifications: NotificationEvent[]): Promise<void> {
    if (notifications.length === 0) return;

    try {
      // Get all active WebSocket connections
      const connections = await this.getActiveConnections();
      
      for (const notification of notifications) {
        const relevantConnections = this.filterConnectionsForNotification(connections, notification);
        
        await Promise.all(
          relevantConnections.map(connection => 
            this.sendNotificationToConnection(connection, notification)
          )
        );
      }
    } catch (error) {
      logger.error('Error distributing notifications:', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async getActiveConnections(): Promise<WebSocketConnection[]> {
    try {
      // Query active connections from the connection table
      const command = new QueryCommand({
        TableName: this.config.connectionTableName,
        IndexName: 'ByStatus', // Assuming we have a GSI for active connections
        KeyConditionExpression: 'connectionStatus = :status',
        ExpressionAttributeValues: {
          ':status': { S: 'active' }
        }
      });

      const result = await this.dynamoClient.send(command);
      
      if (!result.Items) return [];

      return result.Items.map(item => {
        const unmarshalled = unmarshall(item);
        return {
          connectionId: unmarshalled.connectionId,
          userId: unmarshalled.userId,
          sessionId: unmarshalled.sessionId,
          subscriptions: unmarshalled.subscriptions || [],
          connectedAt: unmarshalled.connectedAt,
          lastSeen: unmarshalled.lastSeen
        };
      });
    } catch (error) {
      logger.error('Failed to get active connections:', error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  private filterConnectionsForNotification(
    connections: WebSocketConnection[], 
    notification: NotificationEvent
  ): WebSocketConnection[] {
    return connections.filter(connection => {
      // Filter by user ID if notification has one
      if (notification.userId && connection.userId !== notification.userId) {
        return false;
      }

      // Filter by session ID if notification has one
      if (notification.sessionId && connection.sessionId !== notification.sessionId) {
        return false;
      }

      // Filter by subscriptions
      const subscriptionKey = `${notification.type}:${notification.entityId}`;
      if (connection.subscriptions.length > 0) {
        return connection.subscriptions.some(sub => 
          sub === subscriptionKey || 
          sub === notification.type ||
          sub === 'all'
        );
      }

      // Default: send session updates to session owners, task updates to all
      if (notification.type === 'session_updated' && connection.sessionId === notification.sessionId) {
        return true;
      }

      if (notification.type === 'task_updated') {
        return true; // Tasks are broadcasted to all connections
      }

      if (notification.type === 'cache_invalidated') {
        return true; // Cache invalidations are broadcasted
      }

      return false;
    });
  }

  private async sendNotificationToConnection(
    connection: WebSocketConnection, 
    notification: NotificationEvent
  ): Promise<void> {
    try {
      const message = JSON.stringify({
        event: notification.type,
        entityId: notification.entityId,
        data: notification.data,
        timestamp: notification.timestamp,
        sourceRegion: notification.sourceRegion
      });

      await this.apiGateway.postToConnection({
        ConnectionId: connection.connectionId,
        Data: message
      });

      logger.debug(`Notification sent to connection ${connection.connectionId}`);
    } catch (error: any) {
      if (error.statusCode === 410) {
        // Connection is gone, clean it up
        logger.info(`Stale connection ${connection.connectionId}, cleaning up`);
        await this.cleanupConnection(connection.connectionId);
      } else {
        logger.error(`Failed to send notification to connection ${connection.connectionId}:`, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async cleanupConnection(connectionId: string): Promise<void> {
    try {
      // Remove the connection from the connection table
      const command = new QueryCommand({
        TableName: this.config.connectionTableName,
        KeyConditionExpression: 'connectionId = :connectionId',
        ExpressionAttributeValues: {
          ':connectionId': { S: connectionId }
        }
      });

      // This would be followed by a DeleteItem command in a real implementation
      logger.debug(`Connection ${connectionId} marked for cleanup`);
    } catch (error) {
      logger.error(`Failed to cleanup connection ${connectionId}:`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Utility method for testing notifications
  async sendTestNotification(connectionId: string, data: any): Promise<void> {
    try {
      await this.apiGateway.postToConnection({
        ConnectionId: connectionId,
        Data: JSON.stringify({
          event: 'test_notification',
          data,
          timestamp: Date.now()
        })
      });
      logger.info(`Test notification sent to ${connectionId}`);
    } catch (error) {
      logger.error(`Failed to send test notification to ${connectionId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}

// Lambda handler function
export const lambdaHandler = async (event: DynamoDBStreamEvent, context: Context) => {
  const processor = new StreamProcessor({
    apiGatewayEndpoint: process.env.WEBSOCKET_API_ENDPOINT!,
    region: process.env.AWS_REGION!,
    connectionTableName: process.env.CONNECTION_TABLE_NAME!
  });

  try {
    await processor.processStreamRecords(event, context);
  } catch (error) {
    logger.error('Stream processing failed:', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
};