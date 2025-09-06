import { Request } from 'express';
import { Socket } from 'socket.io';

// User types
export interface User {
  username: string;
  passwordHash: string;
  role: 'admin' | 'user';
  lastLogin: Date | null;
}

export interface UserSession {
  username: string;
  role: 'admin' | 'user';
  loginTime: Date;
  lastActivity: Date;
  ip: string;
}

export interface JWTPayload {
  username: string;
  role: 'admin' | 'user';
  sessionId: string;
  iat?: number;
  exp?: number;
}

// Request extensions
export interface AuthenticatedRequest extends Request {
  user?: JWTPayload;
}

export interface AuthenticatedSocket extends Socket {
  user?: JWTPayload;
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  message: string;
  token: string;
  user: {
    username: string;
    role: string;
  };
}

// Command types
export interface CommandRequest {
  command: string;
  args?: string[];
  workingDir?: string;
}

export interface CommandResponse {
  output: string;
  error?: string;
  exitCode: number;
  timestamp: Date;
}

// Session management
export interface SessionInfo {
  sessionId: string;
  loginTime: Date;
  lastActivity: Date;
}

// Configuration types
export interface ServerConfig {
  port: number;
  jwtSecret: string;
  sessionTimeout: number;
  claudeCodePath: string;
  claudeWorkingDir: string;
  allowedIPs?: string[];
  sslCertPath?: string;
  sslKeyPath?: string;
  logLevel: string;
  logFile?: string;
  maxSessions: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
}

// WebSocket event types
export interface ServerToClientEvents {
  commandOutput: (data: { output: string; error?: string }) => void;
  commandComplete: (data: { exitCode: number; timestamp: Date }) => void;
  sessionExpired: () => void;
  error: (data: { message: string; code?: string }) => void;
}

export interface ClientToServerEvents {
  executeCommand: (data: CommandRequest) => void;
  joinSession: (data: { sessionId: string }) => void;
  heartbeat: () => void;
}

export interface InterServerEvents {
  // For scaling across multiple server instances
}

export interface SocketData {
  user: JWTPayload;
  sessionId: string;
}

// Error types
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends Error {
  constructor(message: string, public details?: any[]) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class CommandExecutionError extends Error {
  constructor(message: string, public exitCode?: number) {
    super(message);
    this.name = 'CommandExecutionError';
  }
}

// Utility types
export type Environment = 'development' | 'production' | 'test';

export interface LogContext {
  username?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  path?: string;
  method?: string;
  timestamp?: string;
  type?: 'audit' | 'error' | 'info' | 'warn';
  [key: string]: any;
}