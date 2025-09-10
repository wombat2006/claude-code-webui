import { EventEmitter } from 'events';
import { vmstatSarMonitor } from './vmstatMonitor';
import logger from '../config/logger';

interface NodeCapabilities {
  id: string;
  region: 'us-east-1' | 'ap-northeast-1';
  instanceType: 'c8gd.medium' | 't4g.medium';
  
  // Hardware specs
  vCPUs: number;
  memoryGB: number;
  architecture: 'graviton4' | 'graviton2';
  
  // Current utilization
  cpuUtilization: number;
  memoryUtilization: number;
  networkUtilization: number;
  
  // Instance-specific metrics
  cpuCredits?: number;        // For t4g instances
  cpuCreditBalance?: number;  // For t4g instances
  isBurstable: boolean;
  
  // Geographic factors
  latencyMs: number;
  
  // Availability
  healthy: boolean;
  lastSeen: number;
}

interface TaskRequirements {
  type: string;
  estimatedCPU: number;      // 0-100%
  estimatedMemoryMB: number;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  latencySensitive: boolean;
  canBeBatched: boolean;
  parallelizable: boolean;
}

interface RoutingDecision {
  targetNode: string;
  confidence: number;        // 0-100%
  reasoning: string[];
  estimatedLatency: number;
  fallbackNode?: string;
}

export class InstanceAwareLoadBalancer extends EventEmitter {
  private nodes: Map<string, NodeCapabilities> = new Map();
  private taskHistory: Map<string, { node: string; duration: number; success: boolean }[]> = new Map();
  private routingRules: Map<string, (task: TaskRequirements, nodes: NodeCapabilities[]) => RoutingDecision> = new Map();

  constructor() {
    super();
    this.initializeNodes();
    this.setupRoutingRules();
    this.startMonitoring();
  }

  private initializeNodes(): void {
    // Main VM (us-east-1 c8gd.medium)
    this.nodes.set('main-vm', {
      id: 'main-vm',
      region: 'us-east-1',
      instanceType: 'c8gd.medium',
      vCPUs: 1,
      memoryGB: 2,
      architecture: 'graviton4',
      cpuUtilization: 0,
      memoryUtilization: 0,
      networkUtilization: 0,
      isBurstable: false,
      latencyMs: 0, // Local
      healthy: true,
      lastSeen: Date.now()
    });

    // Tokyo Co-node (ap-northeast-1 t4g.medium)
    this.nodes.set('tokyo-conode', {
      id: 'tokyo-conode',
      region: 'ap-northeast-1',
      instanceType: 't4g.medium',
      vCPUs: 2,
      memoryGB: 4,
      architecture: 'graviton2',
      cpuUtilization: 0,
      memoryUtilization: 0,
      networkUtilization: 0,
      cpuCredits: 24, // per hour
      cpuCreditBalance: 144, // max credits
      isBurstable: true,
      latencyMs: 150, // us-east-1 to ap-northeast-1
      healthy: true,
      lastSeen: Date.now()
    });

    logger.info('Initialized instance-aware load balancer with 2 nodes');
  }

