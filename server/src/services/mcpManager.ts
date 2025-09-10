import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../config/logger';

interface MCPServer {
  name: string;
  command: string;
  args: string[];
  process?: ChildProcess;
  lastUsed: number;
  startTime?: number;
}

const LOCK_FILE = process.env.MCP_LOCK_FILE || '/tmp/zen-mcp-manager.lock';
let locked = false;
let children: Array<{name: string, pid: number, proc: ChildProcess}> = [];

export async function ensureSingleInstance(): Promise<boolean> {
  if (locked) return true;
  
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx'); // fail if exists
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    locked = true;
    
    // Clean up lock file on exit
    process.on('exit', () => {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {}
    });
    
    logger.info('MCP Manager: Single instance lock acquired');
    return true;
  } catch (error) {
    logger.warn(`MCP Manager: Already running (lock: ${LOCK_FILE}). Skipping autostart.`);
    return false;
  }
}

function registerChild(name: string, proc: ChildProcess): void {
  if (!proc.pid) return;
  
  children.push({ name, pid: proc.pid, proc });
  logger.info(`MCP Manager: Registered child ${name} (PID: ${proc.pid})`);
  
  proc.on('exit', (code, signal) => {
    children = children.filter(c => c.pid !== proc.pid);
    logger.info(`MCP Manager: ${name} exited`, { code, signal, pid: proc.pid });
  });
}

