import { EventEmitter } from 'events';
import { logger } from '../config/logger';
import * as http from 'http';
import * as https from 'https';

interface WorkerNode {
  id: string;
  host: string;
  port: number;
  https?: boolean;
  maxJobs: number;
  currentJobs: number;
  lastHealthCheck: number;
  healthy: boolean;
  capabilities: string[]; // e.g., ['context7', 'cipher', 'heavy-compute']
}

interface Job {
  id: string;
  type: string;
  payload: any;
  timeout: number;
  retries: number;
  maxRetries: number;
  assignedWorker?: string;
  createdAt: number;
  startedAt?: number;
}

export class WorkerPool extends EventEmitter {
  private workers: Map<string, WorkerNode> = new Map();
  private jobs: Map<string, Job> = new Map();
  private jobQueue: Job[] = [];
  private healthCheckInterval: NodeJS.Timeout;
  private jobProcessorInterval: NodeJS.Timeout;

  constructor() {
    super();
    
    // Health check every 30 seconds
    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, 30000);

    // Process job queue every 5 seconds
    this.jobProcessorInterval = setInterval(() => {
      this.processJobQueue();
    }, 5000);

    this.setupDefaultWorkers();
  }

  private setupDefaultWorkers(): void {
    // Add worker nodes from environment variables
    const workerConfigs = process.env.WORKER_NODES || '';
    
    if (workerConfigs) {
      const workers = workerConfigs.split(',');
      for (const workerConfig of workers) {
        const [host, port, capabilities] = workerConfig.split(':');
        if (host && port) {
          this.addWorker({
            id: `${host}:${port}`,
            host,
            port: parseInt(port),
            maxJobs: 3, // Conservative limit for memory
            currentJobs: 0,
            lastHealthCheck: 0,
            healthy: false,
            capabilities: capabilities ? capabilities.split('|') : ['general']
          });
        }
      }
    }

    // If no workers configured, add localhost as fallback
    if (this.workers.size === 0) {
      logger.info('No worker nodes configured, using localhost as worker');
      this.addWorker({
        id: 'localhost:3002',
        host: 'localhost',
        port: 3002,
        maxJobs: 1, // Very conservative for main VM
        currentJobs: 0,
        lastHealthCheck: 0,
        healthy: false,
        capabilities: ['context7', 'cipher', 'light-compute']
      });
    }
  }

  addWorker(worker: WorkerNode): void {
    this.workers.set(worker.id, worker);
    logger.info(`Added worker node: ${worker.id} with capabilities: ${worker.capabilities.join(', ')}`);
  }

  removeWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      // Cancel running jobs on this worker
      for (const [jobId, job] of this.jobs.entries()) {
        if (job.assignedWorker === workerId) {
          job.assignedWorker = undefined;
          job.retries++;
          if (job.retries <= job.maxRetries) {
            this.jobQueue.unshift(job); // Retry with higher priority
          } else {
            this.jobs.delete(jobId);
            this.emit('jobFailed', jobId, new Error('Worker removed and max retries exceeded'));
          }
        }
      }
      
      this.workers.delete(workerId);
      logger.info(`Removed worker node: ${workerId}`);
    }
  }

  private async performHealthChecks(): Promise<void> {
    const healthCheckPromises = Array.from(this.workers.values()).map(async (worker) => {
      try {
        const healthy = await this.checkWorkerHealth(worker);
        worker.healthy = healthy;
        worker.lastHealthCheck = Date.now();
        
        if (!healthy && worker.currentJobs > 0) {
          // Mark jobs as failed if worker is unhealthy
          for (const [jobId, job] of this.jobs.entries()) {
            if (job.assignedWorker === worker.id) {
              job.assignedWorker = undefined;
              job.retries++;
              if (job.retries <= job.maxRetries) {
                this.jobQueue.unshift(job);
              } else {
                this.jobs.delete(jobId);
                this.emit('jobFailed', jobId, new Error('Worker health check failed'));
              }
            }
          }
          worker.currentJobs = 0;
        }
      } catch (error) {
        logger.error(`Health check failed for worker ${worker.id}:`, error);
        worker.healthy = false;
      }
    });

    await Promise.allSettled(healthCheckPromises);
  }

  private async checkWorkerHealth(worker: WorkerNode): Promise<boolean> {
    return new Promise((resolve) => {
      const requestOptions = {
        hostname: worker.host,
        port: worker.port,
        path: '/health',
        method: 'GET',
        timeout: 5000
      };

      const client = worker.https ? https : http;
      const req = client.request(requestOptions, (res) => {
        resolve(res.statusCode === 200);
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => resolve(false));
      req.setTimeout(5000);
      req.end();
    });
  }

  async submitJob(type: string, payload: any, timeout: number = 60000): Promise<string> {
    const job: Job = {
      id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      payload,
      timeout,
      retries: 0,
      maxRetries: 2,
      createdAt: Date.now()
    };

    this.jobs.set(job.id, job);
    this.jobQueue.push(job);
    
    logger.info(`Job ${job.id} (${type}) submitted to queue`);
    return job.id;
  }

  private processJobQueue(): void {
    if (this.jobQueue.length === 0) return;

    const availableWorkers = Array.from(this.workers.values())
      .filter(w => w.healthy && w.currentJobs < w.maxJobs)
      .sort((a, b) => a.currentJobs - b.currentJobs); // Prefer less loaded workers

    for (const job of this.jobQueue.slice()) {
      const suitableWorker = availableWorkers.find(w => 
        w.capabilities.includes(job.type) || w.capabilities.includes('general')
      );

      if (suitableWorker) {
        this.assignJobToWorker(job, suitableWorker);
        this.jobQueue.splice(this.jobQueue.indexOf(job), 1);
        suitableWorker.currentJobs++;
        
        // Remove from available workers if at capacity
        if (suitableWorker.currentJobs >= suitableWorker.maxJobs) {
          availableWorkers.splice(availableWorkers.indexOf(suitableWorker), 1);
        }
      }
    }
  }

  private async assignJobToWorker(job: Job, worker: WorkerNode): Promise<void> {
    job.assignedWorker = worker.id;
    job.startedAt = Date.now();

    logger.info(`Assigning job ${job.id} to worker ${worker.id}`);

    try {
      const result = await this.executeJobOnWorker(job, worker);
      
      worker.currentJobs = Math.max(0, worker.currentJobs - 1);
      this.jobs.delete(job.id);
      this.emit('jobCompleted', job.id, result);
      
    } catch (error) {
      worker.currentJobs = Math.max(0, worker.currentJobs - 1);
      job.retries++;
      
      if (job.retries <= job.maxRetries) {
        job.assignedWorker = undefined;
        this.jobQueue.unshift(job); // Retry with higher priority
        logger.warn(`Job ${job.id} failed on worker ${worker.id}, retrying (${job.retries}/${job.maxRetries})`);
      } else {
        this.jobs.delete(job.id);
        this.emit('jobFailed', job.id, error);
        logger.error(`Job ${job.id} failed permanently after ${job.retries} retries`);
      }
    }
  }

  private async executeJobOnWorker(job: Job, worker: WorkerNode): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        jobId: job.id,
        type: job.type,
        payload: job.payload
      });

      const requestOptions = {
        hostname: worker.host,
        port: worker.port,
        path: '/api/worker/execute',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: job.timeout
      };

      const client = worker.https ? https : http;
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
              reject(new Error(`Worker returned status ${res.statusCode}: ${responseData}`));
            }
          } catch (error) {
            reject(new Error(`Invalid response from worker: ${error.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => reject(new Error('Job execution timeout')));
      req.setTimeout(job.timeout);
      
      req.write(postData);
      req.end();
    });
  }

  async waitForJob(jobId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const job = this.jobs.get(jobId);
      if (!job) {
        reject(new Error('Job not found'));
        return;
      }

      const onCompleted = (completedJobId: string, result: any) => {
        if (completedJobId === jobId) {
          this.removeListener('jobCompleted', onCompleted);
          this.removeListener('jobFailed', onFailed);
          resolve(result);
        }
      };

      const onFailed = (failedJobId: string, error: Error) => {
        if (failedJobId === jobId) {
          this.removeListener('jobCompleted', onCompleted);
          this.removeListener('jobFailed', onFailed);
          reject(error);
        }
      };

      this.on('jobCompleted', onCompleted);
      this.on('jobFailed', onFailed);

      // Timeout after 10 minutes
      setTimeout(() => {
        this.removeListener('jobCompleted', onCompleted);
        this.removeListener('jobFailed', onFailed);
        reject(new Error('Job timeout'));
      }, 600000);
    });
  }

  getStats(): any {
    const workers = Array.from(this.workers.values()).map(w => ({
      id: w.id,
      healthy: w.healthy,
      currentJobs: w.currentJobs,
      maxJobs: w.maxJobs,
      capabilities: w.capabilities,
      lastHealthCheck: new Date(w.lastHealthCheck).toISOString()
    }));

    return {
      totalWorkers: this.workers.size,
      healthyWorkers: workers.filter(w => w.healthy).length,
      queuedJobs: this.jobQueue.length,
      activeJobs: this.jobs.size,
      workers
    };
  }

  destroy(): void {
    clearInterval(this.healthCheckInterval);
    clearInterval(this.jobProcessorInterval);
    
    // Cancel all jobs
    for (const jobId of this.jobs.keys()) {
      this.emit('jobFailed', jobId, new Error('Worker pool shutting down'));
    }
    
    this.jobs.clear();
    this.jobQueue.length = 0;
    this.workers.clear();
  }
}

export const workerPool = new WorkerPool();