  private setupRoutingRules(): void {
    // Rule 1: Memory-intensive tasks go to Tokyo if main VM is under pressure
    this.routingRules.set('memory-pressure-routing', (task: TaskRequirements, nodes: NodeCapabilities[]) => {
      const mainVM = nodes.find(n => n.id === 'main-vm')!;
      const tokyoNode = nodes.find(n => n.id === 'tokyo-conode')!;

      const reasoning: string[] = [];
      
      if (task.estimatedMemoryMB > 500) { // > 500MB
        reasoning.push(`High memory requirement: ${task.estimatedMemoryMB}MB`);
        
        if (mainVM.memoryUtilization > 60) { // Main VM under pressure
          reasoning.push(`Main VM memory pressure: ${mainVM.memoryUtilization.toFixed(1)}%`);
          return {
            targetNode: 'tokyo-conode',
            confidence: 85,
            reasoning,
            estimatedLatency: tokyoNode.latencyMs + 1000, // +1s processing
            fallbackNode: 'main-vm'
          };
        }
      }

      return {
        targetNode: 'main-vm',
        confidence: 70,
        reasoning: ['Default to main VM for memory tasks'],
        estimatedLatency: 100
      };
    });

    // Rule 2: CPU-intensive parallelizable tasks prefer Tokyo's 2 vCPUs
    this.routingRules.set('cpu-parallelizable-routing', (task: TaskRequirements, nodes: NodeCapabilities[]) => {
      const mainVM = nodes.find(n => n.id === 'main-vm')!;
      const tokyoNode = nodes.find(n => n.id === 'tokyo-conode')!;

      const reasoning: string[] = [];

      if (task.parallelizable && task.estimatedCPU > 50) {
        reasoning.push(`Parallelizable high CPU task: ${task.estimatedCPU}%`);
        
        // Check Tokyo's CPU credits
        if (tokyoNode.cpuCreditBalance && tokyoNode.cpuCreditBalance > 50) {
          reasoning.push(`Tokyo has sufficient CPU credits: ${tokyoNode.cpuCreditBalance}`);
          return {
            targetNode: 'tokyo-conode',
            confidence: 90,
            reasoning,
            estimatedLatency: tokyoNode.latencyMs + 500,
            fallbackNode: 'main-vm'
          };
        } else if (tokyoNode.cpuCreditBalance) {
          reasoning.push(`Tokyo low on CPU credits: ${tokyoNode.cpuCreditBalance}`);
        }
      }

      // Single-threaded intensive tasks prefer main VM's Graviton4
      if (!task.parallelizable && task.estimatedCPU > 60) {
        reasoning.push(`Single-threaded intensive task favors Graviton4`);
        return {
          targetNode: 'main-vm',
          confidence: 85,
          reasoning,
          estimatedLatency: 200,
          fallbackNode: 'tokyo-conode'
        };
      }

      return {
        targetNode: 'main-vm',
        confidence: 60,
        reasoning: ['Default routing for CPU tasks'],
        estimatedLatency: 100
      };
    });

    // Rule 3: Latency-sensitive tasks stay local unless main VM is overloaded
    this.routingRules.set('latency-sensitive-routing', (task: TaskRequirements, nodes: NodeCapabilities[]) => {
      const mainVM = nodes.find(n => n.id === 'main-vm')!;
      
      const reasoning: string[] = [];

      if (task.latencySensitive) {
        reasoning.push('Latency-sensitive task');
        
        if (mainVM.cpuUtilization > 80 || mainVM.memoryUtilization > 85) {
          reasoning.push(`Main VM overloaded: CPU ${mainVM.cpuUtilization}%, MEM ${mainVM.memoryUtilization}%`);
          return {
            targetNode: 'tokyo-conode',
            confidence: 75,
            reasoning,
            estimatedLatency: 150 + 800, // Network + processing
            fallbackNode: 'main-vm'
          };
        }

        return {
          targetNode: 'main-vm',
          confidence: 95,
          reasoning,
          estimatedLatency: 50
        };
      }

      return {
        targetNode: 'main-vm',
        confidence: 50,
        reasoning: ['Non-latency-sensitive, default to main'],
        estimatedLatency: 100
      };
    });

    // Rule 4: Batch processing tasks prefer Tokyo for better resource isolation
    this.routingRules.set('batch-processing-routing', (task: TaskRequirements, nodes: NodeCapabilities[]) => {
      const tokyoNode = nodes.find(n => n.id === 'tokyo-conode')!;
      
      const reasoning: string[] = [];

      if (task.canBeBatched || task.type.includes('batch') || task.type.includes('build')) {
        reasoning.push('Batch processing task identified');
        
        // Check if Tokyo has capacity
        if (tokyoNode.healthy && tokyoNode.cpuUtilization < 70 && tokyoNode.memoryUtilization < 80) {
          reasoning.push(`Tokyo has capacity: CPU ${tokyoNode.cpuUtilization}%, MEM ${tokyoNode.memoryUtilization}%`);
          return {
            targetNode: 'tokyo-conode',
            confidence: 80,
            reasoning,
            estimatedLatency: tokyoNode.latencyMs + 2000, // Longer processing
            fallbackNode: 'main-vm'
          };
        } else {
          reasoning.push('Tokyo at capacity, fallback to main');
        }
      }

      return {
        targetNode: 'main-vm',
        confidence: 60,
        reasoning,
        estimatedLatency: 500
      };
    });

    logger.info(`Configured ${this.routingRules.size} routing rules`);
  }

