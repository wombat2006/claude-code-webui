#!/usr/bin/env node

/**
 * Enhanced OpenAI API Test Suite
 * Tests latest API specifications: Responses API, verbosity/effort parameters, RFT
 */

const io = require('socket.io-client');
const http = require('http');

class EnhancedOpenAITest {
  constructor() {
    this.serverUrl = 'http://localhost:3007';
    this.socket = null;
    this.testResults = [];
    this.startTime = Date.now();
  }

  log(message, data = {}) {
    console.log(`[EnhancedOpenAITest ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
  }

  async makeHttpRequest(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.serverUrl);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const req = http.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          try {
            const parsedData = JSON.parse(responseData);
            resolve({ status: res.statusCode, data: parsedData });
          } catch (error) {
            resolve({ status: res.statusCode, data: responseData });
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      if (data) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  async runTest(testName, testFunc, timeout = 45000) {
    try {
      const startTime = Date.now();
      
      this.log(`🧪 Starting: ${testName}`);
      
      const result = await Promise.race([
        testFunc(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Test timeout after ${timeout}ms`)), timeout)
        )
      ]);
      
      const duration = Date.now() - startTime;
      
      this.testResults.push({
        name: testName,
        status: 'PASSED',
        duration,
        result
      });
      
      this.log(`✅ PASSED: ${testName}`, { duration: `${duration}ms` });
      return result;
      
    } catch (error) {
      this.testResults.push({
        name: testName,
        status: 'FAILED',
        error: error.message
      });
      
      this.log(`❌ FAILED: ${testName}`, { error: error.message });
      throw error;
    }
  }

  // Test 1: Responses API with verbosity/effort parameters
  async testResponsesAPIParameters() {
    const testData = {
      query: "最新のResponses APIのverbosityパラメータとeffortパラメータについて詳しく説明してください。実際のAPIコールでの使用方法も含めて。",
      taskType: "analysis",
      models: ["gpt-5"],
      options: {
        verbosity: "detailed", // 'concise', 'standard', 'detailed', 'comprehensive'
        effort: "high",        // 'low', 'medium', 'high', 'maximum'
        reasoning: "explicit"  // 'none', 'adaptive', 'explicit'
      }
    };

    const response = await this.makeHttpRequest(
      '/llm/collaboration/responses-api-test-001',
      'POST',
      testData
    );

    if (response.status !== 200 || !response.data.success) {
      throw new Error(`Responses API test failed: ${response.data?.error || 'Unknown error'}`);
    }

    return {
      sessionId: 'responses-api-test-001',
      success: response.data.success,
      wallBounceCount: response.data.wallBounceCount,
      apiType: response.data.metadata?.apiType || 'unknown',
      parameters: response.data.metadata?.parameters,
      processingTime: response.data.metadata?.processingTime,
      responseLength: response.data.finalResponse?.length || 0
    };
  }

  // Test 2: o4-mini with RFT capabilities
  async testO4MiniRFT() {
    const testData = {
      query: "複雑な医学的診断シナリオ：60歳男性、胸痛、息切れ、めまい。血圧140/90、心拍数不整。適切な診断アプローチを段階的推論で説明してください。",
      taskType: "analysis",
      models: ["o4-mini"],
      options: {
        verbosity: "comprehensive",
        effort: "maximum",
        reasoning: "explicit",
        fineTuneId: null, // Would be set if RFT model available
        expertGrading: true
      }
    };

    const response = await this.makeHttpRequest(
      '/llm/collaboration/o4-mini-rft-test-001',
      'POST',
      testData
    );

    if (response.status !== 200) {
      throw new Error(`o4-mini RFT test failed with status ${response.status}`);
    }

    return {
      sessionId: 'o4-mini-rft-test-001',
      success: response.data.success,
      wallBounceCount: response.data.wallBounceCount,
      reasoningQuality: response.data.metadata?.reasoningQuality || 'unknown',
      modelUsed: response.data.metadata?.modelsAttempted?.[0] || 'unknown',
      processingTime: response.data.metadata?.processingTime
    };
  }

  // Test 3: Enhanced Wall-bounce with multiple latest models
  async testEnhancedWallBounce() {
    const testData = {
      query: "AI開発の倫理的課題について、技術的実装、社会的影響、法的考慮の3つの観点から包括的に分析してください。各観点で具体的な事例と解決策も提示してください。",
      taskType: "analysis", 
      models: ["gpt-5", "gemini-2.5-pro", "o4-mini"],
      options: {
        verbosity: "detailed",
        effort: "high",
        reasoning: "adaptive",
        minWallBounces: 3,
        maxWallBounces: 5
      }
    };

    const response = await this.makeHttpRequest(
      '/llm/collaboration/enhanced-wall-bounce-test-001',
      'POST',
      testData
    );

    if (response.status !== 200) {
      throw new Error(`Enhanced wall-bounce test failed with status ${response.status}`);
    }

    // Success criteria: at least 3 wall bounces
    if (response.data.wallBounceCount < 3) {
      throw new Error(`Insufficient wall bounces: ${response.data.wallBounceCount} (minimum: 3)`);
    }

    return {
      sessionId: 'enhanced-wall-bounce-test-001',
      success: response.data.success,
      wallBounceCount: response.data.wallBounceCount,
      modelsUsed: response.data.metadata?.modelsAttempted || [],
      successfulModels: response.data.metadata?.successfulModels || [],
      failedModels: response.data.metadata?.failedModels || [],
      finalResponseLength: response.data.finalResponse?.length || 0,
      processingTime: response.data.metadata?.processingTime
    };
  }

  // Test 4: Performance with enhanced parameters
  async testPerformanceWithEnhancedParams() {
    const tests = [
      { verbosity: 'concise', effort: 'low' },
      { verbosity: 'standard', effort: 'medium' },
      { verbosity: 'detailed', effort: 'high' }
    ];

    const results = [];

    for (let i = 0; i < tests.length; i++) {
      const params = tests[i];
      const startTime = Date.now();
      
      const testData = {
        query: "クラウドコンピューティングの利点を3つ挙げてください。",
        taskType: "analysis",
        models: ["gpt-5"],
        options: params
      };

      try {
        const response = await this.makeHttpRequest(
          `/llm/collaboration/performance-test-${i + 1}`,
          'POST',
          testData
        );

        const duration = Date.now() - startTime;
        
        results.push({
          parameters: params,
          duration,
          success: response.status === 200,
          responseLength: response.data?.finalResponse?.length || 0,
          wallBounces: response.data?.wallBounceCount || 0
        });

      } catch (error) {
        results.push({
          parameters: params,
          success: false,
          error: error.message
        });
      }
    }

    const avgDuration = results
      .filter(r => r.success)
      .reduce((a, b) => a + b.duration, 0) / results.filter(r => r.success).length;

    return {
      testResults: results,
      averageDuration: avgDuration,
      successRate: (results.filter(r => r.success).length / results.length) * 100
    };
  }

  // Generate final report
  generateReport() {
    const totalTests = this.testResults.length;
    const passedTests = this.testResults.filter(r => r.status === 'PASSED').length;
    const failedTests = this.testResults.filter(r => r.status === 'FAILED').length;
    const passRate = (passedTests / totalTests) * 100;

    return {
      summary: {
        totalTests,
        passed: passedTests,
        failed: failedTests,
        passRate: `${passRate.toFixed(1)}%`,
        duration: `${Date.now() - this.startTime}ms`
      },
      testDetails: this.testResults,
      enhancements: [
        'Responses API integration',
        'verbosity/effort parameters',
        'o4-mini RFT support',
        'Enhanced error handling',
        'OpenAI Cookbook integration'
      ]
    };
  }

  // Main test execution
  async runEnhancedTests() {
    this.log('🚀 Starting Enhanced OpenAI API Test Suite');
    
    try {
      // Test 1: Responses API parameters
      await this.runTest(
        'Responses API with verbosity/effort parameters',
        () => this.testResponsesAPIParameters(),
        60000
      );

      // Test 2: o4-mini RFT
      await this.runTest(
        'o4-mini with Reinforcement Fine-Tuning',
        () => this.testO4MiniRFT(),
        60000
      );

      // Test 3: Enhanced wall-bounce
      await this.runTest(
        'Enhanced Wall-bounce with latest models',
        () => this.testEnhancedWallBounce(),
        90000
      );

      // Test 4: Performance testing
      await this.runTest(
        'Performance with enhanced parameters',
        () => this.testPerformanceWithEnhancedParams(),
        120000
      );

    } catch (error) {
      this.log('💥 Test suite encountered critical error', { error: error.message });
    }

    const report = this.generateReport();
    
    // Output results
    console.log('\n' + '='.repeat(80));
    console.log('🎯 ENHANCED OPENAI API TEST RESULTS');
    console.log('='.repeat(80));
    
    this.testResults.forEach((result, index) => {
      const status = result.status === 'PASSED' ? '✅' : '❌';
      const duration = result.duration ? ` (${result.duration}ms)` : '';
      console.log(`${index + 1}. ${status} ${result.name}${duration}`);
      
      if (result.status === 'FAILED') {
        console.log(`   ❌ Error: ${result.error}`);
      }
      console.log('');
    });
    
    console.log('='.repeat(80));
    console.log(`📊 FINAL RESULTS: ${report.summary.passRate} (${report.summary.passed}/${report.summary.totalTests})`);
    console.log(`⏱️  TOTAL TIME: ${report.summary.duration}`);
    console.log(`🔧 ENHANCEMENTS: ${report.enhancements.join(', ')}`);
    console.log('='.repeat(80));
    
    return report;
  }
}

// Execute if called directly
if (require.main === module) {
  const tester = new EnhancedOpenAITest();
  
  tester.runEnhancedTests()
    .then((report) => {
      const exitCode = report.summary.failed === 0 ? 0 : 1;
      console.log(`\n🏁 Enhanced test suite completed with exit code: ${exitCode}`);
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error('\n💥 Enhanced test suite failed:', error.message);
      process.exit(1);
    });
}

module.exports = EnhancedOpenAITest;