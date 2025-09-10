import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import logger from '../config/logger';
import { EventEmitter } from 'events';

interface SessionState {
  sessionId: string;
  userId: string;
  workingDirectory: string;
  currentFile?: string;
  commandHistory: string[];
  environmentVars: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  version: number;
  homeRegion: string;
  metadata?: Record<string, any>;
}

interface TaskState {
  taskId: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  assignedNode: string;
  ownerRegion: string;
  payload: any;
  progress?: number;
  result?: any;
  error?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  leaseExpiresAt?: number;
}

interface CacheEntry {
  key: string;
  value: any;
  type: 'context7' | 'cipher' | 'mcp' | 'general';
  createdAt: number;
  expiresAt?: number;
  version: number;
  region: string;
}

export class DistributedStateManager extends EventEmitter {
  private dynamoClient: DynamoDBClient;
  private docClient: DynamoDBDocumentClient;
  private tableName: string;
  private region: string;

  constructor() {
    super();
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.tableName = process.env.DYNAMODB_TABLE_NAME || 'claude-code-distributed-state';
    
    this.dynamoClient = new DynamoDBClient({
      region: this.region,
      maxAttempts: 3
    });
    
    this.docClient = DynamoDBDocumentClient.from(this.dynamoClient, {
      marshallOptions: {
        convertEmptyValues: false,
        removeUndefinedValues: true,
        convertClassInstanceToMap: false
      },
      unmarshallOptions: {
        wrapNumbers: false
      }
    });

    logger.info(`DistributedStateManager initialized for region: ${this.region}`);
  }

