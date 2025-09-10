const SocketIO = require('socket.io');
const { Server } = SocketIO;

// Type definition for Socket.IO Server based on the actual interface
interface SocketServer {
  on(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  use(fn: (socket: any, next: (err?: any) => void) => void): this;
  close(): void;
}
import { Server as HTTPServer } from 'http';
import { 
  ServerToClientEvents, 
  ClientToServerEvents, 
  InterServerEvents, 
  SocketData,
  AuthenticatedSocket 
} from '../types';
import { verifySocketToken, updateSessionActivity } from '../middleware/auth';
import { claudeCodeWrapper } from './claudeCodeWrapper';
import logger from '../config/logger';
import { isValidCommand, isValidArgs, isValidInput, sanitizeForLog } from '../utils/validation';
// import { sessionManager } from './sessionManager'; // Disabled
import { sessionFacade } from '../facades/sessionFacade';
import { simpleStateSync } from './simpleStateSync';

export class SocketService {
  private io: SocketServer;
  private connectedSockets: Map<string, AuthenticatedSocket> = new Map();

  constructor(httpServer: HTTPServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupMiddleware();
    this.setupEventHandlers();
    this.setupClaudeCodeEventHandlers();
    this.setupStateSyncHandlers();
  }

  private setupMiddleware(): void {
    // Authentication middleware
    this.io.use(verifySocketToken);
    
    // Connection logging middleware
    this.io.use((socket: AuthenticatedSocket, next) => {
      logger.audit('Socket connection attempt', {
        socketId: socket.id,
        username: socket.user?.username,
        ip: socket.handshake.address
      });
      next();
    });
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      this.handleConnection(socket);
    });
  }

  private async handleConnection(socket: AuthenticatedSocket): Promise<void> {
    if (!socket.user) {
      socket.disconnect();
      return;
    }

    const { username, sessionId } = socket.user;
    this.connectedSockets.set(socket.id, socket);

    logger.audit('Socket connected', {
      socketId: socket.id,
      username,
      sessionId,
      ip: socket.handshake.address,
      totalConnections: this.connectedSockets.size
    });

    try {
      // Create or get distributed session
      let distributedSession;
      try {
        distributedSession = await sessionFacade.createSession(username, '/tmp');
        logger.info(`Distributed session created: ${distributedSession.sessionId} for user: ${username}`);
      } catch (error) {
        logger.error('Failed to create distributed session', error instanceof Error ? error : new Error(String(error)), {
          socketId: socket.id,
          username
        });
        socket.emit('error', { 
          message: 'Failed to initialize session',
          code: 'SESSION_INIT_ERROR'
        });
        return;
      }

      // Create or get Claude Code session
      let claudeSessionId: string;
      try {
        claudeSessionId = await claudeCodeWrapper.createSession(socket.user);
        await claudeCodeWrapper.startSession(claudeSessionId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Failed to create Claude Code session', error instanceof Error ? error : new Error(String(error)), {
          socketId: socket.id,
          username
        });
        socket.emit('error', { 
          message: 'Failed to initialize Claude Code session',
          code: 'SESSION_INIT_ERROR'
        });
        return;
      }

      // Store session IDs for this socket
      socket.data.claudeSessionId = claudeSessionId;
      socket.data.distributedSessionId = distributedSession.sessionId;

      // Handle command execution
      socket.on('executeCommand', async (data) => {
        await this.handleExecuteCommand(socket, data);
      });

      // Handle direct input (for interactive commands)
      socket.on('sendInput', async (data) => {
        await this.handleSendInput(socket, data);
      });

      // Handle session joining
      socket.on('joinSession', async (data) => {
        await this.handleJoinSession(socket, data);
      });

      // Handle heartbeat
      socket.on('heartbeat', () => {
        this.handleHeartbeat(socket);
      });

      // Handle disconnect
      socket.on('disconnect', (reason) => {
        this.handleDisconnect(socket, reason);
      });

      // Send initial connection success
      socket.emit('connected', {
        message: 'Connected to Claude Code',
        sessionId: claudeSessionId,
        username
      });

    } catch (error) {
      logger.error('Error during socket connection setup', error instanceof Error ? error : new Error(String(error)), {
        socketId: socket.id,
        username
      });
      socket.emit('error', { 
        message: 'Connection setup failed',
        code: 'CONNECTION_ERROR'
      });
      socket.disconnect();
    }
  }

  private async handleExecuteCommand(
    socket: AuthenticatedSocket, 
    data: { command: string; args?: string[] }
  ): Promise<void> {
    if (!socket.user || !socket.data.claudeSessionId) {
      socket.emit('error', { message: 'Session not initialized' });
      return;
    }

    try {
      // Update session activity
      updateSessionActivity(socket.user.sessionId);

      const { command, args = [] } = data;
      
      // Enhanced command validation
      if (!isValidCommand(command)) {
        socket.emit('error', { 
          message: `Invalid or forbidden command: ${sanitizeForLog(command)}`,
          code: 'INVALID_COMMAND'
        });
        logger.warn('Command rejected', {
          socketId: socket.id,
          username: socket.user.username,
          command: sanitizeForLog(command),
          reason: 'invalid_command'
        });
        return;
      }

      // Enhanced arguments validation
      if (!isValidArgs(args)) {
        socket.emit('error', { 
          message: 'Invalid command arguments',
          code: 'INVALID_ARGS'
        });
        logger.warn('Arguments rejected', {
          socketId: socket.id,
          username: socket.user.username,
          command: sanitizeForLog(command),
          argCount: args.length,
          reason: 'invalid_args'
        });
        return;
      }

      logger.audit('Command execution requested', {
        socketId: socket.id,
        username: socket.user.username,
        command: sanitizeForLog(command),
        argCount: args.length,
        claudeSessionId: socket.data.claudeSessionId
      });

      // Update distributed session with command history
      if (socket.data.distributedSessionId) {
        try {
          await sessionFacade.addCommandToHistory(
            socket.data.distributedSessionId, 
            `${command} ${args.join(' ')}`.trim()
          );
        } catch (error) {
          logger.warn('Failed to update command history in distributed session', error instanceof Error ? error : new Error(String(error)));
        }
      }

      await claudeCodeWrapper.executeCommand(
        socket.data.claudeSessionId,
        command.trim(),
        args
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Command execution failed', error instanceof Error ? error : new Error(String(error)), {
        socketId: socket.id,
        username: socket.user?.username,
        command: data.command
      });
      
      socket.emit('error', { 
        message: `Command execution failed: ${errorMessage}`,
        code: 'COMMAND_ERROR'
      });
    }
  }

  private async handleSendInput(
    socket: AuthenticatedSocket,
    data: { input: string }
  ): Promise<void> {
    if (!socket.user || !socket.data.claudeSessionId) {
      socket.emit('error', { message: 'Session not initialized' });
      return;
    }

    try {
      // Update session activity
      updateSessionActivity(socket.user.sessionId);

      const { input } = data;
      
      // Enhanced input validation
      if (!isValidInput(input)) {
        socket.emit('error', { 
          message: 'Invalid input: contains forbidden characters or exceeds length limit',
          code: 'INVALID_INPUT'
        });
        logger.warn('Input rejected', {
          socketId: socket.id,
          username: socket.user.username,
          inputLength: typeof input === 'string' ? input.length : 0,
          reason: 'invalid_input'
        });
        return;
      }

      logger.debug('Input sent to Claude Code', {
        socketId: socket.id,
        username: socket.user.username,
        inputLength: input.length,
        claudeSessionId: socket.data.claudeSessionId
      });

      await claudeCodeWrapper.sendInput(socket.data.claudeSessionId, input);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Send input failed', error instanceof Error ? error : new Error(String(error)), {
        socketId: socket.id,
        username: socket.user?.username
      });
      
      socket.emit('error', { 
        message: `Failed to send input: ${errorMessage}`,
        code: 'INPUT_ERROR'
      });
    }
  }

  private async handleJoinSession(
    socket: AuthenticatedSocket,
    data: { sessionId: string }
  ): Promise<void> {
    // This could be used for session sharing or reconnection
    logger.debug('Session join requested', {
      socketId: socket.id,
      username: socket.user?.username,
      requestedSessionId: data.sessionId
    });
    
    // For now, just acknowledge
    socket.emit('sessionJoined', { sessionId: data.sessionId });
  }

  private handleHeartbeat(socket: AuthenticatedSocket): void {
    if (socket.user) {
      updateSessionActivity(socket.user.sessionId);
      socket.emit('heartbeatAck', { timestamp: new Date() });
    }
  }

  private handleDisconnect(socket: AuthenticatedSocket, reason: string): void {
    this.connectedSockets.delete(socket.id);

    logger.audit('Socket disconnected', {
      socketId: socket.id,
      username: socket.user?.username,
      reason,
      totalConnections: this.connectedSockets.size
    });

    // Clean up Claude Code session
    if (socket.data.claudeSessionId) {
      claudeCodeWrapper.terminateSession(socket.data.claudeSessionId)
        .catch(error => {
          logger.error('Failed to terminate Claude Code session on disconnect', error, {
            socketId: socket.id,
            claudeSessionId: socket.data.claudeSessionId
          });
        });
    }
  }

  private setupClaudeCodeEventHandlers(): void {
    // Handle Claude Code output
    claudeCodeWrapper.on('output', (sessionId: string, output: string) => {
      const socket = this.findSocketByClaudeSession(sessionId);
      if (socket) {
        socket.emit('commandOutput', { output });
      }
    });

    // Handle Claude Code errors
    claudeCodeWrapper.on('error', (sessionId: string, error: string) => {
      const socket = this.findSocketByClaudeSession(sessionId);
      if (socket) {
        socket.emit('commandOutput', { output: '', error });
      }
    });

    // Handle Claude Code process exit
    claudeCodeWrapper.on('processExit', (sessionId: string, exitCode: number) => {
      const socket = this.findSocketByClaudeSession(sessionId);
      if (socket) {
        socket.emit('commandComplete', { 
          exitCode, 
          timestamp: new Date() 
        });
      }
    });

    // Handle Claude Code process errors
    claudeCodeWrapper.on('processError', (sessionId: string, error: Error) => {
      const socket = this.findSocketByClaudeSession(sessionId);
      if (socket) {
        socket.emit('error', { 
          message: `Process error: ${error.message}`,
          code: 'PROCESS_ERROR'
        });
      }
    });
  }

  private findSocketByClaudeSession(claudeSessionId: string): AuthenticatedSocket | null {
    for (const socket of this.connectedSockets.values()) {
      if (socket.data.claudeSessionId === claudeSessionId) {
        return socket;
      }
    }
    return null;
  }

  public getConnectionStats(): { totalConnections: number; sessionStats: any } {
    return {
      totalConnections: this.connectedSockets.size,
      sessionStats: claudeCodeWrapper.getSessionStats()
    };
  }

  public broadcastToAll(event: keyof ServerToClientEvents, data: any): void {
    this.io.emit(event, data);
  }

  public broadcastToUser(username: string, event: keyof ServerToClientEvents, data: any): void {
    for (const socket of this.connectedSockets.values()) {
      if (socket.user?.username === username) {
        socket.emit(event, data);
      }
    }
  }

  // Setup handlers for distributed state sync events
  private setupStateSyncHandlers(): void {
    // Check if simpleStateSync is available
    if (!simpleStateSync || typeof simpleStateSync.on !== 'function') {
      logger.warn('SimpleStateSync not available, skipping state sync handlers');
      return;
    }
    
    // Handle session changes from other regions
    simpleStateSync.on('sessionChanged', (data) => {
      this.broadcastSessionChange(data);
    });

    // Handle remote session changes
    simpleStateSync.on('remoteSessionChange', (data) => {
      this.broadcastToUser(data.userId || '', 'sessionSynced', {
        sessionId: data.sessionId,
        sourceRegion: data.sourceRegion,
        timestamp: data.timestamp
      });
    });

    // Handle session conflicts - commented out for sessionManager stub
    // sessionManager.on('sessionConflict', (conflict) => {
    //   this.handleSessionConflict(conflict);
    // });

    // Handle session reverts (when optimistic updates fail) - commented out for sessionManager stub
    // sessionManager.on('sessionReverted', (sessionData) => {
    //   this.broadcastToSessionUsers(sessionData.sessionId, 'sessionReverted', {
    //     sessionData,
    //     timestamp: Date.now()
    //   });
    // });

    // Handle confirmed session updates - commented out for sessionManager stub
    // sessionManager.on('sessionUpdated', (sessionData, meta) => {
    //   if (meta?.confirmed) {
    //     this.broadcastToSessionUsers(sessionData.sessionId, 'sessionConfirmed', {
    //       sessionData,
    //       timestamp: Date.now()
    //     });
    //   }
    // });

    // Start the sync process
    simpleStateSync.startSync();
  }

  private broadcastSessionChange(data: any): void {
    // Broadcast to all users in the same session
    this.broadcastToSessionUsers(data.sessionId, 'sessionChanged', {
      sessionId: data.sessionId,
      changes: data.changes,
      timestamp: Date.now()
    });
  }

  private handleSessionConflict(conflict: any): void {
    // Notify user about the conflict
    this.broadcastToSessionUsers(conflict.sessionId, 'sessionConflict', {
      sessionId: conflict.sessionId,
      conflictType: conflict.conflictType,
      expectedVersion: conflict.expectedVersion,
      currentVersion: conflict.currentVersion,
      timestamp: Date.now(),
      action: 'resolve_required'
    });

    logger.warn('Session conflict detected', conflict);
  }

  private broadcastToSessionUsers(sessionId: string, event: string, data: any): void {
    for (const socket of this.connectedSockets.values()) {
      if (socket.data.distributedSessionId === sessionId) {
        socket.emit(event as keyof ServerToClientEvents, data);
      }
    }
  }

  // Add sync status endpoint
  public getSyncStatus(): any {
    return {
      socket: {
        connections: this.connectedSockets.size,
        distributedSessions: Array.from(this.connectedSockets.values())
          .map(s => s.data.distributedSessionId)
          .filter(id => id)
      },
      stateSync: simpleStateSync.getSyncStatus(),
      sessionManager: sessionFacade.getSessionStats()
    };
  }

  public getServer(): SocketServer {
    return this.io;
  }
}

