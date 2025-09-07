/**
 * Base Controller Class
 * Provides common functionality for all controllers
 */

class BaseController {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  /**
   * Standard logging method
   */
  log(message, data = {}) {
    const timestamp = new Date().toISOString();
    this.logger.log(`[${this.constructor.name} ${timestamp}] ${message}`, 
      data && Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '');
  }

  /**
   * Standard error response
   */
  errorResponse(res, error, statusCode = 500) {
    this.log('Error occurred', { 
      error: error.message,
      statusCode,
      stack: error.stack 
    });

    return res.status(statusCode).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Standard success response
   */
  successResponse(res, data, message = 'Success') {
    return res.json({
      success: true,
      message,
      data,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Async handler wrapper for error handling
   */
  asyncHandler(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  /**
   * Validate required fields in request
   */
  validateRequired(req, fields = []) {
    const missing = fields.filter(field => 
      req.body[field] === undefined || req.body[field] === null
    );
    
    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }
  }
}

module.exports = BaseController;