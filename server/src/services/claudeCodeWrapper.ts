import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { 
  CommandRequest, 
  CommandResponse, 
  CommandExecutionError,
  JWTPayload 
} from '../types';
import logger from '../config/logger';

interface ProcessSession {
  sessionId: string;
  username: string;
  workingDir: string;
  isActive: boolean;
  createdAt: Date;
  lastActivity: Date;
  commandHistory: string[];
}

export class ClaudeCodeWrapper extends EventEmitter {
  private sessions: Map<string, ProcessSession> = new Map();
  private claudeCodePath: string;
  private baseWorkingDir: string;
  private maxSessions: number;
  private sessionTimeout: number; // minutes

  constructor() {
    super();
    this.claudeCodePath = process.env.CLAUDE_CODE_PATH || 'claude';
    this.baseWorkingDir = process.env.CLAUDE_WORKING_DIR || '/tmp/claude-sessions';
    this.maxSessions = parseInt(process.env.MAX_SESSIONS || '10');
    this.sessionTimeout = parseInt(process.env.SESSION_TIMEOUT || '30');

    // Create base working directory
    this.ensureWorkingDirectory();
    
    // Start cleanup interval
    setInterval(() => this.cleanupInactiveSessions(), 5 * 60 * 1000);
  }

  private ensureWorkingDirectory(): void {
    if (!fs.existsSync(this.baseWorkingDir)) {
      fs.mkdirSync(this.baseWorkingDir, { recursive: true });
      logger.info('Created base working directory', { path: this.baseWorkingDir });
    }
  }

  private createSessionWorkingDir(sessionId: string): string {
    const sessionDir = path.join(this.baseWorkingDir, `session-${sessionId}`);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
      logger.info('Created session working directory', { sessionId, path: sessionDir });
    }
    return sessionDir;
  }

  public async createSession(user: JWTPayload): Promise<string> {
    // Check session limit
    if (this.sessions.size >= this.maxSessions) {
      throw new CommandExecutionError('Maximum number of sessions reached');
    }

    const sessionId = `${user.username}-${Date.now()}`;
    const workingDir = this.createSessionWorkingDir(sessionId);

    const session: ProcessSession = {
      sessionId,
      username: user.username,
      workingDir,
      isActive: false,
      createdAt: new Date(),
      lastActivity: new Date(),
      commandHistory: []
    };

    this.sessions.set(sessionId, session);

    logger.audit('Claude Code session created', {
      sessionId,
      username: user.username,
      workingDir
    });

    return sessionId;
  }

  public async startSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new CommandExecutionError('Session not found');
    }

    if (session.isActive) {
      logger.debug('Session already active', { sessionId });
      return;
    }

    try {
      // Mark session as active - no persistent process needed for non-interactive mode
      session.isActive = true;
      session.lastActivity = new Date();

      logger.audit('Claude Code session started', {
        sessionId,
        username: session.username,
        mode: 'non-interactive'
      });

    } catch (error) {
      session.isActive = false;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to start Claude Code session', error as Error, { sessionId });
      throw new CommandExecutionError(`Failed to start session: ${errorMessage}`);
    }
  }

  public async executeCommand(sessionId: string, command: string, args: string[] = []): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new CommandExecutionError('Session not found');
    }

    session.lastActivity = new Date();
    session.commandHistory.push(command);

    // Limit command history size
    if (session.commandHistory.length > 100) {
      session.commandHistory = session.commandHistory.slice(-100);
    }

    try {
      const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
      
      logger.audit('Executing command', {
        sessionId,
        username: session.username,
        command: fullCommand
      });

      // Execute Claude Code in non-interactive mode using --print flag
      const claudeProcess = spawn(this.claudeCodePath, [
        '--print',
        fullCommand,
        '--output-format', 'text'
      ], {
        cwd: session.workingDir,
        env: {
          ...process.env,
          CLAUDE_SESSION_ID: sessionId,
          CLAUDE_USER: session.username
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      let errorOutput = '';

      claudeProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });

      claudeProcess.stderr?.on('data', (data) => {
        errorOutput += data.toString();
        logger.debug('Claude Code stderr', { sessionId, error: data.toString() });
      });

      claudeProcess.on('close', (code) => {
        if (code !== 0) {
          logger.error('Claude Code command failed', new Error(`Exit code: ${code}`), { 
            sessionId, 
            command: fullCommand,
            stderr: errorOutput 
          });
          this.emit('error', sessionId, errorOutput || `Command failed with exit code ${code}`);
        } else {
          logger.debug('Claude Code command completed', { sessionId, output });
          this.emit('output', sessionId, output);
        }
      });

      claudeProcess.on('error', (error) => {
        logger.error('Claude Code process error', error, { sessionId });
        this.emit('error', sessionId, error.message);
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to execute command', error as Error, { 
        sessionId, 
        command 
      });
      throw new CommandExecutionError(`Command execution failed: ${errorMessage}`);
    }
  }

  public async sendInput(sessionId: string, input: string): Promise<void> {
    // In non-interactive mode, treat input as a command
    await this.executeCommand(sessionId, input);
  }

  public async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return; // Session doesn't exist, nothing to terminate
    }

    try {
      // Clean up working directory
      try {
        fs.rmSync(session.workingDir, { recursive: true, force: true });
        logger.debug('Cleaned up session directory', { sessionId, path: session.workingDir });
      } catch (error) {
        logger.warn('Failed to clean up session directory', { sessionId, error });
      }

      this.sessions.delete(sessionId);

      logger.audit('Claude Code session terminated', {
        sessionId,
        username: session.username
      });

    } catch (error) {
      logger.error('Failed to terminate session', error as Error, { sessionId });
    }
  }

  public getSessionInfo(sessionId: string): ProcessSession | undefined {
    return this.sessions.get(sessionId);
  }

  public getActiveSessions(): string[] {
    return Array.from(this.sessions.keys()).filter(sessionId => 
      this.sessions.get(sessionId)?.isActive
    );
  }

  public getSessionStats(): { total: number; active: number; inactive: number } {
    const total = this.sessions.size;
    const active = Array.from(this.sessions.values()).filter(s => s.isActive).length;
    const inactive = total - active;
    
    return { total, active, inactive };
  }

  private cleanupInactiveSessions(): void {
    const now = new Date();
    const sessionsToCleanup: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const inactiveMinutes = (now.getTime() - session.lastActivity.getTime()) / (1000 * 60);
      
      if (inactiveMinutes > this.sessionTimeout) {
        sessionsToCleanup.push(sessionId);
      }
    }

    for (const sessionId of sessionsToCleanup) {
      logger.info('Cleaning up inactive session', { 
        sessionId, 
        inactiveMinutes: (now.getTime() - this.sessions.get(sessionId)!.lastActivity.getTime()) / (1000 * 60) 
      });
      this.terminateSession(sessionId);
    }

    if (sessionsToCleanup.length > 0) {
      logger.info('Session cleanup completed', { 
        cleanedSessions: sessionsToCleanup.length,
        remainingSessions: this.sessions.size 
      });
    }
  }

  public async healthCheck(): Promise<{ status: string; sessions: any; claudePath: string }> {
    const stats = this.getSessionStats();
    
    return {
      status: 'healthy',
      sessions: stats,
      claudePath: this.claudeCodePath
    };
  }
}

// Singleton instance
export const claudeCodeWrapper = new ClaudeCodeWrapper();