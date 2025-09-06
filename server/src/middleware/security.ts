import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { body, param, query, validationResult } from 'express-validator';
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest, ValidationError } from '../types';
import logger from '../config/logger';

// IP whitelist from environment variable
const getAllowedIPs = (): string[] | null => {
  const allowedIPs = process.env.ALLOWED_IPS;
  if (!allowedIPs) return null;
  
  return allowedIPs.split(',').map(ip => ip.trim());
};

// CIDR matching utility (basic implementation)
const isIPInCIDR = (ip: string, cidr: string): boolean => {
  if (!cidr.includes('/')) {
    return ip === cidr;
  }

  const [network, prefixLength] = cidr.split('/');
  const prefixNum = parseInt(prefixLength, 10);
  
  // Simple implementation - for production use a proper CIDR library
  const networkParts = network.split('.');
  const ipParts = ip.split('.');
  
  if (networkParts.length !== 4 || ipParts.length !== 4) {
    return false;
  }
  
  const octetsToCheck = Math.floor(prefixNum / 8);
  const remainingBits = prefixNum % 8;
  
  // Check full octets
  for (let i = 0; i < octetsToCheck; i++) {
    if (networkParts[i] !== ipParts[i]) {
      return false;
    }
  }
  
  // Check remaining bits if any
  if (remainingBits > 0 && octetsToCheck < 4) {
    const networkOctet = parseInt(networkParts[octetsToCheck], 10);
    const ipOctet = parseInt(ipParts[octetsToCheck], 10);
    const mask = (0xFF << (8 - remainingBits)) & 0xFF;
    
    if ((networkOctet & mask) !== (ipOctet & mask)) {
      return false;
    }
  }
  
  return true;
};

// IP whitelist middleware
export const ipWhitelist = (req: Request, res: Response, next: NextFunction): void => {
  const allowedIPs = getAllowedIPs();
  
  // Skip IP check in development or if no IPs configured
  if (process.env.NODE_ENV === 'development' || !allowedIPs) {
    return next();
  }

  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const isAllowed = allowedIPs.some(allowedIP => isIPInCIDR(clientIP, allowedIP));

  if (!isAllowed) {
    logger.audit('Access denied: IP not whitelisted', {
      clientIP,
      allowedIPs,
      userAgent: req.get('User-Agent'),
      path: req.path,
      method: req.method
    });
    res.status(403).json({ 
      error: 'Access denied: IP not authorized' 
    });
    return;
  }

  next();
};

// General rate limiting
export const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'), // limit each IP
  message: {
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // Use authenticated user session if available, otherwise IP
    const authReq = req as AuthenticatedRequest;
    return authReq.user?.sessionId || req.ip || 'unknown';
  },
  handler: (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    logger.audit('Rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      method: req.method,
      username: authReq.user?.username
    });
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later.'
    });
  }
});

// Command execution rate limiting (stricter)
export const commandLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // limit command executions
  message: {
    error: 'Too many command executions, please slow down.',
  },
  keyGenerator: (req: Request) => {
    // Use user session ID for authenticated requests
    const authReq = req as AuthenticatedRequest;
    return authReq.user?.sessionId || req.ip || 'unknown';
  },
  handler: (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    logger.audit('Command rate limit exceeded', {
      user: authReq.user?.username,
      sessionId: authReq.user?.sessionId,
      ip: req.ip,
      path: req.path
    });
    res.status(429).json({
      error: 'Too many command executions, please slow down.'
    });
  }
});

// Helmet security configuration
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:", "http://localhost:*", "https://localhost:*"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      workerSrc: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  } : false,
  crossOriginEmbedderPolicy: false, // Allow embedding for development
});

