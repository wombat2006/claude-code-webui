import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../config/logger';

const execAsync = promisify(exec);

interface VmstatData {
  // Procs
  runnable: number;      // r - processes waiting for run time
  blocked: number;       // b - processes in uninterruptible sleep
  
  // Memory (KB)
  swapUsed: number;      // swpd - virtual memory used
  free: number;          // free - idle memory
  buffer: number;        // buff - memory used as buffers
  cache: number;         // cache - memory used as cache
  
  // Swap (KB/s)
  swapIn: number;        // si - memory swapped in from disk
  swapOut: number;       // so - memory swapped to disk
  
  // IO (blocks/s)
  blocksIn: number;      // bi - blocks received from block device
  blocksOut: number;     // bo - blocks sent to block device
  
  // System
  interrupts: number;    // in - interrupts per second
  contextSwitches: number; // cs - context switches per second
  
  // CPU (percentage)
  userTime: number;      // us - time spent running non-kernel code
  systemTime: number;    // sy - time spent running kernel code
  idleTime: number;      // id - time spent idle
  waitTime: number;      // wa - time spent waiting for IO
  stolenTime: number;    // st - time stolen from VM (if running on VM)
  
  // Derived metrics
  loadScore: number;     // Custom load score (0-100)
  memoryPressure: number; // Memory pressure indicator
  ioPressure: number;    // IO pressure indicator
  
  timestamp: number;
}

interface SarData {
  loadAvg1: number;      // 1-minute load average
  loadAvg5: number;      // 5-minute load average  
  loadAvg15: number;     // 15-minute load average
  cpuCores: number;      // Number of CPU cores
  
  // CPU utilization
  cpuUser: number;       // %user
  cpuNice: number;       // %nice
  cpuSystem: number;     // %system
  cpuIowait: number;     // %iowait
  cpuSteal: number;      // %steal
  cpuIdle: number;       // %idle
  
  // Memory (MB)
  memTotal: number;      // Total memory
  memUsed: number;       // Used memory
  memFree: number;       // Free memory
  memBuffer: number;     // Buffer memory
  memCached: number;     // Cached memory
  memUtilization: number; // Memory utilization %
  
  timestamp: number;
}

export class VmstatSarMonitor {
  private vmstatProcess?: any;
  private sarData: SarData | null = null;
  private vmstatData: VmstatData | null = null;
  private monitoringActive: boolean = false;
  private alertCallbacks: Array<(metric: string, level: string, value: number) => void> = [];

  constructor() {
    this.startMonitoring();
  }

  public async startMonitoring(): Promise<void> {
    if (this.monitoringActive) return;

    this.monitoringActive = true;
    logger.info('Starting vmstat/sar monitoring');

    try {
      // Start continuous vmstat (every 5 seconds)
      this.startVmstatMonitoring();
      
      // Get initial sar data and update every 30 seconds
      await this.updateSarData();
      setInterval(() => this.updateSarData(), 30000);
      
      logger.info('VmstatSarMonitor started successfully');
    } catch (error) {
      logger.error('Failed to start monitoring:', error);
      this.monitoringActive = false;
    }
  }

  private startVmstatMonitoring(): void {
    // Run vmstat every 5 seconds continuously
    this.vmstatProcess = exec('vmstat 5', (error, stdout, stderr) => {
      if (error && this.monitoringActive) {
        logger.error('vmstat process error:', error);
        // Restart after 10 seconds
        setTimeout(() => this.startVmstatMonitoring(), 10000);
      }
    });

    let buffer = '';
    this.vmstatProcess.stdout?.on('data', (data: string) => {
      buffer += data;
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        this.parseVmstatLine(line);
      }
    });

