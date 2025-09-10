import { WorkerNode } from './workerPool';
import logger from '../config/logger';

interface LoadMetrics {
  cpuUsage: number;
  memoryUsage: number; 
  activeJobs: number;
  responseTime: number;
  queueLength: number;
}

interface LoadBalancingStrategy {
  name: string;
  selectWorker: (workers: WorkerNode[], taskType: string) => WorkerNode | null;
}

export class LoadBalancer {
  private strategies: Map<string, LoadBalancingStrategy> = new Map();
  private currentStrategy: string = 'least-loaded';
  private workerMetrics: Map<string, LoadMetrics> = new Map();

  constructor() {
    this.initializeStrategies();
  }

  private initializeStrategies(): void {
    // Round Robin Strategy
    let roundRobinIndex = 0;
    this.strategies.set('round-robin', {
      name: 'Round Robin',
      selectWorker: (workers: WorkerNode[], taskType: string) => {
        const capableWorkers = workers.filter(w => 
          w.healthy && 
          w.currentJobs < w.maxJobs &&
          (w.capabilities.includes(taskType) || w.capabilities.includes('general'))
        );
        
        if (capableWorkers.length === 0) return null;
        
        const worker = capableWorkers[roundRobinIndex % capableWorkers.length];
        roundRobinIndex++;
        return worker;
      }
    });

    // Least Loaded Strategy  
    this.strategies.set('least-loaded', {
      name: 'Least Loaded',
      selectWorker: (workers: WorkerNode[], taskType: string) => {
        const capableWorkers = workers.filter(w => 
          w.healthy && 
          w.currentJobs < w.maxJobs &&
          (w.capabilities.includes(taskType) || w.capabilities.includes('general'))
        );

        if (capableWorkers.length === 0) return null;

        // Sort by current load (jobs + queue + cpu + memory)
        return capableWorkers.reduce((best, current) => {
          const bestLoad = this.calculateWorkerLoad(best);
          const currentLoad = this.calculateWorkerLoad(current);
          return currentLoad < bestLoad ? current : best;
        });
      }
    });

    // Capability-First Strategy
    this.strategies.set('capability-based', {
      name: 'Capability Based',
      selectWorker: (workers: WorkerNode[], taskType: string) => {
        // First try workers with specific capability
        const specializedWorkers = workers.filter(w => 
          w.healthy && 
          w.currentJobs < w.maxJobs &&
          w.capabilities.includes(taskType)
        );

        if (specializedWorkers.length > 0) {
          // Among specialized workers, pick least loaded
          return specializedWorkers.reduce((best, current) => {
            const bestLoad = this.calculateWorkerLoad(best);
            const currentLoad = this.calculateWorkerLoad(current);
            return currentLoad < bestLoad ? current : best;
          });
        }

        // Fallback to general workers
        const generalWorkers = workers.filter(w => 
          w.healthy && 
          w.currentJobs < w.maxJobs &&
          w.capabilities.includes('general')
        );

        if (generalWorkers.length === 0) return null;

        return generalWorkers.reduce((best, current) => {
          const bestLoad = this.calculateWorkerLoad(best);
          const currentLoad = this.calculateWorkerLoad(current);
          return currentLoad < bestLoad ? current : best;
        });
      }
    });

    // Performance-Based Strategy
    this.strategies.set('performance-based', {
      name: 'Performance Based',
      selectWorker: (workers: WorkerNode[], taskType: string) => {
        const capableWorkers = workers.filter(w => 
          w.healthy && 
          w.currentJobs < w.maxJobs &&
          (w.capabilities.includes(taskType) || w.capabilities.includes('general'))
        );

        if (capableWorkers.length === 0) return null;

        // Select based on performance metrics
        return capableWorkers.reduce((best, current) => {
          const bestScore = this.calculatePerformanceScore(best);
          const currentScore = this.calculatePerformanceScore(current);
          return currentScore > bestScore ? current : best; // Higher score is better
        });
      }
    });

    // Geographic/Affinity Strategy  
    this.strategies.set('affinity-based', {
      name: 'Affinity Based',
      selectWorker: (workers: WorkerNode[], taskType: string) => {
        const capableWorkers = workers.filter(w => 
          w.healthy && 
          w.currentJobs < w.maxJobs &&
          (w.capabilities.includes(taskType) || w.capabilities.includes('general'))
        );

        if (capableWorkers.length === 0) return null;

        // Prefer workers with task type affinity, then by load
        const affinityWorkers = capableWorkers.filter(w => w.capabilities.includes(taskType));
        const targetWorkers = affinityWorkers.length > 0 ? affinityWorkers : capableWorkers;

        return targetWorkers.reduce((best, current) => {
          const bestLoad = this.calculateWorkerLoad(best);
          const currentLoad = this.calculateWorkerLoad(current);
          return currentLoad < bestLoad ? current : best;
        });
      }
    });

    logger.info(`LoadBalancer initialized with ${this.strategies.size} strategies`);
  }

