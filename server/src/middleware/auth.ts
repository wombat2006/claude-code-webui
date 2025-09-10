import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { Request, Response, NextFunction } from 'express';
import { getErrorMessage } from '../utils/errorHandling';
import { 
  User, 
  UserSession, 
  JWTPayload, 
  AuthenticatedRequest,
  AuthenticatedSocket,
  LoginRequest,
  LoginResponse,
  AuthenticationError,
  ValidationError 
} from '../types';
import logger from '../config/logger';

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

if (JWT_SECRET === 'dev-secret-change-in-production' && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production environment');
}

// Type-safe user store (in production, use database)
const users = new Map<string, User>([
  ['demo', { 
    username: 'demo', 
    passwordHash: bcrypt.hashSync('demo123', 10),
    role: 'user',
    lastLogin: null
  }],
  ['admin', { 
    username: 'admin', 
    passwordHash: bcrypt.hashSync('admin456', 10),
    role: 'admin',
    lastLogin: null
  }]
]);

// Active sessions tracking with proper typing
const activeSessions = new Map<string, UserSession>();

// Rate limiting for login attempts with environment-specific settings
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

export const loginLimiter = rateLimit({
  windowMs: isTest ? 10 * 1000 : (isProduction ? 15 * 60 * 1000 : 60 * 1000), // Test: 10s, Prod: 15min, Dev: 1min
  max: isTest ? 100 : (isProduction ? 5 : 20), // Test: 100, Prod: 5, Dev: 20
  message: {
    error: 'Too many login attempts, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Don't count validation errors (400) towards rate limit
  skip: (req: Request, res: Response) => {
    return res.statusCode === 400;
  },
  handler: (req: Request, res: Response): void => {
    const resetTime = Math.ceil(((Date.now() + (isTest ? 10 * 1000 : (isProduction ? 15 * 60 * 1000 : 60 * 1000))) - Date.now()) / 1000);
    
    logger.audit('Rate limit exceeded for login', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      resetTime
    });
    
    res.status(429).json({
      status: 'error',
      message: 'Too many login attempts, please try again later.',
      retryAfter: resetTime,
      limit: isTest ? 100 : (isProduction ? 5 : 20),
      window: isTest ? 10 : (isProduction ? 15 * 60 : 60)
    });
  }
});

// Input validation for login with proper typing
export const validateLogin = [
  body('username')
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
];

// Generate JWT token with proper typing
const generateToken = (user: User): string => {
  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    username: user.username, 
    role: user.role,
    sessionId: `${user.username}-${Date.now()}`
  };
  
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
};

// Verify JWT token middleware with proper typing
export const verifyToken = (
  req: AuthenticatedRequest, 
  res: Response, 
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    logger.audit('Access denied: No token provided', {
      ip: req.ip,
      path: req.path,
      userAgent: req.get('User-Agent')
    });
    res.status(401).json({ error: 'Access denied. No token provided.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    
    // Check if session is still active
    if (!activeSessions.has(decoded.sessionId)) {
      logger.audit('Access denied: Invalid session', {
        username: decoded.username,
        sessionId: decoded.sessionId,
        ip: req.ip
      });
      res.status(401).json({ error: 'Session expired or invalid.' });
      return;
    }

    req.user = decoded;
    next();
  } catch (error) {
    const errorMessage = error instanceof Error ? getErrorMessage(error) : 'Unknown error';
    logger.audit('Access denied: Invalid token', {
      error: errorMessage,
      ip: req.ip,
      path: req.path
    });
    res.status(403).json({ error: 'Invalid token.' });
  }
};

// Socket.io authentication middleware with proper typing
export const verifySocketToken = (
  socket: AuthenticatedSocket, 
  next: (err?: Error) => void
): void => {
  const token = socket.handshake.auth.token as string;
  
  if (!token) {
    logger.audit('Socket connection denied: No token', {
      socketId: socket.id,
      ip: socket.handshake.address
    });
    return next(new AuthenticationError('Authentication error: No token provided'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    
    // Check if session is still active
    if (!activeSessions.has(decoded.sessionId)) {
      logger.audit('Socket connection denied: Invalid session', {
        username: decoded.username,
        sessionId: decoded.sessionId,
        socketId: socket.id,
        ip: socket.handshake.address
      });
      return next(new AuthenticationError('Authentication error: Session expired'));
    }

    socket.user = decoded;
    logger.audit('Socket connection authenticated', {
      username: decoded.username,
      socketId: socket.id,
      ip: socket.handshake.address
    });
    next();
  } catch (error) {
    const errorMessage = error instanceof Error ? getErrorMessage(error) : 'Unknown error';
    logger.audit('Socket connection denied: Invalid token', {
      error: errorMessage,
      socketId: socket.id,
      ip: socket.handshake.address
    });
    next(new AuthenticationError('Authentication error: Invalid token'));
  }
};

// Login controller with proper typing
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.audit('Login failed: Validation errors', {
        errors: errors.array(),
        ip: req.ip
      });
      res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
      return;
    }

    const { username, password }: LoginRequest = req.body;
    const user = users.get(username);

    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      logger.audit('Login failed: Invalid credentials', {
        username,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    // Generate token and create session
    const token = generateToken(user);
    const decoded = jwt.decode(token) as JWTPayload;
    const sessionId = decoded.sessionId;

    // Store active session with proper typing
    const sessionData: UserSession = {
      username: user.username,
      role: user.role,
      loginTime: new Date(),
      lastActivity: new Date(),
      ip: req.ip || 'unknown'
    };
    activeSessions.set(sessionId, sessionData);

    // Update last login
    user.lastLogin = new Date();

    logger.audit('User logged in successfully', {
      username: user.username,
      sessionId,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    const response: LoginResponse = {
      message: 'Login successful',
      token,
      user: {
        username: user.username,
        role: user.role
      }
    };

    res.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? getErrorMessage(error) : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error('Login error', error instanceof Error ? error : new Error(String(error)), { ip: req.ip });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Logout controller with proper typing
export const logout = (req: AuthenticatedRequest, res: Response): void => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const sessionId = req.user.sessionId;
    
    // Remove session
    activeSessions.delete(sessionId);

    logger.audit('User logged out', {
      username: req.user.username,
      sessionId,
      ip: req.ip
    });

    res.json({ message: 'Logout successful' });
  } catch (error) {
    const errorMessage = error instanceof Error ? getErrorMessage(error) : 'Unknown error';
    logger.error('Logout error', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get current user info with proper typing
export const getCurrentUser = (req: AuthenticatedRequest, res: Response): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const session = activeSessions.get(req.user.sessionId);
  res.json({
    username: req.user.username,
    role: req.user.role,
    sessionInfo: {
      loginTime: session?.loginTime,
      lastActivity: session?.lastActivity
    }
  });
};

// Session cleanup with proper typing
export const cleanupExpiredSessions = (): void => {
  const now = new Date();
  const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT || '30'); // minutes
  
  for (const [sessionId, session] of activeSessions.entries()) {
    const timeDiff = (now.getTime() - session.lastActivity.getTime()) / (1000 * 60); // minutes
    
    if (timeDiff > sessionTimeout) {
      activeSessions.delete(sessionId);
      logger.audit('Session expired and cleaned up', {
        sessionId,
        username: session.username,
        lastActivity: session.lastActivity
      });
    }
  }
};

// Update session activity with proper typing
export const updateSessionActivity = (sessionId: string): void => {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.lastActivity = new Date();
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

// Export session map for testing/monitoring
export { activeSessions };