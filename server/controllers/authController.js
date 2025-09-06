const { login, logout, getCurrentUser } = require('../middleware/auth');

// Health check endpoint
const healthCheck = (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
};

// Get server info (authenticated)
const getServerInfo = (req, res) => {
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

module.exports = {
  login,
  logout,
  getCurrentUser,
  healthCheck,
  getServerInfo
};