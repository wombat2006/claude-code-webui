/**
 * LLM Gateway Service
 * Claude Code WebUI unified gateway for all LLMs
 * Provides session-aware context and references to LLMs
 */

const SessionSnapshotRetriever = require('./sessionSnapshotRetriever');
const RagStorageService = require('./ragStorageService');

class LLMGatewayService {
  constructor(options = {}) {
    this.snapshotRetriever = new SessionSnapshotRetriever({
      snapshotDir: options.snapshotDir,
      cacheDir: options.cacheDir,
      maxCacheSize: options.maxCacheSize || 50,
      cacheTtl: options.cacheTtl || 300000
    });

    // Initialize RAG Storage Service
    this.ragStorage = new RagStorageService({
      storageDir: options.ragStorageDir || '/tmp/claude-rag-storage',
      maxCacheSize: options.ragMaxCacheSize || 20,
      batchSize: options.ragBatchSize || 5
    });
    
    this.maxContextLength = options.maxContextLength || 8000;
    this.defaultMaxReferences = options.defaultMaxReferences || 5;
    
    this.log = (message, data = {}) => {
      console.log(`[LLMGateway ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    this.log('LLM Gateway Service initialized', {
      maxContextLength: this.maxContextLength,
      defaultMaxReferences: this.defaultMaxReferences
    });
  }

  /**
   * Get enriched context for LLM queries
   */
  async getEnrichedContext(query, options = {}) {
    try {
      const {
        sessionId,
        contextType = 'recent',
        maxReferences = this.defaultMaxReferences,
        includeErrors = true,
        includeFileChanges = true
      } = options;

      this.log('Building enriched context', {
        sessionId,
        contextType,
        queryLength: query.length
      });

      const context = {
        query,
        sessionId,
        references: [],
        executionContext: null,
        errorContext: null,
        timestamp: new Date().toISOString()
      };

      if (sessionId) {
        // Get session-specific context
        const sessionContext = await this.snapshotRetriever.getSessionContext(
          sessionId, 
          contextType
        );

        if (sessionContext) {
          context.executionContext = {
            recentCommands: sessionContext.executionHistory.slice(0, maxReferences),
            timeRange: sessionContext.timeRange
          };

          if (includeErrors && sessionContext.errorPatterns.length > 0) {
            context.errorContext = {
              recentErrors: sessionContext.errorPatterns.slice(0, 3),
              errorCount: sessionContext.errorPatterns.length
            };
          }

          if (includeFileChanges && sessionContext.fileChanges.length > 0) {
            context.fileChanges = sessionContext.fileChanges.slice(0, maxReferences);
          }
        }

        // Get references from both session snapshots and RAG storage in parallel
        const [snapshots, ragResults] = await Promise.all([
          this.snapshotRetriever.getLastSnapshots(sessionId, Math.floor(maxReferences / 2)),
          this.ragStorage.search(query, Math.ceil(maxReferences / 2))
        ]);

        // Add session snapshot references
        const snapshotReferences = snapshots.map(snapshot => ({
          source: 'session_snapshot',
          id: `${snapshot.sessionId}_${snapshot.timestamp}`,
          timestamp: snapshot.timestamp,
          triggerEvent: snapshot.triggerEvent,
          command: snapshot.context?.execution?.command,
          exitCode: snapshot.context?.execution?.exitCode,
          stderr: snapshot.context?.execution?.stderr?.substring(0, 500),
          lastChangedFile: snapshot.context?.fileSystem?.lastChangedFile,
          score: this.calculateRelevanceScore(query, snapshot)
        }));

        // Add RAG storage references
        const ragReferences = ragResults.map(result => ({
          source: 'rag_storage',
          id: result.source,
          content_preview: result.content.substring(0, 500),
          score: result.score * 10, // Scale RAG scores to match snapshot scores
          relevantFor: 'knowledge_base'
        }));

        // Combine and sort all references by score
        context.references = [...snapshotReferences, ...ragReferences];
        context.references.sort((a, b) => b.score - a.score);
      }

      this.log('Enriched context built', {
        sessionId,
        referencesCount: context.references.length,
        hasExecutionContext: !!context.executionContext,
        hasErrorContext: !!context.errorContext
      });

      return context;
    } catch (error) {
      this.log('Failed to build enriched context', {
        sessionId: options.sessionId,
        error: error.message
      });
      
      return {
        query,
        sessionId: options.sessionId,
        references: [],
        executionContext: null,
        errorContext: null,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Calculate relevance score between query and snapshot
   */
  calculateRelevanceScore(query, snapshot) {
    let score = 0;
    const queryLower = query.toLowerCase();

    // Recent snapshots get higher base score
    const age = Date.now() - new Date(snapshot.timestamp).getTime();
    const ageHours = age / (1000 * 60 * 60);
    score += Math.max(0, 10 - ageHours); // Decay over time

    // Command execution context
    if (snapshot.context?.execution?.command) {
      const command = snapshot.context.execution.command.toLowerCase();
      if (queryLower.includes(command) || command.includes(queryLower)) {
        score += 5;
      }
    }

    // Error context - highly relevant for debugging queries
    if (snapshot.context?.execution?.exitCode !== 0) {
      if (queryLower.includes('error') || queryLower.includes('fail') || 
          queryLower.includes('debug') || queryLower.includes('why')) {
        score += 8;
      }
    }

    // File change context
    if (snapshot.context?.fileSystem?.lastChangedFile) {
      const fileName = snapshot.context.fileSystem.lastChangedFile.toLowerCase();
      if (queryLower.includes(fileName) || fileName.includes(queryLower.split(' ')[0])) {
        score += 3;
      }
    }

    // Trigger event relevance
    if (queryLower.includes('test') && snapshot.triggerEvent === 'command_execution') {
      if (snapshot.context?.execution?.command?.includes('test')) {
        score += 4;
      }
    }

    return Math.max(score, 1); // Minimum score of 1
  }

  /**
   * Format context for LLM prompt
   */
  formatContextForLLM(enrichedContext, format = 'detailed') {
    try {
      const { query, sessionId, references, executionContext, errorContext } = enrichedContext;

      let prompt = `# Development Session Query\n\n`;
      prompt += `**Query**: ${query}\n\n`;

      if (sessionId) {
        prompt += `**Session**: ${sessionId}\n\n`;
      }

      if (executionContext && executionContext.recentCommands.length > 0) {
        prompt += `## Recent Command History\n`;
        executionContext.recentCommands.forEach((cmd, index) => {
          const status = cmd.exitCode === 0 ? '✓' : '✗';
          prompt += `${index + 1}. ${status} \`${cmd.command}\` (${cmd.duration}ms)\n`;
        });
        prompt += '\n';
      }

      if (errorContext && errorContext.recentErrors.length > 0) {
        prompt += `## Recent Errors (${errorContext.errorCount} total)\n`;
        errorContext.recentErrors.forEach((error, index) => {
          prompt += `${index + 1}. **Command**: \`${error.command}\`\n`;
          if (error.stderr) {
            prompt += `   **Error**: ${error.stderr.substring(0, 200)}...\n`;
          }
          prompt += '\n';
        });
      }

      if (references.length > 0) {
        prompt += `## Relevant Context (Top ${references.length} references from session + knowledge base)\n`;
        references.forEach((ref, index) => {
          if (ref.source === 'session_snapshot') {
            prompt += `### ${index + 1}. [Session] ${ref.triggerEvent} (Score: ${ref.score.toFixed(1)})\n`;
            prompt += `- **Time**: ${new Date(ref.timestamp).toLocaleString()}\n`;
            if (ref.command) {
              prompt += `- **Command**: \`${ref.command}\`\n`;
            }
            if (ref.exitCode !== undefined) {
              const status = ref.exitCode === 0 ? 'Success' : 'Failed';
              prompt += `- **Status**: ${status}\n`;
            }
            if (ref.stderr) {
              prompt += `- **Error**: ${ref.stderr}\n`;
            }
            if (ref.lastChangedFile) {
              prompt += `- **File**: ${ref.lastChangedFile}\n`;
            }
          } else if (ref.source === 'rag_storage') {
            prompt += `### ${index + 1}. [Knowledge] ${ref.id} (Score: ${ref.score.toFixed(1)})\n`;
            prompt += `\`\`\`\n${ref.content_preview}\n\`\`\`\n`;
          }
          prompt += '\n';
        });
      }

      prompt += `---\n\n`;
      prompt += `Please provide a response based on the above development session context. `;
      prompt += `Focus on the specific query while considering the execution history, errors, and recent changes.\n`;

      return prompt;
    } catch (error) {
      this.log('Failed to format context for LLM', { error: error.message });
      return `Query: ${enrichedContext.query}\n\nError formatting context: ${error.message}`;
    }
  }

  /**
   * Process LLM query with session context
   */
  async processQuery(query, options = {}) {
    try {
      this.log('Processing LLM query', {
        sessionId: options.sessionId,
        queryLength: query.length
      });

      // Get enriched context
      const enrichedContext = await this.getEnrichedContext(query, options);
      
      // Format for LLM consumption
      const formattedPrompt = this.formatContextForLLM(enrichedContext, options.format);
      
      const result = {
        success: true,
        originalQuery: query,
        enrichedPrompt: formattedPrompt,
        context: {
          sessionId: options.sessionId,
          referencesCount: enrichedContext.references.length,
          hasExecutionContext: !!enrichedContext.executionContext,
          hasErrorContext: !!enrichedContext.errorContext,
          contextLength: formattedPrompt.length
        },
        timestamp: new Date().toISOString()
      };

      this.log('Query processed successfully', {
        sessionId: options.sessionId,
        contextLength: result.context.contextLength,
        referencesCount: result.context.referencesCount
      });

      return result;
    } catch (error) {
      this.log('Failed to process query', {
        sessionId: options.sessionId,
        error: error.message
      });

      return {
        success: false,
        originalQuery: query,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get debugging context for error analysis
   */
  async getDebugContext(sessionId, errorQuery = '') {
    try {
      this.log('Building debug context', { sessionId });

      // Find error patterns
      const errorPatterns = await this.snapshotRetriever.findErrorPatterns(sessionId, 5);
      
      // Get recent context
      const recentContext = await this.snapshotRetriever.getSessionContext(sessionId, 'recent');
      
      const debugContext = {
        sessionId,
        query: errorQuery,
        errorPatterns: errorPatterns.map(pattern => ({
          command: pattern.command,
          stderr: pattern.stderr,
          timestamp: pattern.timestamp,
          exitCode: pattern.exitCode
        })),
        recentActivity: recentContext?.executionHistory?.slice(0, 3) || [],
        suggestions: this.generateDebugSuggestions(errorPatterns),
        timestamp: new Date().toISOString()
      };

      this.log('Debug context built', {
        sessionId,
        errorPatterns: debugContext.errorPatterns.length,
        suggestions: debugContext.suggestions.length
      });

      return debugContext;
    } catch (error) {
      this.log('Failed to build debug context', { 
        sessionId, 
        error: error.message 
      });
      return null;
    }
  }

  /**
   * Generate debug suggestions based on error patterns
   */
  generateDebugSuggestions(errorPatterns) {
    const suggestions = [];

    errorPatterns.forEach(pattern => {
      if (pattern.stderr) {
        const stderr = pattern.stderr.toLowerCase();
        
        if (stderr.includes('command not found')) {
          suggestions.push({
            type: 'missing_command',
            suggestion: `Install or check PATH for command: ${pattern.command}`,
            priority: 'high'
          });
        }
        
        if (stderr.includes('permission denied')) {
          suggestions.push({
            type: 'permission',
            suggestion: `Check file permissions or run with appropriate privileges`,
            priority: 'medium'
          });
        }
        
        if (stderr.includes('port') && stderr.includes('use')) {
          suggestions.push({
            type: 'port_conflict',
            suggestion: `Port conflict detected, try a different port or kill existing process`,
            priority: 'high'
          });
        }
        
        if (stderr.includes('module not found') || stderr.includes('cannot find module')) {
          suggestions.push({
            type: 'dependency',
            suggestion: `Missing dependency, run npm install or check package.json`,
            priority: 'high'
          });
        }
      }
    });

    // Remove duplicates
    const uniqueSuggestions = suggestions.filter((suggestion, index, self) => 
      index === self.findIndex(s => s.type === suggestion.type)
    );

    return uniqueSuggestions;
  }

  /**
   * Get gateway statistics
   */
  getStats() {
    const retrieverStats = this.snapshotRetriever.getStats();
    const ragStats = this.ragStorage.getStats();
    
    return {
      gateway: {
        maxContextLength: this.maxContextLength,
        defaultMaxReferences: this.defaultMaxReferences,
        timestamp: Date.now()
      },
      retriever: retrieverStats,
      ragStorage: ragStats
    };
  }
}

module.exports = LLMGatewayService;