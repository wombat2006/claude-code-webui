import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';
import { getErrorMessage } from '../utils/errorHandling';

export interface SimpleAuthRequest extends Request {
  user?: {
    username: string;
    role: string;
  };
  isAuthenticated?: boolean;
}

// Simple session store (in production, use Redis)
const sessions = new Map<string, { username: string; role: string; lastAccess: number }>();
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT || '30') * 60 * 1000; // minutes to ms

// Clean up expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccess > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
    }
  }
}, 60000); // Clean up every minute

function generateSessionId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

export const login = (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
    
    if (username === adminUsername && password === adminPassword) {
      const sessionId = generateSessionId();
      const sessionData = {
        username: adminUsername,
        role: 'admin',
        lastAccess: Date.now()
      };
      
      sessions.set(sessionId, sessionData);
      
      // Set session cookie
      res.cookie('sessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: SESSION_TIMEOUT
      });
      
      logger.audit('User login successful', {
        username: adminUsername,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      
      res.json({
        success: true,
        user: {
          username: adminUsername,
          role: 'admin'
        }
      });
    } else {
      logger.audit('Login attempt failed: Invalid credentials', {
        username,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      
      res.status(401).json({
        error: 'Invalid username or password'
      });
    }
  } catch (error) {
    logger.error('Login error', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({
      error: 'Internal server error'
    });
  }
};

export const logout = (req: SimpleAuthRequest, res: Response) => {
  try {
    const sessionId = req.cookies.sessionId;
    
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      sessions.delete(sessionId);
      
      logger.audit('User logout', {
        username: session?.username,
        ip: req.ip
      });
    }
    
    res.clearCookie('sessionId');
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({
      error: 'Internal server error'
    });
  }
};

export const getCurrentUser = (req: SimpleAuthRequest, res: Response) => {
  if (req.user) {
    res.json({
      user: req.user,
      authenticated: true
    });
  } else {
    res.status(401).json({
      error: 'Not authenticated'
    });
  }
};

export const verifyAuth = (req: SimpleAuthRequest, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.cookies.sessionId;
    
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }
    
    const session = sessions.get(sessionId)!;
    const now = Date.now();
    
    // Check if session has expired
    if (now - session.lastAccess > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
      res.clearCookie('sessionId');
      return res.status(401).json({
        error: 'Session expired'
      });
    }
    
    // Update last access time
    session.lastAccess = now;
    sessions.set(sessionId, session);
    
    // Add user info to request
    req.user = {
      username: session.username,
      role: session.role
    };
    req.isAuthenticated = true;
    
    next();
  } catch (error) {
    logger.error('Auth verification error', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({
      error: 'Internal server error'
    });
  }
};

export const validateLogin = [
  // Basic validation middleware can be added here
  (req: Request, res: Response, next: NextFunction) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password are required'
      });
    }
    
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        error: 'Username and password must be strings'
      });
    }
    
    if (username.length > 50 || password.length > 100) {
      return res.status(400).json({
        error: 'Username or password too long'
      });
    }
    
    next();
  }
];

// WebSocket authentication
export const verifyWebSocketAuth = (socket: any, next: any) => {
  try {
    const sessionId = socket.request.headers.cookie
      ?.split(';')
      ?.find((c: string) => c.trim().startsWith('sessionId='))
      ?.split('=')[1];
    
    if (!sessionId || !sessions.has(sessionId)) {
      logger.audit('WebSocket connection denied: No valid session', {
        socketId: socket.id,
        ip: socket.handshake.address
      });
      return next(new Error('Authentication required'));
    }
    
    const session = sessions.get(sessionId)!;
    const now = Date.now();
    
    if (now - session.lastAccess > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
      logger.audit('WebSocket connection denied: Session expired', {
        socketId: socket.id,
        ip: socket.handshake.address
      });
      return next(new Error('Session expired'));
    }
    
    // Update last access
    session.lastAccess = now;
    sessions.set(sessionId, session);
    
    // Add user info to socket
    socket.user = {
      username: session.username,
      role: session.role
    };
    
    logger.audit('WebSocket connection authenticated', {
      socketId: socket.id,
      username: session.username,
      ip: socket.handshake.address
    });
    
    next();
  } catch (error) {
    logger.error('WebSocket auth error', error instanceof Error ? error : new Error(String(error)));
    next(new Error('Authentication failed'));
  }
};

// Rate limiting for login attempts
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();

export const loginLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip;
  const now = Date.now();
  const maxAttempts = 5;
  const windowMs = 15 * 60 * 1000; // 15 minutes
  
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
    return next();
  }
  
  const attempts = loginAttempts.get(ip)!;
  
  // Reset counter if window has passed
  if (now - attempts.lastAttempt > windowMs) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
    return next();
  }
  
  // Check if exceeded max attempts
  if (attempts.count >= maxAttempts) {
    logger.audit('Login rate limit exceeded', {
      ip,
      attempts: attempts.count,
      userAgent: req.get('User-Agent')
    });
    
    return res.status(429).json({
      error: 'Too many login attempts. Please try again later.'
    });
  }
  
  // Increment counter
  attempts.count++;
  attempts.lastAttempt = now;
  loginAttempts.set(ip, attempts);
  
  next();
};