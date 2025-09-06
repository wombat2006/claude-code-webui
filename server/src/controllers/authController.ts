import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { login, logout, getCurrentUser } from '../middleware/auth';

// Re-export auth functions for consistency
export { login, logout, getCurrentUser };

// Health check endpoint
export const healthCheck = (req: AuthenticatedRequest, res: Response): void => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
};

// Get server info (authenticated)
export const getServerInfo = (req: AuthenticatedRequest, res: Response): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  res.json({
    user: req.user.username,
    role: req.user.role,
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version,
      platform: process.platform
    }
  });
};