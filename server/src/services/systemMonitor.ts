import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { logger } from '../config/logger';
import { loadBalancer } from './loadBalancer';

const execAsync = promisify(exec);

interface SystemMetrics {
  loadAverage: {
    oneMinute: number;
    fiveMinute: number;
    fifteenMinute: number;
  };
  cpu: {
    usage: number;
    cores: number;
    model: string;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usedPercent: number;
    available: number;
  };
  disk: {
    total: number;
    free: number;
    used: number;
    usedPercent: number;
  };
  network: {
    interfaces: any[];
    connections: number;
  };
  processes: {
    total: number;
    running: number;
    sleeping: number;
    zombie: number;
  };
  uptime: number;
  timestamp: number;
}

interface LoadThresholds {
  warning: number;
  critical: number;
  emergency: number;
}

export class SystemMonitor {
  private metrics: SystemMetrics | null = null;
  private monitoringInterval?: NodeJS.Timeout;
  private loadThresholds: LoadThresholds;
  private alertCallbacks: Array<(metric: string, level: string, value: number) => void> = [];

  constructor() {
    // Set load average thresholds based on CPU count
    this.loadThresholds = {
      warning: 0.7,   // 70% of CPU cores
      critical: 1.0,  // 100% of CPU cores  
      emergency: 1.5  // 150% of CPU cores
    };

    this.initializeMonitoring();
  }

  private async initializeMonitoring(): Promise<void> {
    try {
      // Get initial metrics to set proper thresholds
      await this.collectMetrics();
      
      if (this.metrics) {
        const cores = this.metrics.cpu.cores;
        this.loadThresholds = {
          warning: cores * 0.7,
          critical: cores * 1.0,
          emergency: cores * 1.5
        };
      }

      // Start continuous monitoring
      this.startMonitoring();
      
      logger.info('SystemMonitor initialized', {
        thresholds: this.loadThresholds,
        cores: this.metrics?.cpu.cores
      });
    } catch (error) {
      logger.error('Failed to initialize SystemMonitor:', error);
    }
  }

