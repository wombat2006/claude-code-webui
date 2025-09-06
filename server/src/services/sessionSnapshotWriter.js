/**
 * Session Snapshot Writer
 * Captures development session events and creates structured snapshots
 * for S3 persistence. Implements the Session-Aware Development Assistant model.
 */

const path = require('path');
const { execSync } = require('child_process');
const S3SnapshotUploader = require('./s3SnapshotUploader');

class SessionSnapshotWriter {
  constructor(stateSync, options = {}) {
    this.stateSync = stateSync;
    this.projectRoot = options.projectRoot || process.cwd();
    this.debounceDelay = options.debounceDelay || 3000; // 3s debounce for file saves
    this.maxOutputSize = options.maxOutputSize || 1024 * 1024; // 1MB limit
    this.pendingSnapshots = new Map();
    this.debounceTimers = new Map();
    
    // Initialize S3 uploader (optional - falls back to local if no AWS credentials)
    this.s3Uploader = null;
    this.enableS3Upload = options.enableS3Upload !== false; // Default: true
    
    if (this.enableS3Upload) {
      try {
        this.s3Uploader = new S3SnapshotUploader({
          region: options.s3Region,
          bucket: options.s3Bucket,
          keyPrefix: options.s3KeyPrefix
        });
      } catch (error) {
        this.log('S3 uploader initialization failed, falling back to local storage', { error: error.message });
      }
    }
    
    this.log = (message, data = {}) => {
      console.log(`[SnapshotWriter ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    this.initializeEventListeners();
  }

  initializeEventListeners() {
    // Listen to state changes for snapshot creation
    this.stateSync.onEvent('state_saved', (eventData) => {
      this.handleStateEvent('state_saved', eventData);
    });

    this.stateSync.onEvent('state_updated', (eventData) => {
      this.handleStateEvent('state_updated', eventData);
    });

    this.log('Event listeners initialized');
  }

  /**
   * Handle state events and determine if snapshot should be created
   */
  async handleStateEvent(eventType, eventData) {
    try {
      const { sessionId, stateData } = eventData;
      
      // Check if this is a trigger event for snapshot creation
      if (this.shouldCreateSnapshot(stateData)) {
        const triggerEvent = this.determineTriggerEvent(stateData);
        await this.createSessionSnapshot(sessionId, stateData, triggerEvent);
      }
    } catch (error) {
      this.log('Error handling state event', { 
        eventType, 
        sessionId: eventData.sessionId, 
        error: error.message 
      });
    }
  }

  /**
   * Determine if a snapshot should be created based on state data
   */
  shouldCreateSnapshot(stateData) {
    const data = stateData.data || {};
    
    // Create snapshots for:
    // 1. Command executions
    // 2. File changes (debounced)
    // 3. Dependency changes
    return !!(
      data.lastCommand ||
      data.fileChanges ||
      data.dependencyChange ||
      data.errorOccurred
    );
  }

  /**
   * Determine the trigger event type
   */
  determineTriggerEvent(stateData) {
    const data = stateData.data || {};
    
    if (data.lastCommand) return 'command_execution';
    if (data.fileChanges) return 'file_save';
    if (data.dependencyChange) return 'dependency_change';
    if (data.errorOccurred) return 'error_event';
    
    return 'state_update';
  }

  /**
   * Create a structured session snapshot
   */
  async createSessionSnapshot(sessionId, stateData, triggerEvent) {
    try {
      const timestamp = new Date().toISOString();
      const data = stateData.data || {};

      // Build snapshot according to Session Snapshot schema
      const snapshot = {
        sessionId,
        projectId: this.getProjectId(),
        timestamp,
        triggerEvent,
        source: `claude-code-webui-${stateData.nodeId}`,
        context: {
          fileSystem: await this.captureFileSystemContext(data),
          execution: this.captureExecutionContext(data),
          dependencies: this.captureDependencyContext(data)
        },
        cipherMemory: this.captureCipherMemory(data),
        metadata: {
          version: stateData.version,
          region: stateData.region,
          nodeId: stateData.nodeId,
          dataSize: JSON.stringify(stateData.data).length
        }
      };

      // Log snapshot creation (without full data to avoid log spam)
      this.log('Snapshot created', {
        sessionId,
        triggerEvent,
        contextSizeMB: Math.round(JSON.stringify(snapshot).length / 1024 / 1024 * 100) / 100
      });

      // Persist snapshot (local + S3)
      await this.persistSnapshot(snapshot);

      return snapshot;
    } catch (error) {
      this.log('Failed to create snapshot', { 
        sessionId, 
        triggerEvent, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Capture file system context with change tracking
   */
  async captureFileSystemContext(data) {
    const context = {
      tree: null,
      lastChangedFile: null,
      changePatch: null
    };

    try {
      // Get basic file tree (lightweight)
      const tree = this.getFileTree();
      context.tree = this.truncateIfNeeded(tree, 50000); // 50KB limit

      // Capture file changes if available
      if (data.fileChanges) {
        context.lastChangedFile = data.fileChanges.filename;
        context.changePatch = await this.generateDiffPatch(data.fileChanges);
      }
    } catch (error) {
      this.log('Error capturing filesystem context', { error: error.message });
    }

    return context;
  }

  /**
   * Capture command execution context
   */
  captureExecutionContext(data) {
    if (!data.lastCommand) return null;

    const cmd = data.lastCommand;
    return {
      command: cmd.command || '',
      stdout: this.truncateIfNeeded(cmd.stdout || '', this.maxOutputSize),
      stderr: this.truncateIfNeeded(cmd.stderr || '', this.maxOutputSize),
      exitCode: cmd.exitCode || 0,
      workingDirectory: cmd.cwd || this.projectRoot,
      duration: cmd.duration || 0
    };
  }

  /**
   * Capture dependency context
   */
  captureDependencyContext(data) {
    const context = {};

    try {
      // Check for package.json changes
      const packageJsonPath = path.join(this.projectRoot, 'package.json');
      if (require('fs').existsSync(packageJsonPath)) {
        const packageJson = require(packageJsonPath);
        context.dependencies = packageJson.dependencies || {};
        context.devDependencies = packageJson.devDependencies || {};
      }

      // Add other dependency files as needed (requirements.txt, etc.)
    } catch (error) {
      this.log('Error capturing dependency context', { error: error.message });
    }

    return Object.keys(context).length > 0 ? context : null;
  }

  /**
   * Capture Cipher memory context
   */
  captureCipherMemory(data) {
    // Extract relevant Cipher state for continuity
    return {
      userGoal: data.userGoal || null,
      currentTask: data.currentTask || null,
      recentContext: data.recentContext || null
    };
  }

  /**
   * Get project identifier
   */
  getProjectId() {
    try {
      const packageJsonPath = path.join(this.projectRoot, 'package.json');
      if (require('fs').existsSync(packageJsonPath)) {
        const packageJson = require(packageJsonPath);
        return packageJson.name || path.basename(this.projectRoot);
      }
    } catch (error) {
      // Fallback to directory name
    }
    return path.basename(this.projectRoot);
  }

  /**
   * Generate lightweight file tree
   */
  getFileTree() {
    try {
      // Use find command to get basic file structure (exclude node_modules, .git)
      const output = execSync(
        'find . -type f -not -path "./node_modules/*" -not -path "./.git/*" | head -1000',
        { 
          cwd: this.projectRoot,
          encoding: 'utf8',
          timeout: 5000
        }
      );
      
      return output.trim().split('\n').slice(0, 200); // Limit to 200 files
    } catch (error) {
      this.log('Error generating file tree', { error: error.message });
      return [];
    }
  }

  /**
   * Generate diff patch for file changes
   */
  async generateDiffPatch(fileChange) {
    try {
      if (fileChange.oldContent && fileChange.newContent) {
        // Simple diff - in production, use proper diff library
        const lines1 = fileChange.oldContent.split('\n');
        const lines2 = fileChange.newContent.split('\n');
        
        return `--- ${fileChange.filename}\n+++ ${fileChange.filename}\n` +
               `@@ Changes in ${fileChange.filename} @@\n` +
               `- Lines: ${lines1.length}\n` +
               `+ Lines: ${lines2.length}`;
      }
    } catch (error) {
      this.log('Error generating diff patch', { error: error.message });
    }
    return null;
  }

  /**
   * Truncate content if it exceeds size limit
   */
  truncateIfNeeded(content, maxSize) {
    if (typeof content === 'string' && content.length > maxSize) {
      return content.substring(0, maxSize) + '\n... [truncated]';
    }
    if (Array.isArray(content) && JSON.stringify(content).length > maxSize) {
      return content.slice(0, Math.floor(content.length / 2));
    }
    return content;
  }

  /**
   * Persist snapshot locally and optionally to S3
   */
  async persistSnapshot(snapshot) {
    try {
      const results = {
        local: null,
        s3: null
      };

      // Always persist locally as backup
      results.local = await this.persistSnapshotLocally(snapshot);

      // Upload to S3 if available (async, non-blocking)
      if (this.s3Uploader) {
        this.uploadToS3Async(snapshot).catch(error => {
          this.log('S3 upload failed (non-blocking)', { 
            sessionId: snapshot.sessionId,
            error: error.message 
          });
        });
      }

      return results;
    } catch (error) {
      this.log('Failed to persist snapshot', { error: error.message });
      throw error;
    }
  }

  /**
   * Persist snapshot locally (backup storage)
   */
  async persistSnapshotLocally(snapshot) {
    try {
      const snapshotDir = '/tmp/claude-snapshots';
      await require('fs').promises.mkdir(snapshotDir, { recursive: true });
      
      const filename = `${snapshot.sessionId}_${Date.now()}.json`;
      const filepath = path.join(snapshotDir, filename);
      
      await require('fs').promises.writeFile(
        filepath, 
        JSON.stringify(snapshot, null, 2)
      );

      this.log('Snapshot persisted locally', { 
        filepath,
        sizeMB: Math.round(JSON.stringify(snapshot).length / 1024 / 1024 * 100) / 100
      });

      return { filepath, success: true };
    } catch (error) {
      this.log('Failed to persist snapshot locally', { error: error.message });
      throw error;
    }
  }

  /**
   * Async S3 upload (non-blocking)
   */
  async uploadToS3Async(snapshot) {
    try {
      if (!this.s3Uploader) {
        throw new Error('S3 uploader not available');
      }

      // Test S3 connection first (cached for 5 minutes)
      if (!this.s3ConnectionTested || Date.now() - this.s3ConnectionTested > 300000) {
        const connectionTest = await this.s3Uploader.testConnection();
        if (!connectionTest.connected) {
          throw new Error(`S3 connection failed: ${connectionTest.error}`);
        }
        this.s3ConnectionTested = Date.now();
      }

      const uploadResult = await this.s3Uploader.uploadSnapshot(snapshot);
      
      this.log('Snapshot uploaded to S3', {
        sessionId: snapshot.sessionId,
        s3Key: uploadResult.key,
        etag: uploadResult.etag,
        duration: uploadResult.uploadDuration
      });

      return uploadResult;
    } catch (error) {
      this.log('S3 upload error', { 
        sessionId: snapshot.sessionId,
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Register command execution for snapshot creation
   */
  registerCommandExecution(sessionId, command, result) {
    const commandData = {
      command: command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      cwd: result.cwd || this.projectRoot,
      duration: result.duration,
      timestamp: Date.now()
    };

    // Update state to trigger snapshot
    this.stateSync.updateState(sessionId, {
      lastCommand: commandData,
      errorOccurred: result.exitCode !== 0
    }).catch(error => {
      this.log('Failed to register command execution', { error: error.message });
    });
  }

  /**
   * Register file change for snapshot creation (with debouncing)
   */
  registerFileChange(sessionId, filename, oldContent, newContent) {
    const changeKey = `${sessionId}:${filename}`;
    
    // Clear existing timer
    if (this.debounceTimers.has(changeKey)) {
      clearTimeout(this.debounceTimers.get(changeKey));
    }
    
    // Set new timer
    const timer = setTimeout(async () => {
      const fileChangeData = {
        filename,
        oldContent: this.truncateIfNeeded(oldContent, 10000), // 10KB limit
        newContent: this.truncateIfNeeded(newContent, 10000),
        timestamp: Date.now()
      };

      try {
        await this.stateSync.updateState(sessionId, {
          fileChanges: fileChangeData
        });
      } catch (error) {
        this.log('Failed to register file change', { error: error.message });
      } finally {
        this.debounceTimers.delete(changeKey);
      }
    }, this.debounceDelay);

    this.debounceTimers.set(changeKey, timer);
  }
}

module.exports = SessionSnapshotWriter;