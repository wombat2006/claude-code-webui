/**
 * Metrics Controller
 * Handles metrics dashboard and monitoring endpoints
 */

const BaseController = require('./BaseController');
const path = require('path');

class MetricsController extends BaseController {
  constructor(options = {}) {
    super(options);
  }

  /**
   * Serve metrics dashboard HTML file
   * GET /metrics/test-metrics.html
   */
  serveDashboard = (req, res) => {
    try {
      const filePath = path.join(__dirname, '../../../test-metrics.html');
      res.sendFile(filePath);
      this.log('Metrics dashboard served');
    } catch (error) {
      return this.errorResponse(res, error);
    }
  };

  /**
   * Register routes for this controller
   */
  registerRoutes(app) {
    app.get('/metrics/test-metrics.html', this.serveDashboard);
    
    this.log('Metrics routes registered', {
      routes: [
        'GET /metrics/test-metrics.html'
      ]
    });
  }
}

module.exports = MetricsController;