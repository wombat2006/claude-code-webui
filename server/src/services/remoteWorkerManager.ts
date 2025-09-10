import { EventEmitter } from 'events';
import * as https from 'https';
import * as http from 'http';
import logger from '../config/logger';
import { getErrorMessage, toError } from '../utils/errorHandling';
import { vmstatSarMonitor } from './vmstatMonitor';

interface RemoteWorker {
  id: string;
  name: string;
  region: 'tokyo' | 'singapore' | 'us-west' | 'europe';
  host: string;
  port: number;
  secure: boolean; // Use HTTPS
  apiKey: string;
  maxJobs: number;
  currentJobs: number;
  capabilities: string[];
  
  // Connection status
  online: boolean;
  lastSeen: number;
  lastPing: number;
  consecutiveFailures: number;
  
  // Performance metrics
  avgResponseTime: number;
  loadAverage: number;
  memoryUsage: number;
  cpuUsage: number;
  
  // Geographic info
  timezone: string;
  coordinates: { lat: number; lon: number };
}

interface RemoteJob {
  id: string;
  type: string;
  payload: any;
  workerId: string;
  submittedAt: number;
  startedAt?: number;
  completedAt?: number;
  timeout: number;
  retries: number;
  maxRetries: number;
  priority: 'low' | 'normal' | 'high' | 'urgent';
}

export class RemoteWorkerManager extends EventEmitter {
  private workers: Map<string, RemoteWorker> = new Map();
  private activeJobs: Map<string, RemoteJob> = new Map();
  private jobQueue: RemoteJob[] = [];
  
  private healthCheckInterval?: NodeJS.Timeout;
  private jobProcessorInterval?: NodeJS.Timeout;
  private metricsCollectionInterval?: NodeJS.Timeout;
  
  private readonly defaultTimeout = 120000; // 2 minutes
  private readonly maxConsecutiveFailures = 3;
  
  constructor() {
    super();
    this.setupDefaultTokyoWorkers();
    this.startHealthMonitoring();
    this.startJobProcessor();
    this.startMetricsCollection();
  }

  private setupDefaultTokyoWorkers(): void {
    // Parse Tokyo workers from environment
    const tokyoWorkers = process.env.TOKYO_WORKERS || '';
    
    if (tokyoWorkers) {
      const workers = tokyoWorkers.split(',');
      for (const workerConfig of workers) {
        // Format: name:host:port:capabilities:apikey
        const [name, host, port, capabilities, apiKey] = workerConfig.split(':');
        if (name && host && port && apiKey) {
          this.addWorker({
            id: `tokyo-${name}`,
            name,
            region: 'tokyo',
            host,
            port: parseInt(port),
            secure: true, // Always use HTTPS for remote workers
            apiKey,
            maxJobs: 5, // Higher capacity for remote workers
            currentJobs: 0,
            capabilities: capabilities ? capabilities.split('|') : ['general'],
            online: false,
            lastSeen: 0,
            lastPing: 0,
            consecutiveFailures: 0,
            avgResponseTime: 0,
            loadAverage: 0,
            memoryUsage: 0,
            cpuUsage: 0,
            timezone: 'Asia/Tokyo',
            coordinates: { lat: 35.6762, lon: 139.6503 } // Tokyo coordinates
          });
        }
      }
    }

    logger.info(`Configured ${this.workers.size} Tokyo worker nodes`);
  }

  public addWorker(worker: RemoteWorker): void {
    this.workers.set(worker.id, worker);
    logger.info(`Added Tokyo worker: ${worker.name} at ${worker.host}:${worker.port}`);
    
    // Immediate health check for new worker
    // this.performHealthCheck(worker); // Method not found - commenting out
  }

  private startHealthMonitoring(): void {
    // Health check every 30 seconds
    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, 30000);

