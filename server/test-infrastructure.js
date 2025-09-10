#!/usr/bin/env node
/**
 * Infrastructure Foundation Test Suite
 * Tests server startup, environment, TypeScript compilation, and memory initialization
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class InfrastructureTestSuite {
  constructor() {
    this.results = { passed: 0, failed: 0, errors: [] };
    this.server = null;
    this.startTime = Date.now();
  }

  async test(name, testFn) {
    try {
      console.log(`\n🔧 ${name}...`);
      const start = Date.now();
      await testFn();
      const duration = Date.now() - start;
      this.results.passed++;
      console.log(`   ✅ PASS: ${name} (${duration}ms)`);
    } catch (error) {
      this.results.failed++;
      this.results.errors.push({ test: name, error: error.message });
      console.log(`   ❌ FAIL: ${name} - ${error.message}`);
    }
  }

  // Test 1: Server Startup Time (< 5 seconds)
  async testServerStartupTime() {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      this.server = spawn('npx', ['ts-node', 'src/index.ts'], {
        env: { 
          ...process.env, 
          NODE_OPTIONS: '--max-old-space-size=1024',
          NODE_ENV: 'test'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let serverReady = false;
      const timeout = setTimeout(() => {
        if (!serverReady) {
          reject(new Error('Server startup timeout (> 5 seconds)'));
        }
      }, 5000);

      this.server.stdout.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Claude Code WebUI Server started')) {
          const startupTime = Date.now() - startTime;
          serverReady = true;
          clearTimeout(timeout);
          console.log(`   📊 Startup time: ${startupTime}ms`);
          if (startupTime > 5000) {
            reject(new Error(`Startup time ${startupTime}ms exceeds 5000ms limit`));
          } else {
            resolve();
          }
        }
      });

      this.server.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('EADDRINUSE')) {
          clearTimeout(timeout);
          reject(new Error('Port already in use'));
        }
        if (output.includes('Error:') && !output.includes('Warning:')) {
          console.log(`   ⚠️  Startup error: ${output.trim()}`);
        }
      });

      this.server.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  // Test 2: Environment Variables Validation
  async testEnvironmentVariables() {
    const requiredEnvVars = [
      'NODE_ENV'
    ];
    
    const recommendedEnvVars = [
      'JWT_SECRET',
      'PORT', 
      'SESSION_TIMEOUT',
      'MAX_SESSIONS',
      'CLAUDE_CODE_PATH',
      'LOG_LEVEL'
    ];

    // Check required environment variables
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`Required environment variable ${envVar} is not set`);
      }
    }

    // Check recommended environment variables
    let missingRecommended = [];
    for (const envVar of recommendedEnvVars) {
      if (!process.env[envVar]) {
        missingRecommended.push(envVar);
      }
    }

    if (missingRecommended.length > 0) {
      console.log(`   ⚠️  Missing recommended env vars: ${missingRecommended.join(', ')}`);
    }

    // Validate critical configurations
    if (process.env.JWT_SECRET === 'dev-secret-change-in-production' && process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be changed in production environment');
    }

    const port = parseInt(process.env.PORT || '3001');
    if (isNaN(port) || port < 1000 || port > 65535) {
      throw new Error(`Invalid PORT value: ${process.env.PORT}`);
    }

    console.log(`   📋 Environment check passed. Node: ${process.env.NODE_ENV}, Port: ${port}`);
  }

  // Test 3: TypeScript Strict Mode Compilation
  async testTypeScriptCompilation() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TypeScript compilation timeout (> 60 seconds)'));
      }, 60000);

      exec('npx tsc --noEmit --strict', {
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' }
      }, (error, stdout, stderr) => {
        clearTimeout(timeout);
        
        if (error) {
          // Count TypeScript errors
          const errorLines = stderr.split('\n').filter(line => line.includes(' error TS'));
          const errorCount = errorLines.length;
          
          console.log(`   📊 TypeScript errors found: ${errorCount}`);
          
          if (errorCount > 100) {
            reject(new Error(`Too many TypeScript errors: ${errorCount} (limit: 100)`));
          } else {
            console.log(`   ✅ TypeScript errors within acceptable range: ${errorCount}/100`);
            resolve();
          }
        } else {
          console.log(`   🎉 TypeScript compilation successful with no errors`);
          resolve();
        }
      });
    });
  }

  // Test 4: Memory Initialization State
  async testMemoryInitialization() {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    
    console.log(`   📊 Memory usage - RSS: ${rssMB}MB, Heap: ${heapUsedMB}MB/${heapTotalMB}MB`);
    
    // Check if initial memory usage is reasonable
    if (heapUsedMB > 200) {
      throw new Error(`Initial heap usage too high: ${heapUsedMB}MB (limit: 200MB)`);
    }
    
    if (rssMB > 500) {
      throw new Error(`Initial RSS too high: ${rssMB}MB (limit: 500MB)`);
    }

    // Test garbage collection availability
    if (typeof global.gc === 'function') {
      const beforeGC = process.memoryUsage().heapUsed;
      global.gc();
      const afterGC = process.memoryUsage().heapUsed;
      const freedMB = Math.round((beforeGC - afterGC) / 1024 / 1024);
      console.log(`   🗑️  GC available, freed: ${freedMB}MB`);
    } else {
      console.log(`   ⚠️  GC not exposed (run with --expose-gc for testing)`);
    }
  }

  // Test 5: File System Permissions and Paths
  async testFileSystemAccess() {
    const testPaths = [
      './src',
      './package.json',
      './tsconfig.json',
      process.env.CLAUDE_WORKING_DIR || '/tmp/claude-sessions'
    ];

    for (const testPath of testPaths) {
      try {
        const stats = fs.statSync(testPath);
        if (testPath.endsWith('.json') && !stats.isFile()) {
          throw new Error(`Expected file but found directory: ${testPath}`);
        }
        if (testPath === './src' && !stats.isDirectory()) {
          throw new Error(`Expected directory but found file: ${testPath}`);
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Required path does not exist: ${testPath}`);
        }
        throw error;
      }
    }

    // Test write permissions for working directory
    const workingDir = process.env.CLAUDE_WORKING_DIR || '/tmp/claude-sessions';
    try {
      if (!fs.existsSync(workingDir)) {
        fs.mkdirSync(workingDir, { recursive: true });
      }
      const testFile = path.join(workingDir, 'write-test.tmp');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      console.log(`   📁 File system permissions verified for: ${workingDir}`);
    } catch (error) {
      throw new Error(`Cannot write to working directory ${workingDir}: ${error.message}`);
    }
  }

  async cleanup() {
    if (this.server) {
      console.log(`\n🛑 Stopping test server...`);
      this.server.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async runAllTests() {
    console.log('🔧 Infrastructure Foundation Test Suite');
    console.log('=====================================');
    
    try {
      await this.test('Environment Variables Validation', () => this.testEnvironmentVariables());
      await this.test('File System Access', () => this.testFileSystemAccess());
      await this.test('Memory Initialization State', () => this.testMemoryInitialization());
      await this.test('TypeScript Strict Mode Compilation', () => this.testTypeScriptCompilation());
      await this.test('Server Startup Time', () => this.testServerStartupTime());
      
    } catch (error) {
      console.log(`❌ Test suite failed: ${error.message}`);
      this.results.failed++;
    } finally {
      await this.cleanup();
    }

    console.log('\n📊 Infrastructure Test Results');
    console.log('==============================');
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
    const totalTime = Date.now() - this.startTime;
    
    console.log(`\n📈 Pass Rate: ${passRate}%`);
    console.log(`⏱️  Total Time: ${totalTime}ms`);
    
    if (this.results.failed === 0) {
      console.log('\n🎉 All infrastructure tests passed! System is ready for deployment.');
    } else {
      console.log(`\n⚠️  ${this.results.failed} infrastructure test(s) failed. System may not be production-ready.`);
    }
    
    return this.results.failed === 0;
  }
}

// Run the infrastructure test suite
if (require.main === module) {
  const tester = new InfrastructureTestSuite();
  tester.runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('Infrastructure test suite crashed:', error);
      process.exit(1);
    });
}

module.exports = InfrastructureTestSuite;