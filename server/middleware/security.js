const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, param, query, validationResult } = require('express-validator');
const logger = require('../config/logger');

// IP whitelist from environment variable
const getAllowedIPs = () => {
  const allowedIPs = process.env.ALLOWED_IPS;
  if (!allowedIPs) return null;
  
  return allowedIPs.split(',').map(ip => ip.trim());
};

// IP whitelist middleware
const ipWhitelist = (req, res, next) => {
  const allowedIPs = getAllowedIPs();
  
  // Skip IP check in development or if no IPs configured
  if (process.env.NODE_ENV === 'development' || !allowedIPs) {
    return next();
  }

  const clientIP = req.ip;
  const isAllowed = allowedIPs.some(allowedIP => {
    if (allowedIP.includes('/')) {
      // CIDR notation support (basic implementation)
      const [network, prefixLength] = allowedIP.split('/');
      // For demo purposes - in production, use proper CIDR matching library
      return clientIP.startsWith(network.split('.').slice(0, Math.floor(prefixLength / 8)).join('.'));
    } else {
      return clientIP === allowedIP;
    }
  });

  if (!isAllowed) {
    logger.audit('Access denied: IP not whitelisted', {
      clientIP,
      allowedIPs,
      userAgent: req.get('User-Agent'),
      path: req.path
    });
    return res.status(403).json({ 
      error: 'Access denied: IP not authorized' 
    });
  }

  next();
};

// General rate limiting
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP
  message: {
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.audit('Rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path
    });
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later.'
    });
  }
});

// Command execution rate limiting (stricter)
const commandLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // limit command executions
  message: {
    error: 'Too many command executions, please slow down.',
  },
  keyGenerator: (req) => {
    // Use user session ID instead of IP for authenticated requests
    return req.user ? req.user.sessionId : req.ip;
  },
  handler: (req, res) => {
    logger.audit('Command rate limit exceeded', {
      user: req.user?.username,
      sessionId: req.user?.sessionId,
      ip: req.ip,
      path: req.path
    });
    res.status(429).json({
      error: 'Too many command executions, please slow down.'
    });
  }
});

// Helmet security configuration
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
});

// Input sanitization for command input
const sanitizeCommandInput = [
  body('command')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Command must be between 1 and 500 characters')
    .matches(/^[a-zA-Z0-9\s\-_./\\:'"=,@]+$/)
    .withMessage('Command contains invalid characters')
    .custom((value) => {
      // Block dangerous commands
      const dangerousCommands = [
        'rm -rf', 'sudo', 'chmod 777', 'passwd', 'su ', 'wget', 'curl',
        '>', '>>', '|', '&', ';', '$(', '`', 'exec', 'eval'
      ];
      
      const lowerValue = value.toLowerCase();
      for (const dangerous of dangerousCommands) {
        if (lowerValue.includes(dangerous)) {
          throw new Error(`Dangerous command detected: ${dangerous}`);
        }
      }
      return true;
    })
];

// Input validation for file paths
const validateFilePath = [
  param('filepath')
    .matches(/^[a-zA-Z0-9\s\-_./]+$/)
    .withMessage('Invalid file path format')
    .isLength({ max: 255 })
    .withMessage('File path too long')
];

// Request validation error handler
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.audit('Validation failed', {
      errors: errors.array(),
      user: req.user?.username,
      ip: req.ip,
      path: req.path,
      body: req.body
    });
    
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }
  next();
};

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://localhost:3000',
      'https://localhost:3001'
    ];
    
    // Add production domains if configured
    if (process.env.FRONTEND_URL) {
      allowedOrigins.push(process.env.FRONTEND_URL);
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.audit('CORS blocked request', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Security audit middleware
const auditRequest = (req, res, next) => {
  // Log sensitive operations
  const sensitiveEndpoints = ['/auth/login', '/auth/logout', '/api/command'];
  
  if (sensitiveEndpoints.some(endpoint => req.path.includes(endpoint))) {
    logger.audit('Sensitive endpoint accessed', {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      user: req.user?.username,
      sessionId: req.user?.sessionId
    });
  }
  
  next();
};

module.exports = {
  ipWhitelist,
  generalLimiter,
  commandLimiter,
  securityHeaders,
  sanitizeCommandInput,
  validateFilePath,
  handleValidationErrors,
  corsOptions,
  auditRequest
};