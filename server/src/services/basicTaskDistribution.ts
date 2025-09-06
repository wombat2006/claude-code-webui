import fetch from 'node-fetch';
import logger from '../config/logger';

export interface TaskRequest {
  type: string;
  data: any;
  timestamp: number;
  requestId: string;
}

export interface TaskResponse {
  success: boolean;
  result?: any;
  error?: string;
  processingTime: number;
  memoryUsage: NodeJS.MemoryUsage;
}

export class BasicTaskDistribution {
  private tokyoVMUrl: string;

  constructor() {
    // 東京VMのURL（環境変数で設定可能）
    this.tokyoVMUrl = process.env.TOKYO_VM_URL || 'http://54.65.178.168:3001';
  }

  /**
   * 東京VMにタスクを送信
   */
  async sendToTokyo(task: TaskRequest): Promise<TaskResponse> {
    const startTime = Date.now();
    
    try {
      logger.info('Sending task to Tokyo VM', {
        taskType: task.type,
        requestId: task.requestId,
        tokyoUrl: this.tokyoVMUrl
      });

      const response = await fetch(`${this.tokyoVMUrl}/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(task),
        timeout: 30000 // 30秒タイムアウト
      });

      if (!response.ok) {
        throw new Error(`Tokyo VM responded with ${response.status}: ${response.statusText}`);
      }

      const result = await response.json() as TaskResponse;
      const processingTime = Date.now() - startTime;

      logger.info('Received response from Tokyo VM', {
        requestId: task.requestId,
        processingTime,
        success: result.success
      });

      return {
        ...result,
        processingTime
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      logger.error('Failed to communicate with Tokyo VM', error as Error, {
        requestId: task.requestId,
        processingTime,
        tokyoUrl: this.tokyoVMUrl
      });

      return {
        success: false,
        error: errorMessage,
        processingTime,
        memoryUsage: process.memoryUsage()
      };
    }
  }

  /**
   * 東京VMの健康状態をチェック
   */
  async healthCheck(): Promise<{ alive: boolean; latency?: number; error?: string }> {
    const startTime = Date.now();
    
    try {
      const response = await fetch(`${this.tokyoVMUrl}/health`, {
        method: 'GET',
        timeout: 10000 // 10秒タイムアウト
      });

      if (!response.ok) {
        return {
          alive: false,
          error: `Health check failed with status ${response.status}`
        };
      }

      const latency = Date.now() - startTime;
      return { alive: true, latency };

    } catch (error) {
      return {
        alive: false,
        error: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }

  /**
   * メモリ使用量の多いタスクを東京VMに委譲するかどうか判定
   */
  shouldOffloadToTokyo(estimatedMemoryMB: number): boolean {
    const currentMemory = process.memoryUsage();
    const availableMemory = (1800 * 1024 * 1024) - currentMemory.rss; // 1.8GB制限から現在使用量を引く
    const requiredMemory = estimatedMemoryMB * 1024 * 1024;

    return requiredMemory > (availableMemory * 0.8); // 利用可能メモリの80%以上なら委譲
  }
}

// シングルトンインスタンス
export const taskDistribution = new BasicTaskDistribution();