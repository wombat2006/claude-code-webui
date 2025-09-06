const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const logger = require('../config/logger');

// JWT Secret from environment
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

// Simple user store (in production, use database)
const users = new Map([
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

// Active sessions tracking
const activeSessions = new Map();

// Rate limiting for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: {
    error: 'Too many login attempts, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.audit('Rate limit exceeded for login', {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    res.status(429).json({
      error: 'Too many login attempts, please try again later.'
    });
  }
});

// Input validation for login
const validateLogin = [
  body('username')
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
];

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { 
      username: user.username, 
      role: user.role,
      sessionId: `${user.username}-${Date.now()}`
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
};

// Verify JWT token middleware
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    logger.audit('Access denied: No token provided', {
      ip: req.ip,
      path: req.path,
      userAgent: req.get('User-Agent')
    });
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if session is still active
    if (!activeSessions.has(decoded.sessionId)) {
      logger.audit('Access denied: Invalid session', {
        username: decoded.username,
        sessionId: decoded.sessionId,
        ip: req.ip
      });
      return res.status(401).json({ error: 'Session expired or invalid.' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    logger.audit('Access denied: Invalid token', {
      error: error.message,
      ip: req.ip,
      path: req.path
    });
    res.status(403).json({ error: 'Invalid token.' });
  }
};

// Socket.io authentication middleware
const verifySocketToken = (socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    logger.audit('Socket connection denied: No token', {
      socketId: socket.id,
      ip: socket.handshake.address
    });
    return next(new Error('Authentication error: No token provided'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if session is still active
    if (!activeSessions.has(decoded.sessionId)) {
      logger.audit('Socket connection denied: Invalid session', {
        username: decoded.username,
        sessionId: decoded.sessionId,
        socketId: socket.id,
        ip: socket.handshake.address
      });
      return next(new Error('Authentication error: Session expired'));
    }

    socket.user = decoded;
    logger.audit('Socket connection authenticated', {
      username: decoded.username,
      socketId: socket.id,
      ip: socket.handshake.address
    });
    next();
  } catch (error) {
    logger.audit('Socket connection denied: Invalid token', {
      error: error.message,
      socketId: socket.id,
      ip: socket.handshake.address
    });
    next(new Error('Authentication error: Invalid token'));
  }
};

// Login controller
const login = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.audit('Login failed: Validation errors', {
        errors: errors.array(),
        ip: req.ip
      });
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { username, password } = req.body;
    const user = users.get(username);

    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      logger.audit('Login failed: Invalid credentials', {
        username,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Generate token and create session
    const token = generateToken(user);
    const decoded = jwt.decode(token);
    const sessionId = decoded.sessionId;

    // Store active session
    activeSessions.set(sessionId, {
      username: user.username,
      role: user.role,
      loginTime: new Date(),
      lastActivity: new Date(),
      ip: req.ip
    });

    // Update last login
    user.lastLogin = new Date();

    logger.audit('User logged in successfully', {
      username: user.username,
      sessionId,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    res.json({
      message: 'Login successful',
      token,
      user: {
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    logger.error('Login error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Logout controller
const logout = (req, res) => {
  try {
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
    logger.error('Logout error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get current user info
const getCurrentUser = (req, res) => {
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

// Session cleanup (call periodically)
const cleanupExpiredSessions = () => {
  const now = new Date();
  const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT) || 30; // minutes
  
  for (const [sessionId, session] of activeSessions.entries()) {
    const timeDiff = (now - session.lastActivity) / (1000 * 60); // minutes
    
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

// Update session activity
const updateSessionActivity = (sessionId) => {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.lastActivity = new Date();
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

module.exports = {
  loginLimiter,
  validateLogin,
  verifyToken,
  verifySocketToken,
  login,
  logout,
  getCurrentUser,
  updateSessionActivity,
  activeSessions
};