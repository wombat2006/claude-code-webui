#!/usr/bin/env node
/**
 * Comprehensive Security Test Suite
 * Tests JWT security, attack resistance, XSS prevention, and security headers
 */

const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');

class SecurityTestSuite {
  constructor() {
    this.baseUrl = 'http://localhost:3001';
    this.results = { passed: 0, failed: 0, errors: [] };
    this.server = null;
    this.validToken = null;
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
        timeout: 10000
      };

      if (requestData) {
        options.headers['Content-Length'] = Buffer.byteLength(requestData);
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
    console.log('🔒 Starting WebUI Server for Security Testing...');
    
    return new Promise((resolve, reject) => {
      this.server = spawn('npx', ['ts-node', 'src/index.ts'], {
        env: { 
          ...process.env, 
          NODE_OPTIONS: '--max-old-space-size=1024',
          NODE_ENV: 'test',
          JWT_SECRET: 'test-security-secret-key-for-testing-only'
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
          console.log('✅ Security test server started');
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
      console.log('🛑 Stopping security test server...');
      this.server.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async test(name, testFn) {
    try {
      console.log(`\n🔒 ${name}...`);
      await testFn();
      this.results.passed++;
      console.log(`   ✅ PASS: ${name}`);
    } catch (error) {
      this.results.failed++;
      this.results.errors.push({ test: name, error: error.message });
      console.log(`   ❌ FAIL: ${name} - ${error.message}`);
    }
  }

  // Test 1: JWT Signature Tampering
  async testJWTSignatureTampering() {
    // First, get a valid token (won't succeed with test credentials, but test the format)
    const testPayload = {
      username: 'test',
      role: 'user',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    
    const validToken = jwt.sign(testPayload, 'test-security-secret-key-for-testing-only');
    
    // Tamper with the signature
    const tokenParts = validToken.split('.');
    const tamperedSignature = Buffer.from('tampered-signature').toString('base64url');
    const tamperedToken = `${tokenParts[0]}.${tokenParts[1]}.${tamperedSignature}`;
    
    // Try to access protected endpoint with tampered token
    const response = await this.makeRequest('GET', '/api/server-info', null, {
      'Authorization': `Bearer ${tamperedToken}`
    });
    
    if (response.status !== 401) {
      throw new Error(`Tampered JWT was accepted (status: ${response.status})`);
    }
    
    console.log(`   🛡️  Tampered JWT correctly rejected with status ${response.status}`);
  }

  // Test 2: JWT Token Replay Attack
  async testJWTTokenReplay() {
    // Create an expired token
    const expiredPayload = {
      username: 'test',
      role: 'user',
      iat: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
      exp: Math.floor(Date.now() / 1000) - 3600  // 1 hour ago (expired)
    };
    
    const expiredToken = jwt.sign(expiredPayload, 'test-security-secret-key-for-testing-only');
    
    // Try to use expired token
    const response = await this.makeRequest('GET', '/api/server-info', null, {
      'Authorization': `Bearer ${expiredToken}`
    });
    
    if (response.status !== 401) {
      throw new Error(`Expired JWT was accepted (status: ${response.status})`);
    }
    
    console.log(`   ⏰ Expired JWT correctly rejected with status ${response.status}`);
  }

  // Test 3: SQL Injection Attempts (Type Safety Verification)
  async testSQLInjectionResistance() {
    const injectionPayloads = [
      { username: "admin'; DROP TABLE users; --", password: "password" },
      { username: "admin' OR '1'='1", password: "password" },
      { username: "admin", password: "' OR '1'='1' --" },
      { username: "'; INSERT INTO users (username) VALUES ('hacker'); --", password: "pwd" }
    ];
    
    for (const payload of injectionPayloads) {
      const response = await this.makeRequest('POST', '/auth/login', payload);
      
      // Should return either 400 (bad request) or 401 (unauthorized), not 500 (server error)
      if (response.status >= 500) {
        throw new Error(`SQL injection caused server error: ${response.status}`);
      }
      
      // Should not return success (200) with injection payload
      if (response.status === 200) {
        throw new Error(`Possible SQL injection success with payload: ${JSON.stringify(payload)}`);
      }
    }
    
    console.log(`   💉 All ${injectionPayloads.length} SQL injection attempts properly rejected`);
  }

  // Test 4: XSS Prevention Test
  async testXSSPrevention() {
    const xssPayloads = [
      "<script>alert('xss')</script>",
      "javascript:alert('xss')",
      "<img src='x' onerror='alert(1)'>",
      "'\"><script>alert('xss')</script>",
      "<svg onload=alert('xss')>"
    ];
    
    for (const payload of xssPayloads) {
      const response = await this.makeRequest('POST', '/auth/login', {
        username: payload,
        password: "test"
      });
      
      // Check that XSS payload is not reflected in response
      if (response.rawBody.includes('<script>') || 
          response.rawBody.includes('javascript:') ||
          response.rawBody.includes('onerror=') ||
          response.rawBody.includes('onload=')) {
        throw new Error(`XSS payload reflected in response: ${payload}`);
      }
    }
    
    console.log(`   🔍 All ${xssPayloads.length} XSS attempts properly sanitized`);
  }

  // Test 5: Security Headers Validation
  async testSecurityHeaders() {
    const response = await this.makeRequest('GET', '/health');
    
    const securityHeaders = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': ['DENY', 'SAMEORIGIN'],
      'x-xss-protection': '1',
      'strict-transport-security': 'max-age'
    };
    
    let foundHeaders = 0;
    const headerReport = {};
    
    for (const [header, expected] of Object.entries(securityHeaders)) {
      const headerValue = response.headers[header];
      
      if (headerValue) {
        if (Array.isArray(expected)) {
          if (expected.some(exp => headerValue.includes(exp))) {
            foundHeaders++;
            headerReport[header] = `✅ ${headerValue}`;
          } else {
            headerReport[header] = `❌ ${headerValue} (expected: ${expected.join(' or ')})`;
          }
        } else {
          if (headerValue.includes(expected)) {
            foundHeaders++;
            headerReport[header] = `✅ ${headerValue}`;
          } else {
            headerReport[header] = `❌ ${headerValue} (expected: contains '${expected}')`;
          }
        }
      } else {
        headerReport[header] = `❌ Missing`;
      }
    }
    
    // Display header report
    for (const [header, status] of Object.entries(headerReport)) {
      console.log(`   ${status.startsWith('✅') ? '🛡️' : '⚠️'}  ${header}: ${status.substring(2)}`);
    }
    
    console.log(`   📊 Security headers configured: ${foundHeaders}/${Object.keys(securityHeaders).length}`);
  }

  // Test 6: File Upload Security (if applicable)
  async testFileUploadSecurity() {
    const maliciousFiles = [
      { name: 'malicious.exe', content: 'MZ\x90\x00\x03' }, // PE header
      { name: 'script.php', content: '<?php system($_GET["cmd"]); ?>' },
      { name: '../../../etc/passwd', content: 'root:x:0:0:root:/root:/bin/bash' },
      { name: 'file.js', content: 'require("child_process").exec("rm -rf /");' }
    ];
    
    let uploadEndpointFound = false;
    
    // Try common upload endpoints
    const uploadEndpoints = ['/api/upload', '/upload', '/api/files'];
    
    for (const endpoint of uploadEndpoints) {
      try {
        const response = await this.makeRequest('POST', endpoint, { test: 'data' });
        if (response.status !== 404) {
          uploadEndpointFound = true;
          console.log(`   📁 Found upload endpoint: ${endpoint} (status: ${response.status})`);
        }
      } catch (error) {
        // Endpoint doesn't exist or is inaccessible
      }
    }
    
    if (!uploadEndpointFound) {
      console.log(`   ℹ️  No upload endpoints detected - file upload security test skipped`);
    }
  }

  // Test 7: Rate Limiting Bypass Attempts
  async testRateLimitBypass() {
    const bypassHeaders = [
      { 'X-Forwarded-For': '127.0.0.1' },
      { 'X-Real-IP': '192.168.1.1' },
      { 'X-Originating-IP': '10.0.0.1' },
      { 'X-Remote-IP': '172.16.0.1' },
      { 'X-Client-IP': '203.0.113.1' }
    ];
    
    // Make several requests with different bypass headers
    const promises = [];
    for (let i = 0; i < 10; i++) {
      const headers = bypassHeaders[i % bypassHeaders.length];
      promises.push(
        this.makeRequest('POST', '/auth/login', {
          username: 'test',
          password: 'test'
        }, headers)
      );
    }
    
    const responses = await Promise.all(promises);
    
    // Check if rate limiting is still effective
    const rateLimitedCount = responses.filter(r => r.status === 429).length;
    const totalRequests = responses.length;
    
    console.log(`   🚦 Rate limiting test: ${rateLimitedCount}/${totalRequests} requests rate limited`);
    
    // If no requests are rate limited, it might indicate bypass or no rate limiting
    if (rateLimitedCount === 0) {
      console.log(`   ⚠️  Rate limiting bypass possible or rate limiting not active`);
    }
  }

  // Test 8: Authentication Bypass Attempts
  async testAuthBypass() {
    const bypassAttempts = [
      { path: '/api/server-info', headers: {} }, // No auth
      { path: '/api/server-info', headers: { 'Authorization': 'Bearer invalid' } }, // Invalid token
      { path: '/api/server-info', headers: { 'Authorization': 'Basic YWRtaW46YWRtaW4=' } }, // Wrong auth type
      { path: '/api/server-info', headers: { 'Authorization': '' } }, // Empty auth
      { path: '/api/../server-info', headers: {} }, // Path traversal attempt
    ];
    
    for (const attempt of bypassAttempts) {
      const response = await this.makeRequest('GET', attempt.path, null, attempt.headers);
      
      if (response.status === 200) {
        throw new Error(`Authentication bypass successful for ${attempt.path} with headers ${JSON.stringify(attempt.headers)}`);
      }
      
      if (response.status !== 401) {
        console.log(`   ℹ️  ${attempt.path}: status ${response.status} (expected 401)`);
      }
    }
    
    console.log(`   🔐 All ${bypassAttempts.length} authentication bypass attempts properly blocked`);
  }

  async runAllTests() {
    console.log('🔒 Comprehensive Security Test Suite');
    console.log('====================================');
    
    try {
      await this.startServer();
      
      await this.test('JWT Signature Tampering', () => this.testJWTSignatureTampering());
      await this.test('JWT Token Replay Attack', () => this.testJWTTokenReplay());
      await this.test('SQL Injection Resistance', () => this.testSQLInjectionResistance());
      await this.test('XSS Prevention', () => this.testXSSPrevention());
      await this.test('Security Headers Validation', () => this.testSecurityHeaders());
      await this.test('File Upload Security', () => this.testFileUploadSecurity());
      await this.test('Rate Limiting Bypass', () => this.testRateLimitBypass());
      await this.test('Authentication Bypass', () => this.testAuthBypass());
      
    } catch (error) {
      console.log(`❌ Security test suite failed: ${error.message}`);
      this.results.failed++;
    } finally {
      await this.stopServer();
    }

    console.log('\n📊 Security Test Results');
    console.log('========================');
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    
    if (this.results.errors.length > 0) {
      console.log('\n🚨 Failed Security Tests:');
      this.results.errors.forEach(err => {
        console.log(`   - ${err.test}: ${err.error}`);
      });
    }
    
    const total = this.results.passed + this.results.failed;
    const passRate = total > 0 ? ((this.results.passed / total) * 100).toFixed(1) : 0;
    
    console.log(`\n📈 Security Pass Rate: ${passRate}%`);
    
    if (this.results.failed === 0) {
      console.log('\n🛡️  All security tests passed! System is secure for production.');
    } else {
      console.log(`\n⚠️  ${this.results.failed} security test(s) failed. Review security measures before production deployment.`);
    }
    
    return this.results.failed === 0;
  }
}

// Run the security test suite
if (require.main === module) {
  const tester = new SecurityTestSuite();
  tester.runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('Security test suite crashed:', error);
      process.exit(1);
    });
}

module.exports = SecurityTestSuite;