  private startMonitoring(): void {
    // Update main VM metrics every 10 seconds
    setInterval(() => {
      this.updateMainVMMetrics();
    }, 10000);

    // Update Tokyo co-node metrics every 30 seconds
    setInterval(() => {
      this.updateTokyoCoNodeMetrics();
    }, 30000);

    logger.info('Started instance metrics monitoring');
  }

  private updateMainVMMetrics(): void {
    const mainVM = this.nodes.get('main-vm');
    if (!mainVM) return;

    const vmstatData = vmstatSarMonitor.getVmstatData();
    const sarData = vmstatSarMonitor.getSarData();

    if (vmstatData && sarData) {
      mainVM.cpuUtilization = 100 - sarData.cpuIdle;
      mainVM.memoryUtilization = sarData.memUtilization;
      mainVM.networkUtilization = 0; // Would need to implement network monitoring
      mainVM.healthy = sarData.loadAvg1 < 2.0; // Load average threshold
      mainVM.lastSeen = Date.now();

      // Emit alerts if thresholds exceeded
      if (mainVM.memoryUtilization > 80) {
        this.emit('mainVMMemoryPressure', mainVM.memoryUtilization);
      }
      if (mainVM.cpuUtilization > 90) {
        this.emit('mainVMCPUPressure', mainVM.cpuUtilization);
      }
    }
  }

  private async updateTokyoCoNodeMetrics(): Promise<void> {
    const tokyoNode = this.nodes.get('tokyo-conode');
    if (!tokyoNode) return;

    try {
      // Would call Tokyo co-node health endpoint
      // For now, simulate with some realistic values
      const mockHealth = {
        cpuUtilization: Math.random() * 40, // 0-40%
        memoryUtilization: Math.random() * 60, // 0-60%
        cpuCreditBalance: Math.max(0, (tokyoNode.cpuCreditBalance || 144) - Math.random() * 10)
      };

      tokyoNode.cpuUtilization = mockHealth.cpuUtilization;
      tokyoNode.memoryUtilization = mockHealth.memoryUtilization;
      tokyoNode.cpuCreditBalance = mockHealth.cpuCreditBalance;
      tokyoNode.healthy = mockHealth.cpuCreditBalance > 10;
      tokyoNode.lastSeen = Date.now();

      // Emit alerts for Tokyo co-node
      if (tokyoNode.cpuCreditBalance && tokyoNode.cpuCreditBalance < 20) {
        this.emit('tokyoCPUCreditsLow', tokyoNode.cpuCreditBalance);
      }

    } catch (error) {
      logger.error('Failed to update Tokyo co-node metrics:', error instanceof Error ? error : new Error(String(error)));
      tokyoNode.healthy = false;
    }
  }