  private startMonitoring(interval: number = 10000): void {
    // Monitor every 10 seconds by default
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.collectMetrics();
        this.checkThresholds();
      } catch (error) {
        logger.error('Monitoring cycle failed:', error);
      }
    }, interval);

    logger.info(`System monitoring started with ${interval}ms interval`);
  }

  private async collectMetrics(): Promise<void> {
    try {
      const [loadAvg, cpuInfo, memInfo, diskInfo, netInfo, procInfo] = await Promise.all([
        this.getLoadAverage(),
        this.getCPUInfo(),
        this.getMemoryInfo(), 
        this.getDiskInfo(),
        this.getNetworkInfo(),
        this.getProcessInfo()
      ]);

      this.metrics = {
        loadAverage: loadAvg,
        cpu: cpuInfo,
        memory: memInfo,
        disk: diskInfo,
        network: netInfo,
        processes: procInfo,
        uptime: process.uptime(),
        timestamp: Date.now()
      };

      // Update load balancer with current metrics
      if (loadAvg.oneMinute > 0) {
        loadBalancer.updateWorkerMetrics('localhost', {
          cpuUsage: cpuInfo.usage,
          memoryUsage: memInfo.usedPercent,
          activeJobs: 0, // Will be updated separately
          responseTime: 0, // Will be updated separately  
          queueLength: 0 // Will be updated separately
        });
      }

    } catch (error) {
      logger.error('Failed to collect system metrics:', error);
    }
  }

  private async getLoadAverage(): Promise<{ oneMinute: number; fiveMinute: number; fifteenMinute: number }> {
    try {
      // Read from /proc/loadavg on Linux
      const loadavg = await fs.promises.readFile('/proc/loadavg', 'utf8');
      const [one, five, fifteen] = loadavg.trim().split(' ').map(parseFloat);
      
      return {
        oneMinute: one || 0,
        fiveMinute: five || 0,
        fifteenMinute: fifteen || 0
      };
    } catch (error) {
      // Fallback to Node.js os.loadavg() if /proc/loadavg not available
      const os = require('os');
      const [one, five, fifteen] = os.loadavg();
      return {
        oneMinute: one || 0,
        fiveMinute: five || 0, 
        fifteenMinute: fifteen || 0
      };
    }
  }

  private async getCPUInfo(): Promise<{ usage: number; cores: number; model: string }> {
    try {
      const os = require('os');
      const cpus = os.cpus();
      
      // Get CPU usage via /proc/stat
      const stat1 = await fs.promises.readFile('/proc/stat', 'utf8');
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
      const stat2 = await fs.promises.readFile('/proc/stat', 'utf8');
      
      const usage = this.calculateCPUUsage(stat1, stat2);
      
      return {
        usage: usage || 0,
        cores: cpus.length,
        model: cpus[0]?.model || 'Unknown'
      };
    } catch (error) {
      const os = require('os');
      const cpus = os.cpus();
      return {
        usage: 0,
        cores: cpus.length,
        model: cpus[0]?.model || 'Unknown'
      };
    }
  }

  private calculateCPUUsage(stat1: string, stat2: string): number {
    try {
      const getCPUTimes = (stat: string) => {
        const line = stat.split('\n')[0];
        const times = line.split(/\s+/).slice(1).map(Number);
        return {
          idle: times[3] || 0,
          total: times.reduce((a, b) => a + b, 0)
        };
      };

      const times1 = getCPUTimes(stat1);
      const times2 = getCPUTimes(stat2);

      const totalDiff = times2.total - times1.total;
      const idleDiff = times2.idle - times1.idle;

      if (totalDiff === 0) return 0;
      return Math.max(0, Math.min(100, 100 * (1 - idleDiff / totalDiff)));
    } catch {
      return 0;
    }
  }

  private async getMemoryInfo(): Promise<any> {
    try {
      const meminfo = await fs.promises.readFile('/proc/meminfo', 'utf8');
      const lines = meminfo.split('\n');
      
      const getValue = (key: string): number => {
        const line = lines.find(l => l.startsWith(key));
        if (!line) return 0;
        const match = line.match(/(\d+)/);
        return match ? parseInt(match[1]) * 1024 : 0; // Convert KB to bytes
      };

      const total = getValue('MemTotal');
      const free = getValue('MemFree');
      const available = getValue('MemAvailable');
      const buffers = getValue('Buffers');
      const cached = getValue('Cached');
      
      const used = total - free - buffers - cached;
      const usedPercent = total > 0 ? (used / total) * 100 : 0;

      return {
        total,
        free,
        used,
        usedPercent,
        available: available || free + buffers + cached
      };
    } catch (error) {
      const usage = process.memoryUsage();
      return {
        total: 1024 * 1024 * 1024, // Default 1GB
        free: usage.rss,
        used: usage.rss,
        usedPercent: 50,
        available: usage.rss
      };
    }
  }

  private async getDiskInfo(): Promise<any> {
    try {
      const { stdout } = await execAsync("df -h / | tail -1 | awk '{print $2, $3, $4, $5}'");
      const [total, used, free, percent] = stdout.trim().split(' ');
      
      return {
        total: this.parseSize(total),
        used: this.parseSize(used),
        free: this.parseSize(free),
        usedPercent: parseFloat(percent.replace('%', ''))
      };
    } catch (error) {
      return {
        total: 0,
        used: 0,
        free: 0,
        usedPercent: 0
      };
    }
  }

  private parseSize(size: string): number {
    const units: any = { 'K': 1024, 'M': 1024**2, 'G': 1024**3, 'T': 1024**4 };
    const match = size.match(/^(\d+(?:\.\d+)?)([KMGT]?)$/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2] || '';
    return value * (units[unit] || 1);
  }

  private async getNetworkInfo(): Promise<any> {
    try {
      const { stdout } = await execAsync('ss -tuln | wc -l');
      const connections = parseInt(stdout.trim()) || 0;

      return {
        interfaces: [],
        connections: Math.max(0, connections - 1) // Subtract header line
      };
    } catch (error) {
      return {
        interfaces: [],
        connections: 0
      };
    }
  }

  private async getProcessInfo(): Promise<any> {
    try {
      const { stdout } = await execAsync("ps -eo stat --no-headers | sort | uniq -c");
      const lines = stdout.trim().split('\n');
      
      let running = 0, sleeping = 0, zombie = 0, total = 0;
      
      for (const line of lines) {
        const match = line.trim().match(/(\d+)\s+(.+)/);
        if (match) {
          const count = parseInt(match[1]);
          const state = match[2].charAt(0);
          total += count;
          
          if (state === 'R') running += count;
          else if (state === 'S' || state === 'I') sleeping += count;
          else if (state === 'Z') zombie += count;
        }
      }

      return { total, running, sleeping, zombie };
    } catch (error) {
      return { total: 0, running: 0, sleeping: 0, zombie: 0 };
    }
  }

  private checkThresholds(): void {
    if (!this.metrics) return;

    const { loadAverage, cpu, memory, disk } = this.metrics;

    // Check load average (most critical for workload distribution)
    this.checkLoadAverageThresholds(loadAverage);
    
    // Check other metrics
    this.checkMetricThreshold('cpu', cpu.usage, 80, 95, 98);
    this.checkMetricThreshold('memory', memory.usedPercent, 80, 90, 95);
    this.checkMetricThreshold('disk', disk.usedPercent, 85, 95, 98);
  }

  private checkLoadAverageThresholds(loadAvg: any): void {
    const current = loadAvg.oneMinute;
    
    if (current >= this.loadThresholds.emergency) {
      this.triggerAlert('load_average', 'emergency', current);
    } else if (current >= this.loadThresholds.critical) {
      this.triggerAlert('load_average', 'critical', current);
    } else if (current >= this.loadThresholds.warning) {
      this.triggerAlert('load_average', 'warning', current);
    }
  }

  private checkMetricThreshold(metric: string, value: number, warning: number, critical: number, emergency: number): void {
    if (value >= emergency) {
      this.triggerAlert(metric, 'emergency', value);
    } else if (value >= critical) {
      this.triggerAlert(metric, 'critical', value);
    } else if (value >= warning) {
      this.triggerAlert(metric, 'warning', value);
    }
  }

  private triggerAlert(metric: string, level: string, value: number): void {
    logger.warn(`${level.toUpperCase()} ALERT: ${metric} = ${value.toFixed(2)}`, {
      metric,
      level,
      value,
      thresholds: this.loadThresholds,
      timestamp: new Date().toISOString()
    });

    // Call registered alert callbacks
    this.alertCallbacks.forEach(callback => {
      try {
        callback(metric, level, value);
      } catch (error) {
        logger.error('Alert callback failed:', error);
      }
    });
  }

  public onAlert(callback: (metric: string, level: string, value: number) => void): void {
    this.alertCallbacks.push(callback);
  }

  public getMetrics(): SystemMetrics | null {
    return this.metrics;
  }

  public getCurrentLoad(): number {
    return this.metrics?.loadAverage.oneMinute || 0;
  }

  public isSystemUnderPressure(): boolean {
    if (!this.metrics) return false;
    
    const { loadAverage, cpu, memory } = this.metrics;
    
    return (
      loadAverage.oneMinute >= this.loadThresholds.warning ||
      cpu.usage >= 80 ||
      memory.usedPercent >= 80
    );
  }

  public getHealthStatus(): any {
    if (!this.metrics) return { status: 'unknown' };

    const { loadAverage, cpu, memory, disk } = this.metrics;
    const load = loadAverage.oneMinute;
    
    let status = 'healthy';
    const issues: string[] = [];

    if (load >= this.loadThresholds.emergency) {
      status = 'critical';
      issues.push(`Load average critically high: ${load.toFixed(2)}`);
    } else if (load >= this.loadThresholds.critical) {
      status = 'warning';
      issues.push(`Load average high: ${load.toFixed(2)}`);
    }

    if (cpu.usage >= 95) {
      status = 'critical';
      issues.push(`CPU usage critically high: ${cpu.usage.toFixed(1)}%`);
    } else if (cpu.usage >= 80) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push(`CPU usage high: ${cpu.usage.toFixed(1)}%`);
    }

    if (memory.usedPercent >= 95) {
      status = 'critical';
      issues.push(`Memory usage critically high: ${memory.usedPercent.toFixed(1)}%`);
    } else if (memory.usedPercent >= 80) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push(`Memory usage high: ${memory.usedPercent.toFixed(1)}%`);
    }

    return {
      status,
      load: load,
      loadThreshold: this.loadThresholds,
      cpu: cpu.usage,
      memory: memory.usedPercent,
      disk: disk.usedPercent,
      issues,
      timestamp: this.metrics.timestamp
    };
  }

  public destroy(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    this.alertCallbacks = [];
    logger.info('SystemMonitor destroyed');
  }
}

export const systemMonitor = new SystemMonitor();