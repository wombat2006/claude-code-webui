/**
 * Process Controller  
 * Handles task processing and distributed processing endpoints
 */

const BaseController = require('./BaseController');

class ProcessController extends BaseController {
  constructor(options = {}) {
    super(options);
    this.region = options.region || 'us-east-1';
  }

  /**
   * Main task processing endpoint
   * POST /process
   */
  processTask = this.asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const task = req.body;
    
    this.log('Processing received task', {
      type: task.type,
      requestId: task.requestId,
      fromIP: req.ip
    });

    const result = this.executeTask(task);
    const processingTime = Date.now() - startTime;

    const response = {
      success: true,
      result,
      processingTime,
      memoryUsage: process.memoryUsage(),
      region: this.region
    };

    this.log('Task processed successfully', {
      requestId: task.requestId,
      processingTime: response.processingTime,
      memoryMB: Math.round(response.memoryUsage.rss / 1024 / 1024)
    });

    return res.json(response);
  });

  /**
   * Tokyo VM connectivity test
   * POST /tokyo/test
   */
  testTokyoVM = this.asyncHandler(async (req, res) => {
    const testTask = {
      type: 'ping-test',
      data: {
        message: 'Hello from main VM!',
        testSize: req.body.size || 10
      },
      timestamp: Date.now(),
      requestId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    this.log('Testing Tokyo VM connectivity', { requestId: testTask.requestId });

    try {
      // Try to send to Tokyo VM
      const fetch = require('node-fetch');
      const response = await fetch('http://54.65.178.168:3001/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testTask),
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(`Tokyo VM responded with ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      this.log('Tokyo VM test completed', {
        requestId: testTask.requestId,
        success: result.success,
        latency: result.processingTime
      });

      const testData = {
        testTask,
        tokyoResponse: result,
        mainVMMemory: process.memoryUsage()
      };

      return this.successResponse(res, testData, 'Tokyo VM test completed');

    } catch (error) {
      this.log('Tokyo VM test failed', { error: error.message });
      
      const errorData = {
        error: 'Tokyo VM test failed',
        details: error.message,
        mainVMMemory: process.memoryUsage()
      };
      
      return this.errorResponse(res, new Error(errorData.details), 500);
    }
  });

  /**
   * Execute different types of tasks
   */
  executeTask(task) {
    switch (task.type) {
      case 'memory-test':
        return this.executeMemoryTest(task.data);
      
      case 'computation-test':
        return this.executeComputationTest(task.data);
      
      case 'ping-test':
        return this.executePingTest(task.data);
      
      default:
        return {
          message: `Unknown task type: ${task.type} processed on main VM`,
          receivedData: task.data,
          processedAt: new Date().toISOString(),
          region: this.region
        };
    }
  }

  /**
   * Execute memory test task
   */
  executeMemoryTest(data) {
    const size = data.size || 100;
    const buffer = Buffer.alloc(size * 1024 * 1024); // Allocate specified MB
    buffer.fill('test');
    
    return {
      message: `Processed ${size}MB memory test on main VM`,
      originalMessage: data.message,
      processedAt: new Date().toISOString(),
      region: this.region
    };
  }

  /**
   * Execute computation test task
   */
  executeComputationTest(data) {
    const iterations = data.iterations || 1000000;
    let sum = 0;
    for (let i = 0; i < iterations; i++) {
      sum += Math.random();
    }
    
    return {
      message: `Completed ${iterations} iterations on main VM`,
      result: sum,
      processedAt: new Date().toISOString(),
      region: this.region
    };
  }

  /**
   * Execute ping test task
   */
  executePingTest(data) {
    return {
      message: 'Pong from main VM!',
      originalData: data,
      processedAt: new Date().toISOString(),
      region: this.region
    };
  }

  /**
   * Register routes for this controller
   */
  registerRoutes(app) {
    app.post('/process', this.processTask);
    app.post('/tokyo/test', this.testTokyoVM);
    
    this.log('Process routes registered', {
      routes: ['POST /process', 'POST /tokyo/test']
    });
  }
}

module.exports = ProcessController;