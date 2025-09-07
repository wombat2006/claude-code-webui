#!/usr/bin/env node

/**
 * OpenAI Cookbook Collection and S3 Storage Service
 * Downloads and processes OpenAI Cookbook for future reference
 */

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

class CookbookCollector {
  constructor() {
    this.s3Client = new S3Client({
      region: 'us-east-1'
    });
    this.bucketName = 'claude-code-snapshots-dev';
    this.cookbookPrefix = 'openai-cookbook/';
    this.localCookbookPath = './temp-cookbook';
    
    this.log = (message, data = {}) => {
      console.log(`[CookbookCollector ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };
  }

  /**
   * Collect all files from cookbook directory
   */
  async collectCookbookFiles() {
    if (!fs.existsSync(this.localCookbookPath)) {
      throw new Error('Cookbook directory not found. Please run git clone first.');
    }

    const files = [];
    this.walkDirectory(this.localCookbookPath, files);
    
    this.log('Cookbook files collected', {
      totalFiles: files.length,
      sampleFiles: files.slice(0, 5).map(f => path.relative(this.localCookbookPath, f))
    });

    return files;
  }

  /**
   * Recursively walk directory
   */
  walkDirectory(dirPath, files) {
    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Skip git and node_modules directories
        if (!item.startsWith('.') && item !== 'node_modules') {
          this.walkDirectory(fullPath, files);
        }
      } else {
        // Include relevant file types
        const ext = path.extname(item).toLowerCase();
        if (['.md', '.py', '.ipynb', '.txt', '.json', '.yaml', '.yml'].includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  /**
   * Upload files to S3 with organized structure
   */
  async uploadToS3(files) {
    const results = [];
    
    for (const filePath of files) {
      try {
        const relativePath = path.relative(this.localCookbookPath, filePath);
        const s3Key = `${this.cookbookPrefix}${relativePath}`;
        
        const fileContent = fs.readFileSync(filePath);
        const contentType = this.getContentType(path.extname(filePath));
        
        // Add metadata
        const metadata = {
          'source': 'openai-cookbook',
          'collected-at': new Date().toISOString(),
          'original-path': relativePath,
          'file-size': fileContent.length.toString()
        };

        const command = new PutObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
          Body: fileContent,
          ContentType: contentType,
          Metadata: metadata
        });

        await this.s3Client.send(command);
        
        results.push({
          localPath: relativePath,
          s3Key: s3Key,
          size: fileContent.length,
          contentType: contentType,
          status: 'uploaded'
        });

        // Log progress every 10 files
        if (results.length % 10 === 0) {
          this.log(`Upload progress: ${results.length}/${files.length} files`);
        }

      } catch (error) {
        this.log('Failed to upload file', {
          filePath: path.relative(this.localCookbookPath, filePath),
          error: error.message
        });
        
        results.push({
          localPath: path.relative(this.localCookbookPath, filePath),
          status: 'failed',
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Get appropriate content type for file extension
   */
  getContentType(ext) {
    const contentTypes = {
      '.md': 'text/markdown',
      '.py': 'text/x-python',
      '.ipynb': 'application/json',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.yaml': 'text/yaml',
      '.yml': 'text/yaml',
      '.js': 'text/javascript',
      '.ts': 'text/typescript',
      '.html': 'text/html',
      '.css': 'text/css'
    };
    
    return contentTypes[ext.toLowerCase()] || 'text/plain';
  }

  /**
   * Create index of uploaded files
   */
  async createIndex(uploadResults) {
    const index = {
      metadata: {
        created: new Date().toISOString(),
        source: 'openai-cookbook',
        totalFiles: uploadResults.length,
        successfulUploads: uploadResults.filter(r => r.status === 'uploaded').length,
        failedUploads: uploadResults.filter(r => r.status === 'failed').length
      },
      categories: {},
      files: uploadResults
    };

    // Categorize files by type and directory
    for (const result of uploadResults) {
      if (result.status === 'uploaded') {
        const pathParts = result.localPath.split(path.sep);
        const category = pathParts[0] || 'root';
        const ext = path.extname(result.localPath);
        
        if (!index.categories[category]) {
          index.categories[category] = {
            count: 0,
            types: {}
          };
        }
        
        index.categories[category].count++;
        index.categories[category].types[ext] = (index.categories[category].types[ext] || 0) + 1;
      }
    }

    // Upload index to S3
    const indexCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: `${this.cookbookPrefix}index.json`,
      Body: JSON.stringify(index, null, 2),
      ContentType: 'application/json',
      Metadata: {
        'type': 'cookbook-index',
        'created': new Date().toISOString()
      }
    });

    await this.s3Client.send(indexCommand);
    
    this.log('Index created and uploaded', {
      totalFiles: index.metadata.totalFiles,
      categories: Object.keys(index.categories).length,
      s3Key: `${this.cookbookPrefix}index.json`
    });

    return index;
  }

  /**
   * Check if cookbook already exists in S3
   */
  async checkExistingCookbook() {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: this.cookbookPrefix,
        MaxKeys: 1
      });

      const response = await this.s3Client.send(command);
      return response.Contents && response.Contents.length > 0;
      
    } catch (error) {
      this.log('Error checking existing cookbook', { error: error.message });
      return false;
    }
  }

  /**
   * Main collection process
   */
  async collectAndUpload(force = false) {
    try {
      this.log('Starting cookbook collection process');

      // Check if already exists
      if (!force) {
        const exists = await this.checkExistingCookbook();
        if (exists) {
          this.log('Cookbook already exists in S3. Use force=true to re-upload.');
          return { status: 'skipped', reason: 'already_exists' };
        }
      }

      // Collect files
      const files = await this.collectCookbookFiles();
      
      // Upload to S3
      this.log('Starting S3 upload process');
      const uploadResults = await this.uploadToS3(files);
      
      // Create index
      const index = await this.createIndex(uploadResults);
      
      this.log('Cookbook collection completed', {
        totalFiles: files.length,
        uploaded: uploadResults.filter(r => r.status === 'uploaded').length,
        failed: uploadResults.filter(r => r.status === 'failed').length,
        s3Prefix: this.cookbookPrefix
      });

      return {
        status: 'completed',
        results: uploadResults,
        index: index,
        summary: {
          totalFiles: files.length,
          uploaded: uploadResults.filter(r => r.status === 'uploaded').length,
          failed: uploadResults.filter(r => r.status === 'failed').length
        }
      };

    } catch (error) {
      this.log('Cookbook collection failed', { error: error.message });
      throw error;
    }
  }
}

// Run if called directly
if (require.main === module) {
  const collector = new CookbookCollector();
  
  const force = process.argv.includes('--force');
  
  collector.collectAndUpload(force)
    .then((result) => {
      console.log('\n🎯 Cookbook collection result:', result.status);
      if (result.summary) {
        console.log('📊 Summary:');
        console.log(`   Total files: ${result.summary.totalFiles}`);
        console.log(`   Uploaded: ${result.summary.uploaded}`);
        console.log(`   Failed: ${result.summary.failed}`);
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Cookbook collection failed:', error.message);
      process.exit(1);
    });
}

module.exports = CookbookCollector;