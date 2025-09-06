import { spawn, ChildProcess } from 'child_process';
import { logger } from '../config/logger';

interface MCPServer {
  name: string;
  command: string;
  args: string[];
  process?: ChildProcess;
  lastUsed: number;
  startTime?: number;
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
        logger.error(`MCP server ${name} error:`, error);
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
      logger.error(`Failed to start MCP server ${name}:`, error);
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
          logger.error(`MCP server ${name} response parse error:`, error);
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