    logger.info('Started Tokyo worker health monitoring');
  }

  private startJobProcessor(): void {
    // Process job queue every 2 seconds
    this.jobProcessorInterval = setInterval(() => {
      this.processJobQueue();
    }, 2000);

    logger.info('Started Tokyo worker job processor');
  }

  private startMetricsCollection(): void {
    // Collect detailed metrics every 60 seconds
    this.metricsCollectionInterval = setInterval(() => {
      this.collectWorkerMetrics();
    }, 60000);

    logger.info('Started Tokyo worker metrics collection');
  }

  private async performHealthChecks(): Promise<void> {
    const healthCheckPromises = Array.from(this.workers.values()).map(async (worker) => {
      try {
        const startTime = Date.now();
        const healthy = await this.checkWorkerHealth(worker);
        const responseTime = Date.now() - startTime;

        if (healthy) {
          worker.online = true;
          worker.lastSeen = Date.now();
          worker.lastPing = responseTime;
          worker.consecutiveFailures = 0;
          
          // Update average response time (exponential moving average)
          worker.avgResponseTime = worker.avgResponseTime === 0 
            ? responseTime 
            : (worker.avgResponseTime * 0.8) + (responseTime * 0.2);
            
        } else {
          worker.consecutiveFailures++;
          
          if (worker.consecutiveFailures >= this.maxConsecutiveFailures) {
            if (worker.online) {
              logger.warn(`Tokyo worker ${worker.name} marked offline after ${worker.consecutiveFailures} failures`);
              worker.online = false;
              this.emit('workerOffline', worker);
            }
          }
        }
      } catch (error) {
        logger.error(`Health check failed for Tokyo worker ${worker.name}:`, error instanceof Error ? error : new Error(String(error)));
        worker.consecutiveFailures++;
      }
    });

    await Promise.allSettled(healthCheckPromises);
  }

  private async checkWorkerHealth(worker: RemoteWorker): Promise<boolean> {
    return new Promise((resolve) => {
      const requestOptions = {
        hostname: worker.host,
        port: worker.port,
        path: '/health',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${worker.apiKey}`,
          'User-Agent': 'Claude-WebUI-Coordinator',
          'X-Region': 'tokyo-client'
        },
        timeout: 10000 // 10 second timeout for Tokyo
      };

      const client = worker.secure ? https : http;
      const req = client.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const health = JSON.parse(data);
              this.updateWorkerMetrics(worker, health);
              resolve(true);
            } catch (error) {
              logger.debug(`Invalid health response from ${worker.name}:`, { data });
              resolve(false);
            }
          } else {
            resolve(false);
          }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      
      req.setTimeout(10000);
      req.end();
    });
  }

  private updateWorkerMetrics(worker: RemoteWorker, healthData: any): void {
    if (healthData.system) {
      worker.loadAverage = healthData.system.loadAverage || 0;
      worker.memoryUsage = healthData.system.memoryUsage || 0;
      worker.cpuUsage = healthData.system.cpuUsage || 0;
    }
    
    if (healthData.jobs) {
      worker.currentJobs = healthData.jobs.active || 0;
    }
  }

  private async collectWorkerMetrics(): Promise<void> {
    const onlineWorkers = Array.from(this.workers.values()).filter(w => w.online);
    
    for (const worker of onlineWorkers) {
      try {
        const metrics = await this.getDetailedMetrics(worker);
        if (metrics) {
          this.updateWorkerMetrics(worker, metrics);
        }
      } catch (error) {
        logger.debug(`Failed to collect metrics from ${worker.name}:`, error);
      }
    }
  }

  private async getDetailedMetrics(worker: RemoteWorker): Promise<any> {
    return new Promise((resolve) => {
      const requestOptions = {
        hostname: worker.host,
        port: worker.port,
        path: '/api/metrics',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${worker.apiKey}`,
          'User-Agent': 'Claude-WebUI-Coordinator'
        },
        timeout: 15000 // 15 second timeout for metrics
      };

      const client = worker.secure ? https : http;
      const req = client.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      
      req.setTimeout(15000);
      req.end();
    });
  }

  public async submitJob(type: string, payload: any, options: any = {}): Promise<string> {
    const job: RemoteJob = {
      id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      payload,
      workerId: '',
      submittedAt: Date.now(),
      timeout: options.timeout || this.defaultTimeout,
      retries: 0,
      maxRetries: options.maxRetries || 2,
      priority: options.priority || 'normal'
    };

    // Add to queue based on priority
    if (job.priority === 'urgent') {
      this.jobQueue.unshift(job);
    } else if (job.priority === 'high') {
      const insertIndex = this.jobQueue.findIndex(j => j.priority === 'normal' || j.priority === 'low');
      this.jobQueue.splice(insertIndex >= 0 ? insertIndex : this.jobQueue.length, 0, job);
    } else {
      this.jobQueue.push(job);
    }

    this.activeJobs.set(job.id, job);
    
    logger.info(`Submitted job ${job.id} (${type}) to Tokyo worker queue`);
    return job.id;
  }

  private processJobQueue(): void {
    if (this.jobQueue.length === 0) return;

    // Get available workers (online, not at capacity)
    const availableWorkers = Array.from(this.workers.values())
      .filter(w => w.online && w.currentJobs < w.maxJobs)
      .sort((a, b) => {
        // Sort by capability match, then by load
        const aScore = this.calculateWorkerScore(a, this.jobQueue[0]);
        const bScore = this.calculateWorkerScore(b, this.jobQueue[0]);
        return bScore - aScore; // Higher score first
      });

    if (availableWorkers.length === 0) {
      // No workers available, check if we should alert
      if (this.jobQueue.length > 10) {
        logger.warn(`Tokyo worker queue backing up: ${this.jobQueue.length} jobs pending`);
      }
      return;
    }

    // Process jobs with available workers
    const jobsToProcess = Math.min(this.jobQueue.length, availableWorkers.length);
    
    for (let i = 0; i < jobsToProcess; i++) {
      const job = this.jobQueue.shift()!;
      const worker = availableWorkers[i];
      
      this.assignJobToWorker(job, worker);
    }
  }

  private calculateWorkerScore(worker: RemoteWorker, job: RemoteJob): number {
    let score = 0;

    // Capability match (highest priority)
    if (worker.capabilities.includes(job.type)) {
      score += 50;
    } else if (worker.capabilities.includes('general')) {
      score += 20;
    }

    // Load factor (lower load = higher score)
    const loadRatio = worker.currentJobs / worker.maxJobs;
    score += (1 - loadRatio) * 30; // 0-30 points

    // Performance factor
    if (worker.avgResponseTime > 0) {
      const responseScore = Math.max(0, 20 - (worker.avgResponseTime / 1000)); // 0-20 points
      score += responseScore;
    }

    // System health
    if (worker.loadAverage > 0) {
      const healthScore = Math.max(0, 10 - worker.loadAverage); // 0-10 points
      score += healthScore;
    }

    return score;
  }

  private async assignJobToWorker(job: RemoteJob, worker: RemoteWorker): Promise<void> {
    job.workerId = worker.id;
    job.startedAt = Date.now();
    worker.currentJobs++;

    logger.info(`Assigning job ${job.id} to Tokyo worker ${worker.name}`);

    try {
      const result = await this.executeJobOnWorker(job, worker);
      
      job.completedAt = Date.now();
      worker.currentJobs = Math.max(0, worker.currentJobs - 1);
      this.activeJobs.delete(job.id);
      
      this.emit('jobCompleted', job.id, result);
      
    } catch (error) {
      worker.currentJobs = Math.max(0, worker.currentJobs - 1);
      job.retries++;
      
      if (job.retries <= job.maxRetries) {
        job.workerId = '';
        job.startedAt = undefined;
        
        // Re-queue with higher priority for retry
        if (job.priority === 'normal') {
          job.priority = 'high';
        }
        this.jobQueue.unshift(job);
        
        logger.warn(`Job ${job.id} failed on Tokyo worker ${worker.name}, retrying (${job.retries}/${job.maxRetries})`);
      } else {
        this.activeJobs.delete(job.id);
        this.emit('jobFailed', job.id, error);
        logger.error(`Job ${job.id} failed permanently after ${job.retries} retries`);
      }
    }
  }

  private async executeJobOnWorker(job: RemoteJob, worker: RemoteWorker): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        jobId: job.id,
        type: job.type,
        payload: job.payload,
        timeout: job.timeout - 10000, // Give worker 10s less timeout
        priority: job.priority
      });

      const requestOptions = {
        hostname: worker.host,
        port: worker.port,
        path: '/api/worker/execute',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': `Bearer ${worker.apiKey}`,
          'X-Job-ID': job.id,
          'X-Priority': job.priority
        },
        timeout: job.timeout
      };

      const client = worker.secure ? https : http;
      const req = client.request(requestOptions, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const result = JSON.parse(responseData);
              resolve(result);
            } else {
              reject(new Error(`Tokyo worker ${worker.name} returned status ${res.statusCode}: ${responseData}`));
            }
          } catch (error) {
            reject(new Error(`Invalid response from Tokyo worker ${worker.name}: ${getErrorMessage(error)}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Network error connecting to Tokyo worker ${worker.name}: ${getErrorMessage(error)}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout connecting to Tokyo worker ${worker.name}`));
      });
      
      req.setTimeout(job.timeout);
      req.write(postData);
      req.end();
    });
  }

  public async waitForJob(jobId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const job = this.activeJobs.get(jobId);
      if (!job) {
        reject(new Error('Job not found'));
        return;
      }

      const timeout = setTimeout(() => {
        this.removeListener('jobCompleted', onCompleted);
        this.removeListener('jobFailed', onFailed);
        reject(new Error('Job timeout waiting for result'));
      }, job.timeout + 30000); // Add 30s buffer

      const onCompleted = (completedJobId: string, result: any) => {
        if (completedJobId === jobId) {
          clearTimeout(timeout);
          this.removeListener('jobCompleted', onCompleted);
          this.removeListener('jobFailed', onFailed);
          resolve(result);
        }
      };

      const onFailed = (failedJobId: string, error: Error) => {
        if (failedJobId === jobId) {
          clearTimeout(timeout);
          this.removeListener('jobCompleted', onCompleted);
          this.removeListener('jobFailed', onFailed);
          reject(error);
        }
      };

      this.on('jobCompleted', onCompleted);
      this.on('jobFailed', onFailed);
    });
  }

  public getTokyoWorkerStats(): any {
    const workers = Array.from(this.workers.values()).map(w => ({
      id: w.id,
      name: w.name,
      region: w.region,
      host: w.host,
      online: w.online,
      currentJobs: w.currentJobs,
      maxJobs: w.maxJobs,
      capabilities: w.capabilities,
      avgResponseTime: w.avgResponseTime,
      loadAverage: w.loadAverage,
      memoryUsage: w.memoryUsage,
      lastSeen: w.online ? 'Online' : `${Math.round((Date.now() - w.lastSeen) / 1000)}s ago`,
      timezone: w.timezone
    }));

    const onlineWorkers = workers.filter(w => w.online);
    const totalCapacity = workers.reduce((sum, w) => sum + w.maxJobs, 0);
    const usedCapacity = workers.reduce((sum, w) => sum + w.currentJobs, 0);

    return {
      totalWorkers: workers.length,
      onlineWorkers: onlineWorkers.length,
      capacity: {
        total: totalCapacity,
        used: usedCapacity,
        available: totalCapacity - usedCapacity,
        utilization: totalCapacity > 0 ? (usedCapacity / totalCapacity) * 100 : 0
      },
      queue: {
        pending: this.jobQueue.length,
        active: this.activeJobs.size,
        total: this.jobQueue.length + this.activeJobs.size
      },
      workers,
      avgResponseTime: onlineWorkers.reduce((sum, w) => sum + w.avgResponseTime, 0) / onlineWorkers.length || 0
    };
  }

  public destroy(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.jobProcessorInterval) clearInterval(this.jobProcessorInterval);
    if (this.metricsCollectionInterval) clearInterval(this.metricsCollectionInterval);

    // Cancel all active jobs
    for (const jobId of this.activeJobs.keys()) {
      this.emit('jobFailed', jobId, new Error('Worker manager shutting down'));
    }

    this.activeJobs.clear();
    this.jobQueue.length = 0;
    this.workers.clear();

    logger.info('Tokyo RemoteWorkerManager destroyed');
  }
}

export const remoteWorkerManager = new RemoteWorkerManager();