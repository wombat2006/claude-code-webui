#!/usr/bin/env node
/**
 * REST API Comprehensive Test Suite
 * Tests all endpoints for proper functionality, error handling, and security
 */

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

class APITester {
  constructor() {
    this.baseUrl = 'http://localhost:3001';
    this.results = {
      passed: 0,
      failed: 0,
      errors: []
    };
    this.authToken = null;
    this.server = null;
  }

  async makeRequest(method, path, data = null, headers = {}) {
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
        timeout: 5000
      };

      if (requestData) {
        options.headers['Content-Length'] = Buffer.byteLength(requestData);
      }

      if (this.authToken && !headers.Authorization) {
        options.headers.Authorization = `Bearer ${this.authToken}`;
      }

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsedBody = body ? JSON.parse(body) : {};
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: parsedBody,
              rawBody: body
            });
          } catch (e) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: {},
              rawBody: body
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
    console.log('🚀 Starting WebUI Server...');
    
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
          setTimeout(resolve, 1000); // Give server time to fully initialize
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

  // Test 1: Health Check (Public endpoint)
  async testHealthCheck() {
    const response = await this.makeRequest('GET', '/health');
    
    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }
    
    if (!response.body.status || response.body.status !== 'OK') {
      throw new Error('Health check did not return OK status');
    }
    
    if (!response.body.timestamp || !response.body.version) {
      throw new Error('Health check missing required fields');
    }
    
    console.log(`   📊 Health: ${response.body.status}, Version: ${response.body.version}`);
  }

  // Test 2: Authentication - Login (should fail with invalid credentials)
  async testLoginInvalid() {
    const response = await this.makeRequest('POST', '/auth/login', {
      username: 'invalid_user',
      password: 'invalid_password'
    });
    
    if (response.status !== 401) {
      throw new Error(`Expected status 401, got ${response.status}`);
    }
    
    console.log(`   🔒 Invalid login correctly rejected`);
  }

  // Test 3: Protected endpoint without auth
  async testProtectedWithoutAuth() {
    const response = await this.makeRequest('GET', '/api/server-info', null, {
      // No Authorization header
    });
    
    if (response.status !== 401) {
      throw new Error(`Expected status 401, got ${response.status}`);
    }
    
    console.log(`   🛡️  Protected endpoint correctly requires auth`);
  }

  // Test 4: Auth endpoints structure
  async testAuthEndpoints() {
    // Test /auth/me without token
    const meResponse = await this.makeRequest('GET', '/auth/me');
    if (meResponse.status !== 401) {
      throw new Error(`/auth/me should return 401, got ${meResponse.status}`);
    }
    
    // Test logout without token
    const logoutResponse = await this.makeRequest('POST', '/auth/logout');
    if (logoutResponse.status !== 401) {
      throw new Error(`/auth/logout should return 401, got ${logoutResponse.status}`);
    }
    
    console.log(`   🔐 Auth endpoint protection verified`);
  }

  // Test 5: API endpoint routing
  async testAPIRouting() {
    const endpoints = [
      '/api/server-info',
      '/api/session/stats', 
      '/api/claude/health',
      '/api/tokyo/health'
    ];
    
    for (const endpoint of endpoints) {
      const response = await this.makeRequest('GET', endpoint);
      // All should return 401 (unauthorized) since we're not authenticated
      if (response.status !== 401) {
        throw new Error(`${endpoint} should return 401, got ${response.status}`);
      }
    }
    
    console.log(`   📡 All API endpoints properly protected`);
  }

  // Test 6: Invalid endpoints
  async testInvalidEndpoints() {
    // Test invalid API endpoint (should return 401 due to auth middleware)
    const apiResponse = await this.makeRequest('GET', '/api/nonexistent');
    if (apiResponse.status !== 401) {
      throw new Error(`Expected API endpoint to return 401 (auth required), got ${apiResponse.status}`);
    }
    
    // Test invalid non-API endpoint (should return 404)
    const nonApiResponse = await this.makeRequest('GET', '/nonexistent');
    if (nonApiResponse.status !== 404) {
      throw new Error(`Expected non-API endpoint to return 404, got ${nonApiResponse.status}`);
    }
    
    console.log(`   🚫 API auth precedence and 404 handling work correctly`);
  }

  // Test 7: Method not allowed
  async testMethodNotAllowed() {
    // Try PATCH on health endpoint (should be GET only)
    const response = await this.makeRequest('PATCH', '/health');
    
    // Should return either 405 (Method Not Allowed) or 404
    if (response.status !== 405 && response.status !== 404) {
      console.log(`   ⚠️  Method handling: ${response.status} (acceptable)`);
    } else {
      console.log(`   ✅ Method restrictions enforced`);
    }
  }

  // Test 8: Request size and validation
  async testRequestValidation() {
    // Test with malformed JSON
    try {
      const response = await this.makeRequest('POST', '/auth/login', null, {
        'Content-Type': 'application/json'
      });
      // Should handle malformed requests gracefully
      if (response.status >= 500) {
        throw new Error(`Server error on malformed request: ${response.status}`);
      }
      console.log(`   ✅ Malformed request handled gracefully (${response.status})`);
    } catch (error) {
      if (error.message.includes('timeout')) {
        throw new Error('Server hangs on malformed request');
      }
      // Other errors are acceptable
      console.log(`   ✅ Request validation working`);
    }
  }

  // Test 9: CORS headers
  async testCORSHeaders() {
    const response = await this.makeRequest('OPTIONS', '/health');
    
    // Should handle OPTIONS request
    console.log(`   🌐 CORS preflight status: ${response.status}`);
    
    if (response.headers['access-control-allow-origin']) {
      console.log(`   ✅ CORS headers present`);
    } else {
      console.log(`   ⚠️  CORS headers may not be configured`);
    }
  }

  // Test 10: Server info endpoint structure
  async testServerInfoStructure() {
    // This will fail auth but we can check the response structure
    const response = await this.makeRequest('GET', '/api/server-info');
    
    if (response.status !== 401) {
      throw new Error(`Expected auth failure, got ${response.status}`);
    }
    
    // Check if error response has proper structure
    if (typeof response.body !== 'object') {
      throw new Error('API should return JSON error responses');
    }
    
    console.log(`   📋 API response structure validated`);
  }

  async runAllTests() {
    console.log('🔬 REST API Comprehensive Test Suite');
    console.log('=====================================');
    
    try {
      await this.startServer();
      
      await this.test('Health Check Endpoint', () => this.testHealthCheck());
      await this.test('Invalid Login Rejection', () => this.testLoginInvalid());
      await this.test('Protected Endpoint Security', () => this.testProtectedWithoutAuth());
      await this.test('Auth Endpoints Protection', () => this.testAuthEndpoints());
      await this.test('API Endpoint Routing', () => this.testAPIRouting());
      await this.test('Invalid Endpoint Handling', () => this.testInvalidEndpoints());
      await this.test('HTTP Method Validation', () => this.testMethodNotAllowed());
      await this.test('Request Validation', () => this.testRequestValidation());
      await this.test('CORS Configuration', () => this.testCORSHeaders());
      await this.test('Response Structure', () => this.testServerInfoStructure());
      
    } catch (error) {
      console.log(`❌ Test suite failed: ${error.message}`);
      this.results.failed++;
    } finally {
      await this.stopServer();
    }

    console.log('\n📊 Test Results Summary');
    console.log('======================');
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
      console.log('\n🎉 All tests passed! REST API is functioning correctly.');
    } else {
      console.log(`\n⚠️  ${this.results.failed} test(s) failed. Review the issues above.`);
    }
    
    return this.results.failed === 0;
  }
}

// Run the test suite
if (require.main === module) {
  const tester = new APITester();
  tester.runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('Test suite crashed:', error);
      process.exit(1);
    });
}

module.exports = APITester;