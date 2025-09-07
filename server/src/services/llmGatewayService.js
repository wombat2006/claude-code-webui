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
   * Send query to LLM with enriched context
   */
  async queryLLM(model, query, options = {}) {
    const startTime = Date.now();
    
    try {
      // Get enriched context
      const context = await this.getEnrichedContext(query, options);
      
      // Build enhanced prompt with context
      const enhancedPrompt = this.buildEnhancedPrompt(query, context, options);
      
      // Route to appropriate LLM
      const response = await this.routeLLMRequest(model, enhancedPrompt, options);
      
      const endTime = Date.now();
      const latency = endTime - startTime;
      
      // Log and return response
      this.log('LLM query completed', {
        model,
        latency: `${latency}ms`,
        queryLength: query.length,
        contextReferences: context.references.length
      });
      
      return {
        success: true,
        response: response.content,
        model,
        latency,
        tokens: response.tokens,
        cost: response.cost,
        context: {
          references: context.references.length,
          sessionId: options.sessionId
        }
      };
      
    } catch (error) {
      const endTime = Date.now();
      const latency = endTime - startTime;
      
      this.log('LLM query failed', {
        model,
        error: error.message,
        latency: `${latency}ms`
      });
      
      return {
        success: false,
        error: error.message,
        model,
        latency
      };
    }
  }
  
  /**
   * Build enhanced prompt with context and references
   */
  buildEnhancedPrompt(originalQuery, context, options = {}) {
    let prompt = '';
    
    // Add system context
    if (context.executionContext) {
      prompt += '## Recent Execution Context:\n';
      context.executionContext.recentCommands.forEach(cmd => {
        prompt += `- ${cmd.command} (${cmd.timestamp})\n`;
      });
      prompt += '\n';
    }
    
    // Add error context
    if (context.errorContext) {
      prompt += '## Recent Errors:\n';
      context.errorContext.recentErrors.forEach(error => {
        prompt += `- ${error.pattern}: ${error.description}\n`;
      });
      prompt += '\n';
    }
    
    // Add RAG references
    if (context.references.length > 0) {
      prompt += '## Relevant References:\n';
      context.references.forEach(ref => {
        prompt += `- ${ref.type}: ${ref.description}\n`;
        if (ref.content) {
          prompt += `  Content: ${ref.content.substring(0, 200)}...\n`;
        }
      });
      prompt += '\n';
    }
    
    // Add original query
    prompt += '## User Query:\n';
    prompt += originalQuery;
    
    return prompt;
  }
  
  /**
   * Route LLM request to appropriate service
   */
  async routeLLMRequest(model, prompt, options = {}) {
    try {
      // Check if we're in mock mode (for testing)
      if (process.env.NODE_ENV === 'test' || process.env.MOCK_LLM === 'true') {
        return await this.mockLLMCall(model, prompt, options);
      }

      // Route to appropriate LLM API directly
      if (model.includes('gpt') || model.includes('o3')) {
        return await this.callOpenAIAPI(model, prompt, options);
      } else if (model.includes('claude') || model.includes('sonnet')) {
        return await this.callClaudeAPI(model, prompt, options);
      } else if (model.includes('gemini')) {
        return await this.callGeminiAPI(model, prompt, options);
      } else {
        // Default to GPT-5 for unrecognized models
        return await this.callOpenAIAPI('gpt-5', prompt, options);
      }
      
    } catch (error) {
      this.log('LLM API call failed', { model, error: error.message });
      throw new Error(`LLM API call failed for model ${model}: ${error.message}`);
    }
  }
  
  /**
   * Mock LLM call for testing (replace with real API calls)
   */
  async mockLLMCall(model, prompt, options = {}) {
    // Simulate network latency
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
    
    const promptTokens = Math.ceil(prompt.length / 4); // Rough token estimation
    const completionTokens = Math.floor(Math.random() * 500) + 100;
    const totalTokens = promptTokens + completionTokens;
    
    // Mock cost calculation based on model
    let costPerToken = 0.000003; // Default
    if (model.includes('gpt-5')) costPerToken = 0.00001;
    else if (model.includes('claude-4')) costPerToken = 0.000008;
    else if (model.includes('gemini-2.5-pro')) costPerToken = 0.0000005;
    
    const cost = totalTokens * costPerToken;
    
    return {
      content: `Mock response from ${model} for query: "${prompt.substring(0, 50)}..."\n\nThis is a simulated response that would contain the actual LLM output. The response includes contextual references and is tailored to the user's session.`,
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      cost,
      model
    };
  }

  /**
   * Load pricing data from MODEL_PRICING_WITH_1K.json
   */
  loadPricingData() {
    if (!this.pricingData) {
      try {
        const path = require('path');
        const fs = require('fs');
        const pricingPath = path.join(__dirname, '../../../docs/pricing/MODEL_PRICING_WITH_1K.json');
        this.pricingData = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
      } catch (error) {
        console.error('Failed to load pricing data:', error.message);
        this.pricingData = null;
      }
    }
    return this.pricingData;
  }

  /**
   * Calculate accurate cost based on official pricing
   */
  calculateAccurateCost(model, promptTokens, completionTokens) {
    const pricingData = this.loadPricingData();
    
    if (!pricingData) {
      // Fallback to hardcoded pricing if file not available
      return this.calculateFallbackCost(model, promptTokens, completionTokens);
    }

    // Map model names to pricing data keys
    let provider, modelKey;
    
    if (model.includes('claude-4') || model.includes('sonnet-4')) {
      provider = 'anthropic';
      modelKey = 'claude-sonnet-4';
    } else if (model.includes('opus-4.1')) {
      provider = 'anthropic';
      modelKey = 'claude-opus-4.1';
    } else if (model.includes('haiku-3.5')) {
      provider = 'anthropic';
      modelKey = 'claude-haiku-3.5';
    } else if (model.includes('gpt-5-mini')) {
      provider = 'openai';
      modelKey = 'gpt-5-mini';
    } else if (model.includes('gpt-5-nano')) {
      provider = 'openai';
      modelKey = 'gpt-5-nano';
    } else if (model.includes('gpt-5')) {
      provider = 'openai';
      modelKey = 'gpt-5';
    } else if (model.includes('o3-mini')) {
      provider = 'openai';
      modelKey = 'o3-mini';
    } else if (model.includes('gemini-2.5-pro')) {
      provider = 'google';
      modelKey = 'gemini-2.5-pro';
    } else if (model.includes('gemini-2.5-flash-lite')) {
      provider = 'google';
      modelKey = 'gemini-2.5-flash-lite';
    } else if (model.includes('gemini-2.5-flash')) {
      provider = 'google';
      modelKey = 'gemini-2.5-flash';
    } else if (model.includes('gemini-2.0-flash-lite')) {
      provider = 'google';
      modelKey = 'gemini-2.0-flash-lite';
    } else if (model.includes('gemini-2.0-flash')) {
      provider = 'google';
      modelKey = 'gemini-2.0-flash';
    } else {
      // Default fallback
      return this.calculateFallbackCost(model, promptTokens, completionTokens);
    }

    const modelPricing = pricingData.providers[provider]?.[modelKey];
    if (!modelPricing || !modelPricing.input_per_1k || !modelPricing.output_per_1k) {
      return this.calculateFallbackCost(model, promptTokens, completionTokens);
    }

    // Calculate cost using official pricing (per 1K tokens)
    const inputCost = (promptTokens / 1000) * modelPricing.input_per_1k;
    const outputCost = (completionTokens / 1000) * modelPricing.output_per_1k;
    
    return inputCost + outputCost;
  }

  /**
   * Fallback cost calculation if pricing data unavailable
   */
  calculateFallbackCost(model, promptTokens, completionTokens) {
    // Conservative fallback pricing
    let inputRate = 0.003;  // $0.003/1K
    let outputRate = 0.015; // $0.015/1K
    
    if (model.includes('gpt-5')) {
      inputRate = 0.00125;
      outputRate = 0.01;
    } else if (model.includes('opus-4.1')) {
      inputRate = 0.015;
      outputRate = 0.075;
    } else if (model.includes('gemini-2.5-pro')) {
      inputRate = 0.00125;
      outputRate = 0.01;
    }
    
    return (promptTokens / 1000) * inputRate + (completionTokens / 1000) * outputRate;
  }

  /**
   * Call Claude API
   */
  async callClaudeAPI(model, prompt, options = {}) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
    });

    let modelName = 'claude-3-5-haiku-20241022'; // default
    if (model.includes('claude-4') || model.includes('sonnet-4')) {
      modelName = 'claude-sonnet-4-20250514'; // Claude Sonnet 4
    } else if (model.includes('opus-4.1')) {
      modelName = 'claude-opus-4-1-20250805'; // Claude Opus 4.1 (latest)
    } else if (model.includes('opus-4')) {
      modelName = 'claude-opus-4'; // Claude Opus 4
    }

    const response = await anthropic.messages.create({
      model: modelName,
      max_tokens: options.maxTokens || 1024,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const promptTokens = response.usage.input_tokens;
    const completionTokens = response.usage.output_tokens;
    const totalTokens = promptTokens + completionTokens;
    
    // Use accurate pricing calculation
    const cost = this.calculateAccurateCost(model, promptTokens, completionTokens);

    return {
      content: response.content[0].text,
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      cost,
      model
    };
  }

  /**
   * Call OpenAI API with latest specifications (Responses API + verbosity/effort parameters)
   */
  async callOpenAIAPI(model, prompt, options = {}) {
    const { OpenAI } = await import('openai');
    
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    let modelName = 'gpt-4';
    let useResponsesAPI = false;
    
    // Map model names and determine API type
    if (model.includes('gpt-5')) {
      modelName = 'gpt-5';
      useResponsesAPI = true;
    } else if (model.includes('gpt-4.1')) {
      modelName = 'gpt-4.1';
      useResponsesAPI = true;
    } else if (model.includes('o3')) {
      modelName = 'o3';
      useResponsesAPI = true;
    } else if (model.includes('o4-mini')) {
      modelName = 'o4-mini-2025-04-16';
      useResponsesAPI = false; // o4-mini does not support Responses API
    } else if (model.includes('gpt-4')) {
      modelName = 'gpt-4-turbo';
      useResponsesAPI = false; // Legacy models use Chat Completions
    }

    let response;
    
    if (useResponsesAPI) {
      try {
        // Resolve model name (handle fine-tuned models)
        const resolvedModel = await this.resolveModel(modelName, {
          fineTunedModel: options.fineTunedModel,
          fineTuneJobId: options.fineTuneId
        }, openai);

        // Use new Responses API with correct parameters based on official docs
        const responsesPayload = {
          model: resolvedModel, // Use resolved model name
          input: [
            {
              role: 'user',
              content: prompt
            }
          ],
          text: {
            verbosity: this.mapVerbosityParameter(options.verbosity || 'medium', resolvedModel)
          },
          temperature: 1,
          store: options.store !== false
        };

        // Add reasoning parameters only for models that support it
        if (this.supportsReasoning(resolvedModel)) {
          responsesPayload.reasoning = {
            effort: options.effort || 'medium'
          };
        }

        // Add tools if specified
        if (options.tools) {
          responsesPayload.tools = options.tools;
        }

        response = await openai.responses.create(responsesPayload);
      } catch (error) {
        // Fallback to Chat Completions API if Responses API not available
        this.log('Responses API failed, falling back to Chat Completions', { 
          model: resolvedModel, 
          error: error.message 
        });
        
        const fallbackPayload = {
          model: resolvedModel,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          max_completion_tokens: this.mapVerbosityToTokens(options.verbosity || 'medium'),
          temperature: 1
        };
        
        response = await openai.chat.completions.create(fallbackPayload);
      }
    } else {
      // Legacy Chat Completions API for older models
      const requestPayload = {
        model: modelName,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      };

      // o4-mini only supports temperature=1 (default), other models support custom temperature
      if (modelName.includes('o4-mini')) {
        requestPayload.temperature = 1; // o4-mini only supports default temperature
      } else {
        requestPayload.temperature = options.temperature || 0.7;
      }

      // o4-mini uses max_completion_tokens, other models use max_tokens
      if (modelName.includes('o4-mini')) {
        requestPayload.max_completion_tokens = options.maxTokens || 2048;
      } else {
        requestPayload.max_tokens = options.maxTokens || 2048;
      }

      response = await openai.chat.completions.create(requestPayload);
    }

    // Extract response data (handle both API formats)
    let content = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    if (useResponsesAPI && response.output) {
      // Responses API format
      content = response.output_text || ''; // Helper method for text extraction
      
      // Find text content in output items
      const textItems = response.output.filter(item => item.type === 'message');
      if (textItems.length > 0) {
        const textContent = textItems[0].content.find(c => c.type === 'output_text');
        if (textContent) {
          content = textContent.text;
        }
      }

      // Usage information
      if (response.usage) {
        promptTokens = response.usage.prompt_tokens || 0;
        completionTokens = response.usage.completion_tokens || 0;
        totalTokens = response.usage.total_tokens || promptTokens + completionTokens;
      }
    } else {
      // Chat Completions API format
      content = response.choices[0].message?.content || response.choices[0].text || '';
      promptTokens = response.usage?.prompt_tokens || 0;
      completionTokens = response.usage?.completion_tokens || 0;
      totalTokens = response.usage?.total_tokens || promptTokens + completionTokens;
    }
    
    // Calculate accurate cost using official pricing table
    const cost = this.calculateAccurateCost(modelName, promptTokens, completionTokens);

    return {
      content,
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      cost,
      model,
      apiType: useResponsesAPI ? 'responses' : 'chat_completions',
      parameters: useResponsesAPI ? {
        verbosity: options.verbosity || 'medium',
        effort: options.effort || 'medium',
        reasoning: options.reasoning || 'adaptive'
      } : {
        max_tokens: options.maxTokens || 2048
      }
    };
  }

  /**
   * Map verbosity levels to approximate token counts (fallback use)
   */
  mapVerbosityToTokens(verbosity) {
    const verbosityMap = {
      'concise': 512,
      'standard': 1024,
      'detailed': 2048,
      'comprehensive': 4096
    };
    return verbosityMap[verbosity] || 1024;
  }

  /**
   * Map verbosity parameters for Responses API
   * OpenAI API generally supports: 'low', 'medium', 'high'
   * o4-mini-2025-04-16 only supports: 'medium'
   */
  mapVerbosityParameter(verbosity, model = '') {
    const verbosityMap = {
      'concise': 'low',
      'standard': 'medium',
      'detailed': 'high',
      'comprehensive': 'high',
      'low': 'low',
      'medium': 'medium',
      'high': 'high'
    };
    
    const mappedVerbosity = verbosityMap[verbosity] || 'medium';
    
    // o4-mini-2025-04-16 only supports 'medium' verbosity
    if (model.includes('o4-mini')) {
      return 'medium';
    }
    
    return mappedVerbosity;
  }


  /**
   * Resolve model name (handle fine-tuned models)
   * @param {string} baseModel - The base model name
   * @param {object} options - The options object with fine-tuning info
   * @param {object} openai - The OpenAI client instance
   * @returns {Promise<string>} - Resolved model name
   */
  async resolveModel(baseModel, { fineTunedModel, fineTuneJobId }, openai = null) {
    // Use pre-provided fine-tuned model name (e.g., "ft:o4-mini-2025-04-16:org:proj:run:abc")
    if (fineTunedModel) {
      return fineTunedModel;
    }
    
    // Resolve fine-tune job ID to model name
    if (fineTuneJobId && openai) {
      try {
        const job = await openai.fineTuning.jobs.retrieve(fineTuneJobId);
        if (!job.fine_tuned_model) {
          throw new Error(`Fine-tune not ready (status: ${job.status})`);
        }
        return job.fine_tuned_model;
      } catch (error) {
        this.log('Fine-tune job resolution failed', { jobId: fineTuneJobId, error: error.message });
        // Fall back to base model
      }
    }
    
    // Default to base model
    return baseModel;
  }

  /**
   * Check if model supports reasoning parameters
   * @param {string} model - The model name
   * @returns {boolean} - Whether the model supports reasoning
   */
  supportsReasoning(model) {
    return String(model).includes('o4') || String(model).includes('o3') || String(model).includes('gpt-5');
  }

  /**
   * Call Google Gemini API
   */
  async callGeminiAPI(model, prompt, options = {}) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
    let modelName = 'gemini-1.5-pro';
    if (model.includes('gemini-2.5-pro')) {
      modelName = 'gemini-2.5-pro';
    } else if (model.includes('gemini-2.0-flash')) {
      modelName = 'gemini-2.0-flash';
    }
    
    const geminiModel = genAI.getGenerativeModel({ model: modelName });

    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Estimate tokens (rough approximation)
    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.ceil(text.length / 4);
    const totalTokens = promptTokens + completionTokens;
    
    // Calculate accurate cost using official pricing table
    const cost = this.calculateAccurateCost(model, promptTokens, completionTokens);

    return {
      content: text,
      tokens: totalTokens,
      promptTokens,
      completionTokens,
      cost,
      model
    };
  }

  /**
   * Call LLM via Claude Code's MCP tools (native integration)
   */
  async callClaudeCodeMCP(model, prompt, options = {}) {
    try {
      // Import Claude Code's MCP chat tool dynamically
      const { mcp__zen__chat } = global;
      
      if (!mcp__zen__chat) {
        throw new Error('Claude Code MCP tools not available in this environment');
      }
      
      const startTime = Date.now();
      
      // Call the MCP chat tool with the specified model
      const response = await mcp__zen__chat({
        prompt,
        model,
        temperature: options.temperature || 0.7,
        thinking_mode: options.thinking_mode || 'medium',
        use_websearch: false // Disable web search for LLM collaboration
      });
      
      const endTime = Date.now();
      const latency = endTime - startTime;
      
      // Extract response content
      const content = response.content || response.response || response.text || '';
      
      // Estimate tokens (rough approximation)
      const promptTokens = Math.ceil(prompt.length / 4);
      const completionTokens = Math.ceil(content.length / 4);
      const totalTokens = promptTokens + completionTokens;
      
      // Calculate accurate cost using official pricing table
      const cost = this.calculateAccurateCost(model, promptTokens, completionTokens);
      
      return {
        content,
        tokens: totalTokens,
        promptTokens,
        completionTokens,
        cost,
        model,
        latency
      };
      
    } catch (error) {
      this.log('Claude Code MCP call failed', { model, error: error.message });
      throw new Error(`Claude Code MCP call failed for model ${model}: ${error.message}`);
    }
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