export async function stopAllMcp(): Promise<void> {
  logger.info(`MCP Manager: Stopping ${children.length} child processes`);
  
  // Send SIGTERM to all children
  for (const c of [...children]) {
    try {
      process.kill(c.pid, 'SIGTERM');
      logger.info(`MCP Manager: Sent SIGTERM to ${c.name} (PID: ${c.pid})`);
    } catch (error) {
      logger.warn(`MCP Manager: Failed to send SIGTERM to ${c.name} (PID: ${c.pid})`, error);
    }
  }
  
  // Wait up to 3 seconds for graceful shutdown
  const deadline = Date.now() + 3000;
  while (children.length && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  
  // Force kill any remaining processes
  for (const c of [...children]) {
    try {
      process.kill(c.pid, 'SIGKILL');
      logger.warn(`MCP Manager: Force killed ${c.name} (PID: ${c.pid})`);
    } catch (error) {
      logger.warn(`MCP Manager: Failed to force kill ${c.name} (PID: ${c.pid})`, error);
    }
  }
  
  children = [];
  logger.info('MCP Manager: All child processes stopped');
}

export async function initMcpAutostart(): Promise<void> {
  if (!locked) {
    logger.warn('MCP Manager: Single instance lock not acquired, skipping autostart');
    return;
  }
  
  logger.info('MCP Manager: Starting MCP autostart initialization');
  
  const env = { ...process.env };
  
  try {
    // Check if zen-mcp-server command exists
    const zenProc = spawn('which', ['zen-mcp-server'], { stdio: 'pipe' });
    const zenExists = await new Promise((resolve) => {
      zenProc.on('exit', (code) => resolve(code === 0));
    });
    
    if (zenExists) {
      const zen = spawn('zen-mcp-server', [], { stdio: 'inherit', env });
      registerChild('zen-mcp-server', zen);
    } else {
      logger.warn('MCP Manager: zen-mcp-server command not found, skipping');
    }
  } catch (error) {
    logger.error('MCP Manager: Failed to start zen-mcp-server', error instanceof Error ? error : new Error(String(error)));
  }
  
  try {
    // Check if o3-search-mcp command exists
    const o3Proc = spawn('which', ['o3-search-mcp'], { stdio: 'pipe' });
    const o3Exists = await new Promise((resolve) => {
      o3Proc.on('exit', (code) => resolve(code === 0));
    });
    
    if (o3Exists) {
      const o3 = spawn('o3-search-mcp', [], { stdio: 'inherit', env });
      registerChild('o3-search-mcp', o3);
    } else {
      logger.warn('MCP Manager: o3-search-mcp command not found, skipping');
    }
  } catch (error) {
    logger.error('MCP Manager: Failed to start o3-search-mcp', error instanceof Error ? error : new Error(String(error)));
  }
  
  logger.info(`MCP Manager: Autostart completed, ${children.length} processes running`);
}

export class MCPManager {
  private servers: Map<string, MCPServer> = new Map();
  private idleTimeout: number = 300000; // 5 minutes
  private cleanupTimer?: NodeJS.Timeout;

  constructor() {
    // Cleanup idle processes every minute
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleServers();
    }, 60000);
  }

  async startServer(name: string, command: string, args: string[]): Promise<boolean> {
    try {
      const existing = this.servers.get(name);
      if (existing?.process && !existing.process.killed) {
        existing.lastUsed = Date.now();
        return true;
      }

      const process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const server: MCPServer = {
        name,
        command,
        args,
        process,
        lastUsed: Date.now(),
        startTime: Date.now()
      };

      process.on('error', (error) => {
        logger.error(`MCP server ${name} error:`, error instanceof Error ? error : new Error(String(error)));
        this.servers.delete(name);
      });

      process.on('exit', (code) => {
        logger.info(`MCP server ${name} exited with code ${code}`);
        this.servers.delete(name);
      });

      this.servers.set(name, server);
      logger.info(`MCP server ${name} started (PID: ${process.pid})`);
      
      return true;
    } catch (error) {
      logger.error(`Failed to start MCP server ${name}:`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  async callServer(name: string, method: string, params: any): Promise<any> {
    const server = this.servers.get(name);
    if (!server?.process) {
      throw new Error(`MCP server ${name} not running`);
    }

    server.lastUsed = Date.now();

    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: `tools/call`,
        params: {
          name: method,
          arguments: params
        }
      };

      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        reject(new Error(`MCP server ${name} call timeout`));
      }, 30000); // 30 second timeout

      const onData = (data: Buffer) => {
        stdout += data.toString();
      };

      const onError = (data: Buffer) => {
        stderr += data.toString();
      };

      const onClose = () => {
        clearTimeout(timeout);
        server.process!.stdout!.removeListener('data', onData);
        server.process!.stderr!.removeListener('data', onError);

        try {
          const response = JSON.parse(stdout);
          resolve(response.result || response);
        } catch (error) {
          logger.error(`MCP server ${name} response parse error:`, error instanceof Error ? error : new Error(String(error)));
          reject(new Error(`Invalid response from ${name}: ${stderr || stdout}`));
        }
      };

      server.process.stdout!.on('data', onData);
      server.process.stderr!.on('data', onError);
      server.process.on('close', onClose);

      // Send request
      server.process.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  private cleanupIdleServers(): void {
    const now = Date.now();
    const serversToCleanup: string[] = [];

    for (const [name, server] of this.servers.entries()) {
      if (now - server.lastUsed > this.idleTimeout) {
        serversToCleanup.push(name);
      }
    }

    for (const name of serversToCleanup) {
      this.stopServer(name);
    }

    if (serversToCleanup.length > 0) {
      logger.info(`Cleaned up ${serversToCleanup.length} idle MCP servers`);
    }
  }

  stopServer(name: string): void {
    const server = this.servers.get(name);
    if (server?.process && !server.process.killed) {
      server.process.kill('SIGTERM');
      
      // Force kill after 5 seconds
      setTimeout(() => {
        if (!server.process!.killed) {
          server.process!.kill('SIGKILL');
        }
      }, 5000);

      logger.info(`MCP server ${name} stopped`);
    }
    this.servers.delete(name);
  }

  getServerStats(): any {
    const stats: any[] = [];
    
    for (const [name, server] of this.servers.entries()) {
      const uptime = server.startTime ? Date.now() - server.startTime : 0;
      const idleTime = Date.now() - server.lastUsed;
      
      stats.push({
        name,
        pid: server.process?.pid,
        uptime: `${Math.round(uptime / 1000)}s`,
        idleTime: `${Math.round(idleTime / 1000)}s`,
        status: server.process?.killed ? 'dead' : 'alive'
      });
    }

    return {
      activeServers: this.servers.size,
      idleTimeout: `${this.idleTimeout / 1000}s`,
      servers: stats
    };
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Stop all servers
    for (const name of this.servers.keys()) {
      this.stopServer(name);
    }
  }
}

export const mcpManager = new MCPManager();