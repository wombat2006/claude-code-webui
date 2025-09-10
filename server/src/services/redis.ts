import { createClient, RedisClientType } from 'redis';
import logger from '../config/logger';

let client: RedisClientType | null = null;

export async function getRedis(): Promise<RedisClientType> {
  if (client) return client;
  
  const url = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || '6379'}`;
  
  client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => {
        const delay = Math.min(1000 * Math.pow(2, retries), 15000);
        logger.info(`Redis reconnecting (attempt ${retries + 1}), delay: ${delay}ms`);
        return delay;
      },
      keepAlive: true
    }
  });
  
  client.on('error', (err) => {
    logger.error('Redis error:', err);
  });
  
  client.on('connect', () => {
    logger.info('Redis connected', { url });
  });
  
  client.on('reconnecting', () => {
    logger.warn('Redis reconnecting...');
  });
  
  client.on('ready', () => {
    logger.info('Redis ready');
  });
  
  await client.connect();
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  
  try {
    await client.quit();
    logger.info('Redis connection closed');
  } catch (error) {
    logger.error('Error closing Redis connection:', error instanceof Error ? error : new Error(String(error)));
  } finally {
    client = null;
  }
}

export function isRedisConnected(): boolean {
  return client?.isReady ?? false;
}