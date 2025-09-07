/**
 * Health Controller
 * Handles health check and memory monitoring endpoints
 */

const BaseController = require('./BaseController');

class HealthController extends BaseController {
  constructor(options = {}) {
    super(options);
    this.region = options.region || 'us-east-1';
    this.instanceType = options.instanceType || 'unknown';
  }

  /**
   * Basic health check endpoint
   */
  getHealth = (req, res) => {
    try {
      const healthData = {
        status: 'OK',
        timestamp: new Date().toISOString(),
        region: this.region,
        instanceType: this.instanceType,
        memory: process.memoryUsage()
      };

      this.log('Health check requested', { 
        ip: req.ip,
        userAgent: req.get('User-Agent') 
      });

      return this.successResponse(res, healthData);
    } catch (error) {
      return this.errorResponse(res, error);
    }
  };

  /**
   * Detailed memory monitoring endpoint
   */
  getMemory = (req, res) => {
    try {
      const memStats = this.monitorMemory();
      
      const memoryData = {
        timestamp: new Date().toISOString(),
        region: this.region,
        memory: memStats,
        limits: {
          recommended: '1400MB',
          maximum: '1800MB'
        },
        os: {
          freeMem: `${Math.round(require('os').freemem() / 1024 / 1024)}MB`,
          totalMem: `${Math.round(require('os').totalmem() / 1024 / 1024)}MB`,
          loadAvg: require('os').loadavg()
        }
      };

      return this.successResponse(res, memoryData);
    } catch (error) {
      return this.errorResponse(res, error);
    }
  };

  /**
   * Memory monitoring utility method
   */
  monitorMemory() {
    const usage = process.memoryUsage();
    const rssUsageMB = Math.round(usage.rss / 1024 / 1024);
    
    const memoryStats = {
      rss: `${rssUsageMB}MB`,
      heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(usage.external / 1024 / 1024)}MB`,
      freeMemory: `${Math.round(require('os').freemem() / 1024 / 1024)}MB`,
      totalMemory: `${Math.round(require('os').totalmem() / 1024 / 1024)}MB`
    };

    this.log('Memory Monitor', memoryStats);

    // Alert if memory usage is high (>1.4GB for 1.8GB system)
    if (rssUsageMB > 1400) {
      this.log('⚠️  HIGH MEMORY WARNING', {
        currentUsage: `${rssUsageMB}MB`,
        limit: '1800MB',
        recommendation: 'Consider offloading to Tokyo VM'
      });
    }
    
    return usage;
  }

  /**
   * Register routes for this controller
   */
  registerRoutes(app) {
    app.get('/health', this.getHealth);
    app.get('/memory', this.getMemory);
    
    this.log('Health routes registered', {
      routes: ['/health', '/memory']
    });
  }
}

module.exports = HealthController;