  // Session State Management
  async getSession(sessionId: string): Promise<SessionState | null> {
    try {
      const command = new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: `session#${sessionId}`, sk: 'metadata' }),
        ConsistentRead: false // Use eventually consistent reads for performance
      });

      const result = await this.dynamoClient.send(command);
      
      if (!result.Item) {
        return null;
      }

      const item = unmarshall(result.Item);
      return this.transformToSessionState(item);
    } catch (error) {
      logger.error(`Failed to get session ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
      throw new Error(`Session retrieval failed: ${error}`);
    }
  }

  async saveSession(session: SessionState, expectedVersion?: number): Promise<SessionState> {
    try {
      const now = Date.now();
      const updatedSession = {
        ...session,
        updatedAt: now,
        version: (session.version || 0) + 1
      };

      const item = {
        pk: `session#${session.sessionId}`,
        sk: 'metadata',
        sessionId: session.sessionId,
        userId: session.userId,
        workingDirectory: session.workingDirectory,
        currentFile: session.currentFile,
        commandHistory: session.commandHistory,
        environmentVars: session.environmentVars,
        createdAt: session.createdAt || now,
        updatedAt: updatedSession.updatedAt,
        version: updatedSession.version,
        homeRegion: session.homeRegion,
        metadata: session.metadata,
        ttl: Math.floor((now + (24 * 60 * 60 * 1000)) / 1000) // 24 hours TTL
      };

      const command = new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(item),
        ConditionExpression: expectedVersion !== undefined 
          ? 'attribute_not_exists(version) OR version = :expectedVersion'
          : undefined,
        ExpressionAttributeValues: expectedVersion !== undefined 
          ? marshall({ ':expectedVersion': expectedVersion })
          : undefined
      });

      await this.dynamoClient.send(command);
      
      this.emit('sessionUpdated', updatedSession);
      logger.debug(`Session ${session.sessionId} saved with version ${updatedSession.version}`);
      
      return updatedSession;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        logger.warn(`Optimistic lock failed for session ${session.sessionId}. Expected version: ${expectedVersion}, current version may be newer.`);
        throw new Error('SESSION_VERSION_CONFLICT');
      }
      logger.error(`Failed to save session ${session.sessionId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      const command = new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: `session#${sessionId}`, sk: 'metadata' })
      });

      await this.dynamoClient.send(command);
      this.emit('sessionDeleted', sessionId);
      logger.debug(`Session ${sessionId} deleted`);
    } catch (error) {
      logger.error(`Failed to delete session ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Task State Management
  async createTask(task: Omit<TaskState, 'version' | 'createdAt' | 'updatedAt'>): Promise<TaskState> {
    try {
      const now = Date.now();
      const newTask: TaskState = {
        ...task,
        createdAt: now,
        updatedAt: now,
        version: 1
      };

      const item = {
        pk: `task#${task.taskId}`,
        sk: 'metadata',
        ...newTask,
        ttl: task.leaseExpiresAt ? Math.floor(task.leaseExpiresAt / 1000) : undefined
      };

      const command = new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(item),
        ConditionExpression: 'attribute_not_exists(pk)' // Ensure task doesn't already exist
      });

      await this.dynamoClient.send(command);
      
      this.emit('taskCreated', newTask);
      logger.debug(`Task ${task.taskId} created by ${task.ownerRegion}`);
      
      return newTask;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        throw new Error('TASK_ALREADY_EXISTS');
      }
      logger.error(`Failed to create task ${task.taskId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async updateTaskProgress(
    taskId: string, 
    updates: Partial<Pick<TaskState, 'status' | 'progress' | 'result' | 'error'>>,
    options?: { expectedOwnerRegion?: string; extendLease?: number }
  ): Promise<TaskState> {
    try {
      const now = Date.now();
      const updateExpressions: string[] = [];
      const attributeNames: Record<string, string> = {};
      const attributeValues: Record<string, any> = {};

      // Build update expression
      if (updates.status !== undefined) {
        updateExpressions.push('#status = :status');
        attributeNames['#status'] = 'status';
        attributeValues[':status'] = updates.status;
      }

      if (updates.progress !== undefined) {
        updateExpressions.push('progress = :progress');
        attributeValues[':progress'] = updates.progress;
      }

      if (updates.result !== undefined) {
        updateExpressions.push('result = :result');
        attributeValues[':result'] = updates.result;
      }

      if (updates.error !== undefined) {
        updateExpressions.push('error = :error');
        attributeValues[':error'] = updates.error;
      }

      updateExpressions.push('updatedAt = :updatedAt');
      updateExpressions.push('version = version + :one');
      attributeValues[':updatedAt'] = now;
      attributeValues[':one'] = 1;

      if (options?.extendLease) {
        updateExpressions.push('leaseExpiresAt = :newLease');
        attributeValues[':newLease'] = now + options.extendLease;
      }

      // Build condition expression for owner region check
      let conditionExpression = '';
      if (options?.expectedOwnerRegion) {
        conditionExpression = 'ownerRegion = :expectedOwner';
        attributeValues[':expectedOwner'] = options.expectedOwnerRegion;
      }

      const command = new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: `task#${taskId}`, sk: 'metadata' }),
        UpdateExpression: 'SET ' + updateExpressions.join(', '),
        ConditionExpression: conditionExpression || undefined,
        ExpressionAttributeNames: Object.keys(attributeNames).length > 0 ? attributeNames : undefined,
        ExpressionAttributeValues: marshall(attributeValues),
        ReturnValues: 'ALL_NEW'
      });

      const result = await this.dynamoClient.send(command);
      
      if (!result.Attributes) {
        throw new Error('Update operation returned no attributes');
      }

      const updatedTask = this.transformToTaskState(unmarshall(result.Attributes));
      this.emit('taskUpdated', updatedTask);
      logger.debug(`Task ${taskId} updated to status: ${updates.status}`);
      
      return updatedTask;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        logger.warn(`Task ${taskId} owner region check failed or lease expired`);
        throw new Error('TASK_OWNERSHIP_ERROR');
      }
      logger.error(`Failed to update task ${taskId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async getTask(taskId: string): Promise<TaskState | null> {
    try {
      const command = new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: `task#${taskId}`, sk: 'metadata' })
      });

      const result = await this.dynamoClient.send(command);
      
      if (!result.Item) {
        return null;
      }

      return this.transformToTaskState(unmarshall(result.Item));
    } catch (error) {
      logger.error(`Failed to get task ${taskId}:`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Cache Management
  async getFromCache(key: string): Promise<CacheEntry | null> {
    try {
      const command = new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: `cache#${key}`, sk: 'data' })
      });

      const result = await this.dynamoClient.send(command);
      
      if (!result.Item) {
        return null;
      }

      const item = unmarshall(result.Item);
      
      // Check expiration
      if (item.expiresAt && item.expiresAt < Date.now()) {
        // Expired, delete and return null
        await this.deleteFromCache(key);
        return null;
      }

      return this.transformToCacheEntry(item);
    } catch (error) {
      logger.error(`Failed to get cache entry ${key}:`, error instanceof Error ? error : new Error(String(error)));
      return null; // Don't throw for cache misses
    }
  }

  async setCache(entry: Omit<CacheEntry, 'version'>): Promise<void> {
    try {
      const item = {
        pk: `cache#${entry.key}`,
        sk: 'data',
        key: entry.key,
        value: entry.value,
        type: entry.type,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        region: entry.region,
        version: 1,
        ttl: entry.expiresAt ? Math.floor(entry.expiresAt / 1000) : Math.floor((Date.now() + (3600 * 1000)) / 1000) // Default 1 hour
      };

      const command = new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(item)
      });

      await this.dynamoClient.send(command);
      
      logger.debug(`Cache entry ${entry.key} set with type ${entry.type}`);
    } catch (error) {
      logger.error(`Failed to set cache entry ${entry.key}:`, error instanceof Error ? error : new Error(String(error)));
      // Don't throw for cache writes - app should continue
    }
  }

  async deleteFromCache(key: string): Promise<void> {
    try {
      const command = new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: `cache#${key}`, sk: 'data' })
      });

      await this.dynamoClient.send(command);
      logger.debug(`Cache entry ${key} deleted`);
    } catch (error) {
      logger.error(`Failed to delete cache entry ${key}:`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Helper methods
  private transformToSessionState(item: any): SessionState {
    return {
      sessionId: item.sessionId,
      userId: item.userId,
      workingDirectory: item.workingDirectory,
      currentFile: item.currentFile,
      commandHistory: item.commandHistory || [],
      environmentVars: item.environmentVars || {},
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      version: item.version || 1,
      homeRegion: item.homeRegion,
      metadata: item.metadata
    };
  }

  private transformToTaskState(item: any): TaskState {
    return {
      taskId: item.taskId,
      type: item.type,
      status: item.status,
      assignedNode: item.assignedNode,
      ownerRegion: item.ownerRegion,
      payload: item.payload,
      progress: item.progress,
      result: item.result,
      error: item.error,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      version: item.version,
      leaseExpiresAt: item.leaseExpiresAt
    };
  }

  private transformToCacheEntry(item: any): CacheEntry {
    return {
      key: item.key,
      value: item.value,
      type: item.type,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      version: item.version || 1,
      region: item.region
    };
  }

  // Health check method
  async healthCheck(): Promise<{ healthy: boolean; region: string; latency: number }> {
    const startTime = Date.now();
    try {
      // Simple item write and read to verify connectivity
      const testItem = {
        pk: 'health#check',
        sk: 'test',
        timestamp: startTime,
        ttl: Math.floor((Date.now() + 60000) / 1000) // 1 minute TTL
      };

      await this.dynamoClient.send(new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(testItem)
      }));

      const latency = Date.now() - startTime;
      
      return {
        healthy: true,
        region: this.region,
        latency
      };
    } catch (error) {
      logger.error('Health check failed:', error instanceof Error ? error : new Error(String(error)));
      return {
        healthy: false,
        region: this.region,
        latency: Date.now() - startTime
      };
    }
  }
}

export const distributedStateManager = new DistributedStateManager();