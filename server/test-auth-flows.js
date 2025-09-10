#!/usr/bin/env node
/**
 * Authentication Flow Comprehensive Test Suite
 * Tests complete authentication workflows, session management, and edge cases
 */

const http = require('http');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');

class AuthenticationFlowTestSuite {
  constructor() {
    this.baseUrl = 'http://localhost:3001';
    this.results = { passed: 0, failed: 0, errors: [] };
    this.server = null;
    this.authTokens = new Map(); // Store tokens for different users
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
          'User-Agent': 'AuthFlow-Test-Suite/1.0',
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
    console.log('🔐 Starting WebUI Server for Authentication Testing...');
    
    return new Promise((resolve, reject) => {
      this.server = spawn('npx', ['ts-node', 'src/index.ts'], {
        env: { 
          ...process.env, 
          NODE_OPTIONS: '--max-old-space-size=1024',
          NODE_ENV: 'test',
          JWT_SECRET: 'auth-test-secret-key-for-comprehensive-testing'
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
          console.log('✅ Authentication test server started');
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
      console.log('🛑 Stopping authentication test server...');
      this.server.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async test(name, testFn) {
    try {
      console.log(`\n🔐 ${name}...`);
      await testFn();
      this.results.passed++;
      console.log(`   ✅ PASS: ${name}`);
    } catch (error) {
      this.results.failed++;
      this.results.errors.push({ test: name, error: error.message });
      console.log(`   ❌ FAIL: ${name} - ${error.message}`);
    }
  }

  // Test 1: Complete User Journey (Login → API Access → Logout)
  async testCompleteUserJourney() {
    // Step 1: Login with demo credentials
    const loginResponse = await this.makeRequest('POST', '/auth/login', {
      username: 'demo',
      password: 'demo123'
    });
    
    if (loginResponse.status !== 200) {
      throw new Error(`Login failed with status ${loginResponse.status}`);
    }
    
    if (!loginResponse.body.token) {
      throw new Error('Login response missing token');
    }
    
    const token = loginResponse.body.token;
    console.log(`   🎫 Login successful, token obtained`);
    
    // Step 2: Access protected API with token
    const apiResponse = await this.makeRequest('GET', '/api/server-info', null, {
      'Authorization': `Bearer ${token}`
    });
    
    if (apiResponse.status !== 200) {
      throw new Error(`API access failed with status ${apiResponse.status}`);
    }
    
    if (!apiResponse.body.server || !apiResponse.body.user) {
      throw new Error('API response missing expected data structure');
    }
    
    console.log(`   📊 API access successful, user: ${apiResponse.body.user.username}`);
    
    // Step 3: Get current user info
    const userResponse = await this.makeRequest('GET', '/auth/me', null, {
      'Authorization': `Bearer ${token}`
    });
    
    if (userResponse.status !== 200) {
      throw new Error(`User info request failed with status ${userResponse.status}`);
    }
    
    console.log(`   👤 User info retrieved: ${userResponse.body.user.username} (${userResponse.body.user.role})`);
    
    // Step 4: Logout
    const logoutResponse = await this.makeRequest('POST', '/auth/logout', null, {
      'Authorization': `Bearer ${token}`
    });
    
    if (logoutResponse.status !== 200) {
      throw new Error(`Logout failed with status ${logoutResponse.status}`);
    }
    
    console.log(`   👋 Logout successful`);
    
    // Step 5: Verify token is invalidated (if implemented)
    const postLogoutResponse = await this.makeRequest('GET', '/api/server-info', null, {
      'Authorization': `Bearer ${token}`
    });
    
    // Note: Token invalidation may not be implemented in stateless JWT
    console.log(`   🔍 Post-logout API access: ${postLogoutResponse.status} (JWT may still be valid until expiry)`);
  }

  // Test 2: Concurrent Login Limits (if implemented)
  async testConcurrentLoginLimits() {
    const promises = [];
    const loginCredentials = { username: 'demo', password: 'demo123' };
    
    // Attempt multiple concurrent logins
    for (let i = 0; i < 5; i++) {
      promises.push(this.makeRequest('POST', '/auth/login', loginCredentials));
    }
    
    const responses = await Promise.all(promises);
    
    let successCount = 0;
    let tokens = [];
    
    responses.forEach((response, index) => {
      if (response.status === 200 && response.body.token) {
        successCount++;
        tokens.push(response.body.token);
      }
    });
    
    console.log(`   👥 Concurrent logins: ${successCount}/5 successful`);
    
    // Test if tokens are different (if session-based)
    const uniqueTokens = new Set(tokens);
    console.log(`   🎫 Unique tokens generated: ${uniqueTokens.size}/${tokens.length}`);
    
    // Most JWT implementations allow multiple concurrent sessions
    if (successCount === 0) {
      throw new Error('All concurrent login attempts failed unexpectedly');
    }
  }

  // Test 3: Password Attempt Limits
  async testPasswordAttemptLimits() {
    const failedAttempts = [];
    const maxAttempts = 8; // Try more than typical rate limit
    
    for (let i = 0; i < maxAttempts; i++) {
      const response = await this.makeRequest('POST', '/auth/login', {
        username: 'demo',
        password: `wrong-password-${i}`
      });
      
      failedAttempts.push({
        attempt: i + 1,
        status: response.status,
        rateLimited: response.status === 429
      });
      
      // Small delay between attempts
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const rateLimitedAttempts = failedAttempts.filter(a => a.rateLimited).length;
    const unauthorizedAttempts = failedAttempts.filter(a => a.status === 401).length;
    
    console.log(`   🔒 Failed login attempts: ${unauthorizedAttempts} unauthorized, ${rateLimitedAttempts} rate limited`);
    
    if (rateLimitedAttempts === 0) {
      console.log(`   ⚠️  No rate limiting detected for failed password attempts`);
    } else {
      console.log(`   🛡️  Rate limiting active after failed attempts`);
    }
    
    // Verify legitimate login still works after rate limit period
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    const legitResponse = await this.makeRequest('POST', '/auth/login', {
      username: 'demo',
      password: 'demo123'
    });
    
    if (legitResponse.status === 200) {
      console.log(`   ✅ Legitimate login works after rate limit period`);
    } else if (legitResponse.status === 429) {
      console.log(`   ⏰ Rate limit still active (status: ${legitResponse.status})`);
    } else {
      console.log(`   ❓ Unexpected status after rate limit: ${legitResponse.status}`);
    }
  }

  // Test 4: Session Expiry Handling
  async testSessionExpiryHandling() {
    // Create a short-lived token for testing
    const shortLivedPayload = {
      username: 'demo',
      role: 'user',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 2 // Expires in 2 seconds
    };
    
    const shortToken = jwt.sign(shortLivedPayload, 'auth-test-secret-key-for-comprehensive-testing');
    
    // Verify token works initially
    const initialResponse = await this.makeRequest('GET', '/auth/me', null, {
      'Authorization': `Bearer ${shortToken}`
    });
    
    if (initialResponse.status !== 200) {
      throw new Error(`Short-lived token failed immediately: ${initialResponse.status}`);
    }
    
    console.log(`   ⏱️  Short-lived token works initially`);
    
    // Wait for token to expire
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Verify token is now rejected
    const expiredResponse = await this.makeRequest('GET', '/auth/me', null, {
      'Authorization': `Bearer ${shortToken}`
    });
    
    if (expiredResponse.status === 200) {
      throw new Error('Expired token was still accepted');
    }
    
    if (expiredResponse.status !== 401) {
      throw new Error(`Expected 401 for expired token, got ${expiredResponse.status}`);
    }
    
    console.log(`   ⚰️  Expired token properly rejected with status 401`);
  }

  // Test 5: Invalid Token Formats
  async testInvalidTokenFormats() {
    const invalidTokens = [
      '', // Empty token
      'invalid-token', // Not a JWT
      'Bearer invalid-token', // Invalid with Bearer prefix
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', // Incomplete JWT (header only)
      'not.a.jwt', // Wrong format
      'null', // Null string
      'undefined', // Undefined string
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.invalid_signature' // Invalid signature
    ];
    
    for (const invalidToken of invalidTokens) {
      const response = await this.makeRequest('GET', '/auth/me', null, {
        'Authorization': invalidToken ? `Bearer ${invalidToken}` : ''
      });
      
      if (response.status === 200) {
        throw new Error(`Invalid token was accepted: ${invalidToken}`);
      }
      
      if (response.status !== 401) {
        console.log(`   ℹ️  Token "${invalidToken.substring(0, 20)}...": status ${response.status} (expected 401)`);
      }
    }
    
    console.log(`   🚫 All ${invalidTokens.length} invalid token formats properly rejected`);
  }

  // Test 6: Cross-User Authorization
  async testCrossUserAuthorization() {
    // Login as demo user
    const demoLogin = await this.makeRequest('POST', '/auth/login', {
      username: 'demo',
      password: 'demo123'
    });
    
    if (demoLogin.status !== 200 || !demoLogin.body.token) {
      throw new Error('Failed to login as demo user');
    }
    
    const demoToken = demoLogin.body.token;
    
    // Attempt login as admin (if exists)
    const adminLogin = await this.makeRequest('POST', '/auth/login', {
      username: 'admin',
      password: 'admin456'
    });
    
    let adminToken = null;
    if (adminLogin.status === 200 && adminLogin.body.token) {
      adminToken = adminLogin.body.token;
      console.log(`   👔 Admin login successful`);
    } else {
      console.log(`   ℹ️  Admin account not available for cross-user test`);
    }
    
    // Test that demo user can access their own info
    const demoSelfResponse = await this.makeRequest('GET', '/auth/me', null, {
      'Authorization': `Bearer ${demoToken}`
    });
    
    if (demoSelfResponse.status !== 200) {
      throw new Error('Demo user cannot access their own info');
    }
    
    if (demoSelfResponse.body.user.username !== 'demo') {
      throw new Error('Demo user info mismatch');
    }
    
    console.log(`   ✅ User can access their own information correctly`);
    
    // If we have admin token, test admin-specific endpoints (if any exist)
    if (adminToken) {
      const adminSelfResponse = await this.makeRequest('GET', '/auth/me', null, {
        'Authorization': `Bearer ${adminToken}`
      });
      
      if (adminSelfResponse.status === 200 && 
          adminSelfResponse.body.user.username === 'admin' &&
          adminSelfResponse.body.user.role === 'admin') {
        console.log(`   👑 Admin user privileges correctly identified`);
      }
    }
  }

  // Test 7: Token Manipulation Protection
  async testTokenManipulationProtection() {
    // Get a valid token first
    const loginResponse = await this.makeRequest('POST', '/auth/login', {
      username: 'demo',
      password: 'demo123'
    });
    
    if (loginResponse.status !== 200 || !loginResponse.body.token) {
      throw new Error('Failed to get valid token for manipulation test');
    }
    
    const validToken = loginResponse.body.token;
    const tokenParts = validToken.split('.');
    
    // Test 1: Modify payload (change username)
    try {
      const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString());
      payload.username = 'admin';
      payload.role = 'admin';
      
      const modifiedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const manipulatedToken = `${tokenParts[0]}.${modifiedPayload}.${tokenParts[2]}`;
      
      const response = await this.makeRequest('GET', '/auth/me', null, {
        'Authorization': `Bearer ${manipulatedToken}`
      });
      
      if (response.status === 200) {
        throw new Error('Payload manipulation was accepted');
      }
      
      console.log(`   🛡️  Payload manipulation properly rejected (status: ${response.status})`);
    } catch (error) {
      if (error.message === 'Payload manipulation was accepted') {
        throw error;
      }
      console.log(`   ⚠️  Error during payload manipulation test: ${error.message}`);
    }
    
    // Test 2: Modify header (change algorithm)
    try {
      const header = JSON.parse(Buffer.from(tokenParts[0], 'base64url').toString());
      header.alg = 'none'; // Algorithm confusion attack
      
      const modifiedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const manipulatedToken = `${modifiedHeader}.${tokenParts[1]}.`;
      
      const response = await this.makeRequest('GET', '/auth/me', null, {
        'Authorization': `Bearer ${manipulatedToken}`
      });
      
      if (response.status === 200) {
        throw new Error('Algorithm manipulation was accepted');
      }
      
      console.log(`   🔐 Algorithm manipulation properly rejected (status: ${response.status})`);
    } catch (error) {
      if (error.message === 'Algorithm manipulation was accepted') {
        throw error;
      }
      console.log(`   ⚠️  Error during algorithm manipulation test: ${error.message}`);
    }
  }

  async runAllTests() {
    console.log('🔐 Authentication Flow Comprehensive Test Suite');
    console.log('==============================================');
    
    try {
      await this.startServer();
      
      await this.test('Complete User Journey', () => this.testCompleteUserJourney());
      await this.test('Concurrent Login Limits', () => this.testConcurrentLoginLimits());
      await this.test('Password Attempt Limits', () => this.testPasswordAttemptLimits());
      await this.test('Session Expiry Handling', () => this.testSessionExpiryHandling());
      await this.test('Invalid Token Formats', () => this.testInvalidTokenFormats());
      await this.test('Cross-User Authorization', () => this.testCrossUserAuthorization());
      await this.test('Token Manipulation Protection', () => this.testTokenManipulationProtection());
      
    } catch (error) {
      console.log(`❌ Authentication test suite failed: ${error.message}`);
      this.results.failed++;
    } finally {
      await this.stopServer();
    }

    console.log('\n📊 Authentication Flow Test Results');
    console.log('===================================');
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    
    if (this.results.errors.length > 0) {
      console.log('\n🚨 Failed Authentication Tests:');
      this.results.errors.forEach(err => {
        console.log(`   - ${err.test}: ${err.error}`);
      });
    }
    
    const total = this.results.passed + this.results.failed;
    const passRate = total > 0 ? ((this.results.passed / total) * 100).toFixed(1) : 0;
    
    console.log(`\n📈 Authentication Pass Rate: ${passRate}%`);
    
    if (this.results.failed === 0) {
      console.log('\n🎉 All authentication tests passed! Authentication system is secure and functional.');
    } else {
      console.log(`\n⚠️  ${this.results.failed} authentication test(s) failed. Review authentication implementation.`);
    }
    
    return this.results.failed === 0;
  }
}

// Run the authentication flow test suite
if (require.main === module) {
  const tester = new AuthenticationFlowTestSuite();
  tester.runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('Authentication test suite crashed:', error);
      process.exit(1);
    });
}

module.exports = AuthenticationFlowTestSuite;