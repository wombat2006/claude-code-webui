import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { LogContext, Environment } from '../types';

// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const environment = (process.env.NODE_ENV as Environment) || 'development';
const logLevel = process.env.LOG_LEVEL || 'info';

// Custom log format with proper typing
const customFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    return JSON.stringify({
      timestamp,
      level,
      message,
      service: 'claude-webui',
      environment,
      ...meta
    });
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: logLevel,
  format: customFormat,
  defaultMeta: { 
    service: 'claude-webui',
    environment 
  },
  transports: [
    // Error log file
    new winston.transports.File({ 
      filename: path.join(logDir, 'error.log'), 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      handleExceptions: true,
      handleRejections: true
    }),
    
    // Combined log file
    new winston.transports.File({ 
      filename: path.join(logDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    
    // Audit log file
    new winston.transports.File({
      filename: path.join(logDir, 'audit.log'),
      level: 'info',
      maxsize: 10485760, // 10MB
      maxFiles: 10,
    })
  ],
  exitOnError: false
});

// Add console logging in development
if (environment !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} [${level}]: ${message} ${metaStr}`;
      })
    ),
    handleExceptions: true,
    handleRejections: true
  }));
}

// Type-safe security audit logging
interface AuditLogger {
  audit: (message: string, context?: LogContext) => void;
  error: (message: string, error?: Error, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  debug: (message: string, context?: LogContext) => void;
}

const createAuditLogger = (): AuditLogger => {
  return {
    audit: (message: string, context: LogContext = {}): void => {
      logger.info(message, { 
        type: 'audit', 
        timestamp: new Date().toISOString(),
        ...context 
      });
    },

    error: (message: string, error?: Error, context: LogContext = {}): void => {
      logger.error(message, {
        type: 'error',
        timestamp: new Date().toISOString(),
        error: error ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        } : undefined,
        ...context
      });
    },

    warn: (message: string, context: LogContext = {}): void => {
      logger.warn(message, {
        type: 'warn',
        timestamp: new Date().toISOString(),
        ...context
      });
    },

    info: (message: string, context: LogContext = {}): void => {
      logger.info(message, {
        type: 'info',
        timestamp: new Date().toISOString(),
        ...context
      });
    },

    debug: (message: string, context: LogContext = {}): void => {
      logger.debug(message, {
        type: 'debug',
        timestamp: new Date().toISOString(),
        ...context
      });
    }
  };
};

// Export typed logger
export default createAuditLogger();