  /**
   * Calculate combined load score for a worker
   */
  private calculateWorkerLoad(worker: WorkerNode): number {
    const metrics = this.workerMetrics.get(worker.id);
    
    if (!metrics) {
      // Base load on current jobs if no metrics
      return (worker.currentJobs / worker.maxJobs) * 100;
    }

    // Weighted load calculation
    const jobLoad = (worker.currentJobs / worker.maxJobs) * 30;      // 30% weight
    const cpuLoad = metrics.cpuUsage * 25;                           // 25% weight  
    const memoryLoad = metrics.memoryUsage * 25;                     // 25% weight
    const queueLoad = Math.min(metrics.queueLength, 10) * 10;       // 10% weight (cap at 10)
    const responseTimeLoad = Math.min(metrics.responseTime / 1000, 10) * 10; // 10% weight (cap at 10s)

    return jobLoad + cpuLoad + memoryLoad + queueLoad + responseTimeLoad;
  }

  /**
   * Calculate performance score for a worker (higher is better)
   */
  private calculatePerformanceScore(worker: WorkerNode): number {
    const metrics = this.workerMetrics.get(worker.id);
    
    if (!metrics) {
      return 50; // Default neutral score
    }

    // Performance scoring (0-100, higher is better)
    const cpuScore = Math.max(0, 100 - metrics.cpuUsage);           // Lower CPU usage = higher score
    const memoryScore = Math.max(0, 100 - metrics.memoryUsage);     // Lower memory usage = higher score
    const responseScore = Math.max(0, 100 - (metrics.responseTime / 50)); // Lower response time = higher score
    const availabilityScore = ((worker.maxJobs - worker.currentJobs) / worker.maxJobs) * 100; // More availability = higher score

    return (cpuScore * 0.3) + (memoryScore * 0.3) + (responseScore * 0.2) + (availabilityScore * 0.2);
  }

  /**
   * Select best worker for a task using current strategy
   */
  selectWorker(workers: WorkerNode[], taskType: string): WorkerNode | null {
    const strategy = this.strategies.get(this.currentStrategy);
    if (!strategy) {
      logger.error(`Unknown load balancing strategy: ${this.currentStrategy}`);
      return null;
    }

    const selectedWorker = strategy.selectWorker(workers, taskType);
    
    if (selectedWorker) {
      logger.debug(`Selected worker ${selectedWorker.id} for task ${taskType} using ${strategy.name}`);
    } else {
      logger.warn(`No suitable worker found for task ${taskType} using ${strategy.name}`);
    }

    return selectedWorker;
  }

  /**
   * Update worker metrics for load balancing decisions
   */
  updateWorkerMetrics(workerId: string, metrics: LoadMetrics): void {
    this.workerMetrics.set(workerId, {
      ...metrics,
      timestamp: Date.now()
    } as any);
  }

  /**
   * Change load balancing strategy
   */
  setStrategy(strategyName: string): boolean {
    if (this.strategies.has(strategyName)) {
      this.currentStrategy = strategyName;
      logger.info(`Load balancing strategy changed to: ${strategyName}`);
      return true;
    }
    
    logger.error(`Invalid load balancing strategy: ${strategyName}`);
    return false;
  }

  /**
   * Get current strategy and available strategies
   */
  getStrategies(): any {
    return {
      current: this.currentStrategy,
      available: Array.from(this.strategies.keys()),
      descriptions: Array.from(this.strategies.values()).map(s => s.name)
    };
  }

  /**
   * Get load balancing statistics
   */
  getLoadBalancingStats(): any {
    const workerStats = Array.from(this.workerMetrics.entries()).map(([id, metrics]) => ({
      workerId: id,
      loadScore: this.calculateWorkerLoad({ id } as WorkerNode),
      performanceScore: this.calculatePerformanceScore({ id } as WorkerNode),
      metrics
    }));

    return {
      strategy: this.currentStrategy,
      totalWorkers: this.workerMetrics.size,
      workerStats,
      averageLoad: workerStats.reduce((sum, w) => sum + w.loadScore, 0) / workerStats.length || 0
    };
  }

  /**
   * Rebalance workload by suggesting job migrations
   */
  suggestRebalancing(workers: WorkerNode[]): any[] {
    const suggestions: any[] = [];
    
    if (workers.length < 2) return suggestions;

    const sortedByLoad = workers
      .filter(w => w.healthy)
      .sort((a, b) => this.calculateWorkerLoad(b) - this.calculateWorkerLoad(a));

    const highLoadWorkers = sortedByLoad.slice(0, Math.ceil(sortedByLoad.length / 2));
    const lowLoadWorkers = sortedByLoad.slice(Math.ceil(sortedByLoad.length / 2));

    for (const highLoadWorker of highLoadWorkers) {
      const highLoad = this.calculateWorkerLoad(highLoadWorker);
      
      for (const lowLoadWorker of lowLoadWorkers) {
        const lowLoad = this.calculateWorkerLoad(lowLoadWorker);
        
        // Suggest rebalancing if load difference > 30%
        if (highLoad - lowLoad > 30) {
          suggestions.push({
            action: 'migrate-jobs',
            from: highLoadWorker.id,
            to: lowLoadWorker.id,
            fromLoad: Math.round(highLoad),
            toLoad: Math.round(lowLoad),
            difference: Math.round(highLoad - lowLoad),
            jobsToMigrate: Math.min(2, highLoadWorker.currentJobs)
          });
        }
      }
    }

    return suggestions;
  }
}

export const loadBalancer = new LoadBalancer();