    this.vmstatProcess.on('exit', (code: number) => {
      if (this.monitoringActive && code !== 0) {
        logger.warn(`vmstat exited with code ${code}, restarting in 10 seconds`);
        setTimeout(() => this.startVmstatMonitoring(), 10000);
      }
    });
  }

  private parseVmstatLine(line: string): void {
    // Skip header lines
    if (line.includes('procs') || line.includes('memory') || line.includes('r  b')) {
      return;
    }

    const parts = line.trim().split(/\s+/).filter(p => p.length > 0);
    if (parts.length < 16) return; // vmstat should have at least 16 columns

    try {
      const data: VmstatData = {
        runnable: parseInt(parts[0]) || 0,
        blocked: parseInt(parts[1]) || 0,
        swapUsed: parseInt(parts[2]) || 0,
        free: parseInt(parts[3]) || 0,
        buffer: parseInt(parts[4]) || 0,
        cache: parseInt(parts[5]) || 0,
        swapIn: parseInt(parts[6]) || 0,
        swapOut: parseInt(parts[7]) || 0,
        blocksIn: parseInt(parts[8]) || 0,
        blocksOut: parseInt(parts[9]) || 0,
        interrupts: parseInt(parts[10]) || 0,
        contextSwitches: parseInt(parts[11]) || 0,
        userTime: parseInt(parts[12]) || 0,
        systemTime: parseInt(parts[13]) || 0,
        idleTime: parseInt(parts[14]) || 0,
        waitTime: parseInt(parts[15]) || 0,
        stolenTime: parts[16] ? parseInt(parts[16]) : 0,
        loadScore: 0, // Will be calculated
        memoryPressure: 0, // Will be calculated
        ioPressure: 0, // Will be calculated
        timestamp: Date.now()
      };

      // Calculate derived metrics
      data.loadScore = this.calculateLoadScore(data);
      data.memoryPressure = this.calculateMemoryPressure(data);
      data.ioPressure = this.calculateIOPressure(data);

      this.vmstatData = data;
      this.checkVmstatThresholds(data);

    } catch (error) {
      logger.debug('Failed to parse vmstat line:', line, error);
    }
  }

  private async updateSarData(): Promise<void> {
    try {
      // Get load average and CPU data
      const [loadData, cpuData, memData] = await Promise.all([
        this.getSarLoadAverage(),
        this.getSarCPUData(),
        this.getSarMemoryData()
      ]);

      this.sarData = {
        ...loadData,
        ...cpuData,
        ...memData,
        timestamp: Date.now()
      };

      this.checkSarThresholds(this.sarData);

    } catch (error) {
      logger.error('Failed to update sar data:', error);
    }
  }

  private async getSarLoadAverage(): Promise<any> {
    try {
      // Use sar to get load average (last 1 data point)
      const { stdout } = await execAsync('sar -q 1 1 | tail -1');
      const parts = stdout.trim().split(/\s+/);
      
      if (parts.length >= 6) {
        return {
          loadAvg1: parseFloat(parts[3]) || 0,
          loadAvg5: parseFloat(parts[4]) || 0,
          loadAvg15: parseFloat(parts[5]) || 0,
          cpuCores: require('os').cpus().length
        };
      }
    } catch (error) {
      // Fallback to /proc/loadavg
      const fs = require('fs');
      const loadavg = fs.readFileSync('/proc/loadavg', 'utf8');
      const [one, five, fifteen] = loadavg.trim().split(' ').map(parseFloat);
      return {
        loadAvg1: one || 0,
        loadAvg5: five || 0,
        loadAvg15: fifteen || 0,
        cpuCores: require('os').cpus().length
      };
    }
  }

  private async getSarCPUData(): Promise<any> {
    try {
      // Get CPU utilization data
      const { stdout } = await execAsync('sar -u 1 1 | grep -v "^$" | tail -1');
      const parts = stdout.trim().split(/\s+/);
      
      if (parts.length >= 7) {
        return {
          cpuUser: parseFloat(parts[2]) || 0,
          cpuNice: parseFloat(parts[3]) || 0,
          cpuSystem: parseFloat(parts[4]) || 0,
          cpuIowait: parseFloat(parts[5]) || 0,
          cpuSteal: parseFloat(parts[6]) || 0,
          cpuIdle: parseFloat(parts[7]) || 0
        };
      }
    } catch (error) {
      // Fallback values
      return {
        cpuUser: 0,
        cpuNice: 0,
        cpuSystem: 0,
        cpuIowait: 0,
        cpuSteal: 0,
        cpuIdle: 100
      };
    }
  }

  private async getSarMemoryData(): Promise<any> {
    try {
      // Get memory utilization data
      const { stdout } = await execAsync('sar -r 1 1 | grep -v "^$" | tail -1');
      const parts = stdout.trim().split(/\s+/);
      
      if (parts.length >= 8) {
        const total = parseInt(parts[2]) || 0;
        const used = parseInt(parts[3]) || 0;
        const free = parseInt(parts[4]) || 0;
        const buffer = parseInt(parts[5]) || 0;
        const cached = parseInt(parts[6]) || 0;
        const util = parseFloat(parts[7]) || 0;

        return {
          memTotal: Math.round(total / 1024), // Convert KB to MB
          memUsed: Math.round(used / 1024),
          memFree: Math.round(free / 1024),
          memBuffer: Math.round(buffer / 1024),
          memCached: Math.round(cached / 1024),
          memUtilization: util
        };
      }
    } catch (error) {
      // Fallback to /proc/meminfo
      const fs = require('fs');
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const getVal = (key: string) => {
        const match = meminfo.match(new RegExp(`${key}:\\s*(\\d+)`));
        return match ? parseInt(match[1]) : 0;
      };

      const total = getVal('MemTotal');
      const free = getVal('MemFree');
      const buffer = getVal('Buffers');
      const cached = getVal('Cached');
      const used = total - free - buffer - cached;

      return {
        memTotal: Math.round(total / 1024),
        memUsed: Math.round(used / 1024),
        memFree: Math.round(free / 1024),
        memBuffer: Math.round(buffer / 1024),
        memCached: Math.round(cached / 1024),
        memUtilization: total > 0 ? (used / total) * 100 : 0
      };
    }
  }

  private calculateLoadScore(data: VmstatData): number {
    // Load score based on runnable processes, CPU usage, and wait time
    const cpuBusy = 100 - data.idleTime;
    const runnableScore = Math.min(data.runnable * 20, 40); // Max 40 points
    const cpuScore = Math.min(cpuBusy * 0.4, 40); // Max 40 points  
    const waitScore = Math.min(data.waitTime * 0.2, 20); // Max 20 points

    return Math.min(100, runnableScore + cpuScore + waitScore);
  }

  private calculateMemoryPressure(data: VmstatData): number {
    // Memory pressure based on swap usage and free memory
    const swapPressure = Math.min((data.swapIn + data.swapOut) * 2, 50);
    const freePressure = data.free < 100000 ? 50 : 0; // If free < 100MB
    
    return Math.min(100, swapPressure + freePressure);
  }

  private calculateIOPressure(data: VmstatData): number {
    // IO pressure based on block IO and wait time
    const ioPressure = Math.min((data.blocksIn + data.blocksOut) / 100, 50);
    const waitPressure = Math.min(data.waitTime, 50);
    
    return Math.min(100, ioPressure + waitPressure);
  }

  private checkVmstatThresholds(data: VmstatData): void {
    // Check for high load conditions
    if (data.loadScore >= 80) {
      this.triggerAlert('load_score', 'critical', data.loadScore);
    } else if (data.loadScore >= 60) {
      this.triggerAlert('load_score', 'warning', data.loadScore);
    }

    // Check runnable processes queue
    if (data.runnable >= 5) {
      this.triggerAlert('runnable_processes', 'warning', data.runnable);
    }

    // Check IO wait
    if (data.waitTime >= 20) {
      this.triggerAlert('io_wait', 'warning', data.waitTime);
    }

    // Check memory pressure
    if (data.memoryPressure >= 70) {
      this.triggerAlert('memory_pressure', 'critical', data.memoryPressure);
    }
  }

  private checkSarThresholds(data: SarData): void {
    const cores = data.cpuCores;
    
    // Load average thresholds
    if (data.loadAvg1 >= cores * 1.5) {
      this.triggerAlert('load_average_1m', 'critical', data.loadAvg1);
    } else if (data.loadAvg1 >= cores * 1.0) {
      this.triggerAlert('load_average_1m', 'warning', data.loadAvg1);
    }

    // Memory utilization
    if (data.memUtilization >= 90) {
      this.triggerAlert('memory_utilization', 'critical', data.memUtilization);
    } else if (data.memUtilization >= 80) {
      this.triggerAlert('memory_utilization', 'warning', data.memUtilization);
    }

    // IO wait
    if (data.cpuIowait >= 20) {
      this.triggerAlert('cpu_iowait', 'warning', data.cpuIowait);
    }
  }

  private triggerAlert(metric: string, level: string, value: number): void {
    logger.warn(`${level.toUpperCase()}: ${metric} = ${value.toFixed(2)}`, {
      metric, level, value, timestamp: new Date().toISOString()
    });

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

  public getCurrentLoad(): number {
    return this.sarData?.loadAvg1 || 0;
  }

  public getVmstatData(): VmstatData | null {
    return this.vmstatData;
  }

  public getSarData(): SarData | null {
    return this.sarData;
  }

  public isSystemUnderPressure(): boolean {
    if (!this.vmstatData || !this.sarData) return false;
    
    return (
      this.sarData.loadAvg1 >= this.sarData.cpuCores * 0.8 ||
      this.vmstatData.loadScore >= 60 ||
      this.sarData.memUtilization >= 80 ||
      this.vmstatData.waitTime >= 15
    );
  }

  public getHealthSummary(): any {
    const vmstat = this.vmstatData;
    const sar = this.sarData;
    
    if (!vmstat || !sar) {
      return { status: 'unknown', message: 'Monitoring data not available' };
    }

    let status = 'healthy';
    const issues: string[] = [];
    const metrics: any = {};

    // Load average assessment
    const loadRatio = sar.loadAvg1 / sar.cpuCores;
    metrics.loadAverage = {
      current: sar.loadAvg1,
      ratio: loadRatio,
      cores: sar.cpuCores
    };

    if (loadRatio >= 1.5) {
      status = 'critical';
      issues.push(`Load average critically high: ${sar.loadAvg1.toFixed(2)} (${(loadRatio * 100).toFixed(0)}% of CPU capacity)`);
    } else if (loadRatio >= 1.0) {
      status = 'warning';
      issues.push(`Load average high: ${sar.loadAvg1.toFixed(2)} (${(loadRatio * 100).toFixed(0)}% of CPU capacity)`);
    }

    // Memory assessment
    metrics.memory = {
      utilization: sar.memUtilization,
      total: sar.memTotal,
      free: sar.memFree
    };

    if (sar.memUtilization >= 90) {
      status = 'critical';
      issues.push(`Memory critically low: ${sar.memUtilization.toFixed(1)}% used`);
    } else if (sar.memUtilization >= 80) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push(`Memory usage high: ${sar.memUtilization.toFixed(1)}% used`);
    }

    // CPU and IO assessment
    metrics.cpu = {
      idle: sar.cpuIdle,
      iowait: sar.cpuIowait,
      user: sar.cpuUser,
      system: sar.cpuSystem
    };

    if (sar.cpuIowait >= 20) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push(`High IO wait: ${sar.cpuIowait.toFixed(1)}%`);
    }

    if (vmstat.runnable >= 5) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push(`High process queue: ${vmstat.runnable} processes waiting`);
    }

    return {
      status,
      loadScore: vmstat.loadScore,
      issues,
      metrics,
      recommendation: this.getRecommendation(status, loadRatio, sar.memUtilization),
      timestamp: sar.timestamp
    };
  }

  private getRecommendation(status: string, loadRatio: number, memUtil: number): string {
    if (status === 'critical') {
      if (loadRatio >= 1.5) return 'IMMEDIATE: Scale out to worker nodes, stop accepting new tasks';
      if (memUtil >= 90) return 'IMMEDIATE: Enable swap or add memory, offload all tasks';
    }
    
    if (status === 'warning') {
      if (loadRatio >= 1.0) return 'Scale out recommended, increase worker capacity';
      if (memUtil >= 80) return 'Monitor memory usage, consider offloading heavy tasks';
    }

    return 'System operating normally';
  }

  public destroy(): void {
    this.monitoringActive = false;
    
    if (this.vmstatProcess) {
      this.vmstatProcess.kill('SIGTERM');
    }
    
    this.alertCallbacks = [];
    logger.info('VmstatSarMonitor destroyed');
  }
}

export const vmstatSarMonitor = new VmstatSarMonitor();