/**
 * RAG Storage Service
 * Memory-efficient local file-based RAG simulation for Phase 2
 * Implements lightweight keyword indexing with batch processing
 */

const fs = require('fs').promises;
const path = require('path');

class RagStorageService {
  constructor(options = {}) {
    this.storageDir = options.storageDir || '/tmp/claude-rag-storage';
    this.indexFile = path.join(this.storageDir, 'rag_index.json');
    this.keywordIndex = new Map(); // Lightweight in-memory keyword index
    this.cache = new Map();
    this.maxCacheSize = options.maxCacheSize || 20; // Memory constraint: limit cache
    this.maxFileSize = options.maxFileSize || 100000; // 100KB per file limit
    this.batchSize = options.batchSize || 5; // Process files in small batches
    this.initialized = false;
    
    this.log = (message, data = {}) => {
      console.log(`[RagStorage ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    this.initializeAsync();
  }

  async initializeAsync() {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      await this.loadOrBuildIndex();
      this.initialized = true;
      
      this.log('RAG Storage Service initialized', {
        storageDir: this.storageDir,
        indexSize: this.keywordIndex.size,
        cacheLimit: this.maxCacheSize
      });
    } catch (error) {
      this.log('Failed to initialize RAG storage', { error: error.message });
    }
  }

  /**
   * Load existing index or build from scratch
   */
  async loadOrBuildIndex() {
    try {
      // Try to load existing index
      const indexData = await fs.readFile(this.indexFile, 'utf8');
      const indexObj = JSON.parse(indexData);
      
      // Convert object back to Map
      this.keywordIndex = new Map(Object.entries(indexObj));
      this.log('Loaded existing RAG index', { keywordCount: this.keywordIndex.size });
      
    } catch (error) {
      this.log('Building new RAG index', { reason: 'no existing index found' });
      await this.buildIndex();
    }
  }

  /**
   * Build keyword index from all files in storage directory
   */
  async buildIndex() {
    try {
      const files = await fs.readdir(this.storageDir);
      const textFiles = files.filter(file => 
        file.endsWith('.md') || file.endsWith('.txt') || file.endsWith('.js') || file.endsWith('.json')
      );

      this.log('Building index from files', { fileCount: textFiles.length });

      // Process files in batches to avoid memory spikes
      for (let i = 0; i < textFiles.length; i += this.batchSize) {
        const batch = textFiles.slice(i, i + this.batchSize);
        await this.processBatch(batch);
        
        // Trigger GC between batches if available
        if (global.gc) {
          global.gc();
        }
      }

      await this.saveIndex();
      this.log('Index building completed', { keywordCount: this.keywordIndex.size });
      
    } catch (error) {
      this.log('Failed to build index', { error: error.message });
    }
  }

  /**
   * Process a batch of files for indexing
   */
  async processBatch(fileBatch) {
    const promises = fileBatch.map(async (filename) => {
      try {
        const filepath = path.join(this.storageDir, filename);
        const stats = await fs.stat(filepath);
        
        // Skip files that are too large
        if (stats.size > this.maxFileSize) {
          this.log('Skipping large file', { filename, sizeMB: Math.round(stats.size / 1024 / 1024) });
          return;
        }

        const content = await fs.readFile(filepath, 'utf8');
        this.indexFileContent(filename, content);
        
      } catch (error) {
        this.log('Error processing file', { filename, error: error.message });
      }
    });

    await Promise.all(promises);
  }

  /**
   * Extract keywords from file content and add to index
   */
  indexFileContent(filename, content) {
    // Simple keyword extraction - split by whitespace and punctuation
    const words = content.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && word.length < 30); // Filter reasonable word lengths

    // Create chunks for better context (every 100 words)
    const chunkSize = 100;
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join(' ');
      const chunkId = `${filename}#${Math.floor(i / chunkSize)}`;
      chunks.push({ id: chunkId, content: chunk.substring(0, 500) }); // Limit chunk content
    }

    // Add words to keyword index
    const uniqueWords = [...new Set(words)];
    uniqueWords.forEach(word => {
      if (!this.keywordIndex.has(word)) {
        this.keywordIndex.set(word, []);
      }
      
      // Add file reference if not already present
      const refs = this.keywordIndex.get(word);
      if (!refs.some(ref => ref.startsWith(filename))) {
        refs.push(`${filename}#${refs.length}`);
        // Limit references per keyword to prevent memory bloat
        if (refs.length > 50) {
          refs.shift(); // Remove oldest reference
        }
      }
    });

    // Store chunks in cache
    chunks.forEach(chunk => {
      this.addToCache(chunk.id, chunk.content);
    });
  }

  /**
   * Add item to cache with size management
   */
  addToCache(key, content) {
    if (this.cache.size >= this.maxCacheSize) {
      // Remove oldest cache entry
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, content);
  }

  /**
   * Save keyword index to disk
   */
  async saveIndex() {
    try {
      const indexObj = Object.fromEntries(this.keywordIndex);
      await fs.writeFile(this.indexFile, JSON.stringify(indexObj, null, 2));
    } catch (error) {
      this.log('Failed to save index', { error: error.message });
    }
  }

  /**
   * Search for relevant documents based on query
   */
  async search(query, topK = 3) {
    if (!this.initialized) {
      this.log('Search called before initialization complete', { query });
      return [];
    }

    try {
      const queryWords = query.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2);

      this.log('RAG search initiated', { 
        query, 
        queryWords: queryWords.length,
        indexSize: this.keywordIndex.size 
      });

      const scores = new Map();

      // Score documents based on keyword matches
      queryWords.forEach(word => {
        if (this.keywordIndex.has(word)) {
          const refs = this.keywordIndex.get(word);
          refs.forEach(ref => {
            const filename = ref.split('#')[0];
            const currentScore = scores.get(filename) || 0;
            scores.set(filename, currentScore + 1);
          });
        }
      });

      // Convert to results array and sort
      const results = Array.from(scores.entries())
        .map(([filename, score]) => ({
          source: filename,
          score: score / queryWords.length, // Normalize by query length
          content: this.getFilePreview(filename)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      this.log('RAG search completed', { 
        resultsFound: results.length,
        topScore: results[0]?.score || 0
      });

      return results;
      
    } catch (error) {
      this.log('RAG search failed', { query, error: error.message });
      return [];
    }
  }

  /**
   * Get preview content for a file
   */
  getFilePreview(filename) {
    // Check cache first
    const cacheKeys = Array.from(this.cache.keys()).filter(key => key.startsWith(filename));
    if (cacheKeys.length > 0) {
      return this.cache.get(cacheKeys[0]) || `File: ${filename}`;
    }
    
    return `File: ${filename} (preview not available)`;
  }

  /**
   * Add a document to the RAG storage
   */
  async addDocument(filename, content) {
    try {
      const filepath = path.join(this.storageDir, filename);
      
      // Check file size limit
      if (content.length > this.maxFileSize) {
        throw new Error(`File too large: ${content.length} bytes (limit: ${this.maxFileSize})`);
      }

      await fs.writeFile(filepath, content, 'utf8');
      
      // Update index
      this.indexFileContent(filename, content);
      await this.saveIndex();
      
      this.log('Document added to RAG storage', { 
        filename, 
        sizeMB: Math.round(content.length / 1024 / 1024 * 100) / 100 
      });

      return { success: true, filename, size: content.length };
      
    } catch (error) {
      this.log('Failed to add document', { filename, error: error.message });
      throw error;
    }
  }

  /**
   * Get RAG storage statistics
   */
  getStats() {
    return {
      initialized: this.initialized,
      keywordCount: this.keywordIndex.size,
      cacheSize: this.cache.size,
      maxCacheSize: this.maxCacheSize,
      storageDir: this.storageDir,
      memoryEstimateMB: Math.round((this.keywordIndex.size * 50 + this.cache.size * 1000) / 1024 / 1024 * 100) / 100
    };
  }

  /**
   * Clear cache and rebuild index
   */
  async refresh() {
    this.log('Refreshing RAG storage');
    this.keywordIndex.clear();
    this.cache.clear();
    await this.buildIndex();
  }
}

module.exports = RagStorageService;