// Command input sanitization and validation
export const sanitizeCommandInput = [
  body('command')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Command must be between 1 and 500 characters')
    .matches(/^[a-zA-Z0-9\s\-_./\\:'"=,@\[\]\(\)\{\}]+$/)
    .withMessage('Command contains invalid characters')
    .custom((value: string) => {
      // Block potentially dangerous commands and patterns
      const dangerousPatterns = [
        /rm\s+-rf/i,
        /sudo\s+/i,
        /chmod\s+777/i,
        /passwd\s*/i,
        /su\s+/i,
        /wget\s+/i,
        /curl\s+.*\|\s*sh/i,
        />\s*\/dev\//i,
        />\s*&/i,
        /\|\s*sh/i,
        /&\s*&/i,
        /;\s*rm/i,
        /\$\(/i,
        /`[^`]*`/i,
        /exec\s*\(/i,
        /eval\s*\(/i,
        /<\s*script/i,
        /javascript:/i,
        /vbscript:/i,
        /onload\s*=/i,
        /onerror\s*=/i,
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(value)) {
          throw new Error(`Dangerous command pattern detected: ${pattern.source}`);
        }
      }
      
      return true;
    })
];

// Input validation for file paths
export const validateFilePath = [
  param('filepath')
    .matches(/^[a-zA-Z0-9\s\-_./]+$/)
    .withMessage('Invalid file path format')
    .isLength({ max: 255 })
    .withMessage('File path too long')
    .custom((value: string) => {
      // Prevent directory traversal
      if (value.includes('../') || value.includes('..\\')) {
        throw new Error('Directory traversal detected');
      }
      
      // Prevent access to sensitive system files
      const forbiddenPaths = [
        '/etc/passwd',
        '/etc/shadow',
        '/proc/',
        '/sys/',
        '/dev/',
        'C:\\Windows\\',
        'C:\\Program Files\\',
        '\\Windows\\',
        '\\Program Files\\'
      ];
      
      for (const forbidden of forbiddenPaths) {
        if (value.toLowerCase().includes(forbidden.toLowerCase())) {
          throw new Error('Access to system files forbidden');
        }
      }
      
      return true;
    })
];

// Session validation
export const validateSession = [
  body('sessionId')
    .matches(/^[a-zA-Z0-9\-_]+$/)
    .withMessage('Invalid session ID format')
    .isLength({ min: 10, max: 100 })
    .withMessage('Session ID length invalid')
];

// Request validation error handler
export const handleValidationErrors = (
  req: Request, 
  res: Response, 
  next: NextFunction
): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const authReq = req as AuthenticatedRequest;
    
    logger.audit('Validation failed', {
      errors: errors.array(),
      user: authReq.user?.username,
      ip: req.ip,
      path: req.path,
      method: req.method,
      body: req.body,
      params: req.params,
      query: req.query
    });
    
    const validationError = new ValidationError('Validation failed', errors.array());
    res.status(400).json({
      error: validationError.message,
      details: validationError.details
    });
    return;
  }
  next();
};

// CORS configuration
export const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://localhost:3000',
      'https://localhost:3001',
      'http://127.0.0.1:3000',
      'https://127.0.0.1:3000'
    ];
    
    // Add production domains if configured
    if (process.env.FRONTEND_URL) {
      allowedOrigins.push(process.env.FRONTEND_URL);
    }
    if (process.env.ALLOWED_ORIGINS) {
      const additionalOrigins = process.env.ALLOWED_ORIGINS.split(',');
      allowedOrigins.push(...additionalOrigins);
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.audit('CORS blocked request', { 
        origin, 
        allowedOrigins,
        userAgent: 'N/A' // Not available in CORS preflight
      });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200 // Some legacy browsers choke on 204
};

// Security audit middleware
export const auditRequest = (req: Request, res: Response, next: NextFunction): void => {
  // Log sensitive operations
  const sensitiveEndpoints = [
    '/auth/login',
    '/auth/logout', 
    '/api/command',
    '/api/session',
    '/api/upload'
  ];
  
  if (sensitiveEndpoints.some(endpoint => req.path.includes(endpoint))) {
    const authReq = req as AuthenticatedRequest;
    logger.audit('Sensitive endpoint accessed', {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      user: authReq.user?.username,
      sessionId: authReq.user?.sessionId,
      contentType: req.get('Content-Type'),
      contentLength: req.get('Content-Length')
    });
  }
  
  next();
};

// Content type validation middleware
export const validateContentType = (expectedType: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentType = req.get('Content-Type');
    
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      if (!contentType || !contentType.includes(expectedType)) {
        logger.audit('Invalid content type', {
          expected: expectedType,
          received: contentType,
          path: req.path,
          method: req.method,
          ip: req.ip
        });
        res.status(415).json({
          error: `Invalid content type. Expected: ${expectedType}`
        });
        return;
      }
    }
    
    next();
  };
};

// Request size limitation middleware
export const limitRequestSize = (maxSize: number = 1024 * 1024) => { // 1MB default
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = parseInt(req.get('Content-Length') || '0');
    
    if (contentLength > maxSize) {
      logger.audit('Request size exceeded', {
        contentLength,
        maxSize,
        path: req.path,
        ip: req.ip
      });
      res.status(413).json({
        error: 'Request entity too large'
      });
      return;
    }
    
    next();
  };
};