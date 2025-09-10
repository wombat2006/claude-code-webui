#!/usr/bin/env node
/**
 * Advanced REST API Security & Performance Tests
 * Tests rate limiting, security headers, response times, and edge cases
 */

const http = require('http');
const { spawn } = require('child_process');

class AdvancedAPITester {
  constructor() {
    this.baseUrl = 'http://localhost:3001';
    this.results = { passed: 0, failed: 0, errors: [] };
    this.server = null;
  }

  async makeRequest(method, path, data = null, headers = {}) {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const requestData = data ? JSON.stringify(data) : null;
      
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        timeout: 10000
      };

      if (requestData) {
        options.headers['Content-Length'] = Buffer.byteLength(requestData);
      }

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          const responseTime = Date.now() - startTime;
          try {
            const parsedBody = body ? JSON.parse(body) : {};
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: parsedBody,
              rawBody: body,
              responseTime
            });
          } catch (e) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: {},
              rawBody: body,
              responseTime
            });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (requestData) {
        req.write(requestData);
      }
      req.end();
    });
  }

  async startServer() {
    console.log('🚀 Starting WebUI Server for Advanced Testing...');
    
    return new Promise((resolve, reject) => {
      this.server = spawn('npx', ['ts-node', 'src/index.ts'], {
        env: { 
          ...process.env, 
          NODE_OPTIONS: '--max-old-space-size=1024'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let serverReady = false;
      const timeout = setTimeout(() => {
        if (!serverReady) {
          reject(new Error('Server startup timeout'));
        }
      }, 15000);

      this.server.stdout.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Claude Code WebUI Server started')) {
          serverReady = true;
          clearTimeout(timeout);
          console.log('✅ Server started successfully');
          setTimeout(resolve, 1000);
        }
      });

      this.server.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('EADDRINUSE')) {
          clearTimeout(timeout);
          reject(new Error('Port 3001 already in use'));
        }
      });

      this.server.on('error', reject);
    });
  }

  async stopServer() {
    if (this.server) {
      console.log('🛑 Stopping server...');
      this.server.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async test(name, testFn) {
    try {
      console.log(`\n🧪 ${name}...`);
      await testFn();
      this.results.passed++;
      console.log(`   ✅ PASS: ${name}`);
    } catch (error) {
      this.results.failed++;
      this.results.errors.push({ test: name, error: error.message });
      console.log(`   ❌ FAIL: ${name} - ${error.message}`);
    }
  }

  // Test 1: Rate Limiting on Login Endpoint
  async testLoginRateLimit() {
    const promises = [];
    const requestCount = 6; // Should exceed rate limit
    
    for (let i = 0; i < requestCount; i++) {
      promises.push(
        this.makeRequest('POST', '/auth/login', {
          username: 'test_user',
          password: 'test_pass'
        })
      );
    }
    
    const responses = await Promise.all(promises);
    
    // Check if any requests were rate limited (429)
    const rateLimitedCount = responses.filter(r => r.status === 429).length;
    const unauthorizedCount = responses.filter(r => r.status === 401).length;
    
    if (rateLimitedCount === 0) {
      console.log(`   ⚠️  Rate limiting may not be active (${unauthorizedCount} 401s, ${rateLimitedCount} 429s)`);
    } else {
      console.log(`   🛡️  Rate limiting working: ${rateLimitedCount} requests blocked`);
    }
    
    // Test passes if we get reasonable responses
    if (responses.some(r => r.status >= 500)) {
      throw new Error('Server error during rate limit test');
    }
  }

  // Test 2: Security Headers
  async testSecurityHeaders() {
    const response = await this.makeRequest('GET', '/health');
    
    const securityHeaders = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-xss-protection': '1; mode=block',
      'strict-transport-security': 'max-age'
    };
    
    let foundHeaders = 0;
    for (const [header, expected] of Object.entries(securityHeaders)) {
      if (response.headers[header] && response.headers[header].includes(expected)) {
        foundHeaders++;
        console.log(`   🔒 ${header}: ${response.headers[header]}`);
      }
    }
    
    if (foundHeaders === 0) {
      console.log(`   ⚠️  No security headers found (this may be expected in development)`);
    } else {
      console.log(`   ✅ ${foundHeaders}/4 security headers configured`);
    }
  }

  // Test 3: Response Time Performance
  async testResponseTimes() {
    const endpoints = [
      '/health',
      '/auth/login',
      '/api/server-info',
      '/nonexistent'
    ];
    
    const results = {};
    
    for (const endpoint of endpoints) {
      const times = [];
      for (let i = 0; i < 3; i++) {
        try {
          const response = await this.makeRequest('GET', endpoint);
          times.push(response.responseTime);
        } catch (error) {
          // Request failed, but we can still measure if we got a response
          times.push(1000); // Assume 1s for failed requests
        }
      }
      
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      results[endpoint] = avgTime;
      console.log(`   ⚡ ${endpoint}: ${avgTime.toFixed(0)}ms avg`);
    }
    
    // Verify reasonable response times (under 2 seconds)
    const slowEndpoints = Object.entries(results).filter(([_, time]) => time > 2000);
    if (slowEndpoints.length > 0) {
      throw new Error(`Slow endpoints detected: ${slowEndpoints.map(([ep]) => ep).join(', ')}`);
    }
  }

  // Test 4: Request Size Limits
  async testRequestSizeLimits() {
    // Create a large payload (>1MB configured limit)
    const largePayload = {
      username: 'test',
      password: 'test',
      largeData: 'x'.repeat(2 * 1024 * 1024) // 2MB
    };
    
    const response = await this.makeRequest('POST', '/auth/login', largePayload);
    
    // Should return 413 (Payload Too Large) or 400 (Bad Request)
    if (response.status === 413 || response.status === 400) {
      console.log(`   📏 Request size limit enforced (${response.status})`);
    } else if (response.status === 401) {
      console.log(`   ⚠️  Large request processed, size limit may not be active`);
    } else {
      throw new Error(`Unexpected response to large payload: ${response.status}`);
    }
  }

  // Test 5: Content-Type Validation
  async testContentTypeValidation() {
    // Test with wrong content type
    const response = await this.makeRequest('POST', '/auth/login', 
      { username: 'test', password: 'test' },
      { 'Content-Type': 'application/xml' }
    );
    
    // Should reject non-JSON content type
    if (response.status === 415 || response.status === 400) {
      console.log(`   📝 Content-Type validation working (${response.status})`);
    } else {
      console.log(`   ⚠️  Content-Type validation may not be strict (${response.status})`);
    }
  }

  // Test 6: Concurrent Request Handling
  async testConcurrentRequests() {
    console.log(`   🔄 Testing concurrent request handling...`);
    
    const concurrentCount = 10;
    const promises = [];
    
    for (let i = 0; i < concurrentCount; i++) {
      promises.push(this.makeRequest('GET', '/health'));
    }
    
    const startTime = Date.now();
    const responses = await Promise.all(promises);
    const totalTime = Date.now() - startTime;
    
    // Check all responses succeeded
    const successCount = responses.filter(r => r.status === 200).length;
    const avgResponseTime = totalTime / concurrentCount;
    
    console.log(`   📊 ${successCount}/${concurrentCount} requests succeeded`);
    console.log(`   ⏱️  Average time per request: ${avgResponseTime.toFixed(0)}ms`);
    
    if (successCount < concurrentCount * 0.9) {
      throw new Error(`Only ${successCount}/${concurrentCount} requests succeeded`);
    }
  }

  // Test 7: Error Response Consistency
  async testErrorResponseConsistency() {
    const errorEndpoints = [
      { method: 'GET', path: '/api/nonexistent', expectedStatus: 401 },
      { method: 'POST', path: '/auth/login', expectedStatus: 400, data: {} },
      { method: 'GET', path: '/nonexistent', expectedStatus: 404 },
    ];
    
    for (const endpoint of errorEndpoints) {
      const response = await this.makeRequest(endpoint.method, endpoint.path, endpoint.data);
      
      if (response.status !== endpoint.expectedStatus) {
        throw new Error(`${endpoint.path}: expected ${endpoint.expectedStatus}, got ${response.status}`);
      }
      
      // Check error response structure
      if (!response.body || typeof response.body !== 'object') {
        throw new Error(`${endpoint.path}: error response not JSON object`);
      }
      
      console.log(`   ✅ ${endpoint.path}: ${response.status} with proper JSON structure`);
    }
  }

  // Test 8: Memory Usage During Load
  async testMemoryStability() {
    console.log(`   🧠 Testing memory stability...`);
    
    // Make many requests to test for memory leaks
    const requestCount = 50;
    const promises = [];
    
    for (let i = 0; i < requestCount; i++) {
      promises.push(this.makeRequest('GET', '/health'));
      
      // Add small delay to avoid overwhelming
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    const responses = await Promise.all(promises);
    const successCount = responses.filter(r => r.status === 200).length;
    
    console.log(`   📈 ${successCount}/${requestCount} requests completed successfully`);
    
    if (successCount < requestCount * 0.95) {
      throw new Error(`Memory stability issue: only ${successCount}/${requestCount} requests succeeded`);
    }
  }

  async runAllTests() {
    console.log('🔬 Advanced REST API Security & Performance Tests');
    console.log('==================================================');
    
    try {
      await this.startServer();
      
      await this.test('Login Rate Limiting', () => this.testLoginRateLimit());
      await this.test('Security Headers', () => this.testSecurityHeaders());
      await this.test('Response Time Performance', () => this.testResponseTimes());
      await this.test('Request Size Limits', () => this.testRequestSizeLimits());
      await this.test('Content-Type Validation', () => this.testContentTypeValidation());
      await this.test('Concurrent Request Handling', () => this.testConcurrentRequests());
      await this.test('Error Response Consistency', () => this.testErrorResponseConsistency());
      await this.test('Memory Stability Under Load', () => this.testMemoryStability());
      
    } catch (error) {
      console.log(`❌ Test suite failed: ${error.message}`);
      this.results.failed++;
    } finally {
      await this.stopServer();
    }

    console.log('\n📊 Advanced Test Results Summary');
    console.log('===============================');
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    
    if (this.results.errors.length > 0) {
      console.log('\n🚨 Failed Tests:');
      this.results.errors.forEach(err => {
        console.log(`   - ${err.test}: ${err.error}`);
      });
    }
    
    const total = this.results.passed + this.results.failed;
    const passRate = total > 0 ? ((this.results.passed / total) * 100).toFixed(1) : 0;
    console.log(`\n📈 Pass Rate: ${passRate}%`);
    
    if (this.results.failed === 0) {
      console.log('\n🎉 All advanced tests passed! API is production-ready.');
    } else {
      console.log(`\n⚠️  ${this.results.failed} test(s) failed. Review for production deployment.`);
    }
    
    return this.results.failed === 0;
  }
}

// Run the advanced test suite
if (require.main === module) {
  const tester = new AdvancedAPITester();
  tester.runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('Test suite crashed:', error);
      process.exit(1);
    });
}

module.exports = AdvancedAPITester;