  public routeTask(taskType: string, requirements: Partial<TaskRequirements> = {}): RoutingDecision {
    const task: TaskRequirements = {
      type: taskType,
      estimatedCPU: requirements.estimatedCPU || this.estimateCPURequirement(taskType),
      estimatedMemoryMB: requirements.estimatedMemoryMB || this.estimateMemoryRequirement(taskType),
      priority: requirements.priority || 'normal',
      latencySensitive: requirements.latencySensitive ?? this.isLatencySensitive(taskType),
      canBeBatched: requirements.canBeBatched ?? this.canBeBatched(taskType),
      parallelizable: requirements.parallelizable ?? this.isParallelizable(taskType)
    };

    const availableNodes = Array.from(this.nodes.values()).filter(n => n.healthy);
    
    if (availableNodes.length === 0) {
      throw new Error('No healthy nodes available');
    }

    // Apply routing rules in priority order
    const ruleResults: RoutingDecision[] = [];

    for (const [ruleName, rule] of this.routingRules.entries()) {
      try {
        const decision = rule(task, availableNodes);
        decision.reasoning.unshift(`Rule: ${ruleName}`);
        ruleResults.push(decision);
      } catch (error) {
        logger.error(`Routing rule ${ruleName} failed:`, error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Select best decision based on confidence
    const bestDecision = ruleResults.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    );

    // Log routing decision
    logger.info(`Task ${taskType} routed to ${bestDecision.targetNode}`, {
      confidence: bestDecision.confidence,
      reasoning: bestDecision.reasoning,
      estimatedLatency: bestDecision.estimatedLatency,
      task: task
    });

    // Track for learning
    this.trackRoutingDecision(taskType, bestDecision);

    return bestDecision;
  }

  private estimateCPURequirement(taskType: string): number {
    const cpuRequirements: { [key: string]: number } = {
      'context7': 30,
      'cipher': 40,
      'mcp-call': 20,
      'build': 80,
      'compilation': 90,
      'test': 60,
      'ai': 70,
      'llm': 75,
      'simple-query': 10,
      'cache': 5,
      'health-check': 2
    };

    return cpuRequirements[taskType] || 25; // Default 25%
  }

  private estimateMemoryRequirement(taskType: string): number {
    const memoryRequirements: { [key: string]: number } = {
      'context7': 800,
      'cipher': 600,
      'mcp-call': 300,
      'build': 1200,
      'compilation': 1500,
      'test': 800,
      'ai': 1000,
      'llm': 1200,
      'simple-query': 50,
      'cache': 100,
      'health-check': 20
    };

    return memoryRequirements[taskType] || 200; // Default 200MB
  }

  private isLatencySensitive(taskType: string): boolean {
    const latencySensitiveTasks = [
      'simple-query', 'cache', 'health-check', 'user-interaction'
    ];
    return latencySensitiveTasks.includes(taskType);
  }

  private canBeBatched(taskType: string): boolean {
    const batchableTasks = [
      'build', 'compilation', 'test', 'analysis', 'batch-process'
    ];
    return batchableTasks.includes(taskType);
  }

  private isParallelizable(taskType: string): boolean {
    const parallelizableTasks = [
      'build', 'test', 'analysis', 'batch-process', 'ai'
    ];
    return parallelizableTasks.includes(taskType);
  }

  private trackRoutingDecision(taskType: string, decision: RoutingDecision): void {
    if (!this.taskHistory.has(taskType)) {
      this.taskHistory.set(taskType, []);
    }

    // This would be populated when task completes
    // For now, just track the routing decision
    const history = this.taskHistory.get(taskType)!;
    history.push({
      node: decision.targetNode,
      duration: 0, // Will be updated when task completes
      success: true // Will be updated when task completes
    });

    // Keep only last 100 entries per task type
    if (history.length > 100) {
      history.shift();
    }
  }

  public getNodeStats(): any {
    return {
      nodes: Array.from(this.nodes.entries()).map(([id, node]) => ({
        id,
        ...node,
        utilizationSummary: {
          cpu: `${node.cpuUtilization.toFixed(1)}%`,
          memory: `${node.memoryUtilization.toFixed(1)}%`,
          credits: node.isBurstable ? node.cpuCreditBalance : 'N/A'
        }
      })),
      routingRules: Array.from(this.routingRules.keys()),
      taskHistory: Object.fromEntries(
        Array.from(this.taskHistory.entries()).map(([type, history]) => [
          type,
          {
            totalRequests: history.length,
            successRate: history.filter(h => h.success).length / history.length,
            avgDuration: history.reduce((sum, h) => sum + h.duration, 0) / history.length,
            preferredNode: this.getPreferredNode(history)
          }
        ])
      )
    };
  }

  private getPreferredNode(history: any[]): string {
    const nodeCounts = history.reduce((counts: any, entry) => {
      counts[entry.node] = (counts[entry.node] || 0) + 1;
      return counts;
    }, {});

    return Object.entries(nodeCounts)
      .sort(([,a]: any, [,b]: any) => b - a)[0]?.[0] || 'unknown';
  }
}

export const instanceAwareLoadBalancer = new InstanceAwareLoadBalancer();