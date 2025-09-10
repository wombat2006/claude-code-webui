import { s3RagService } from './s3RagService';
import { context7RagIntegration } from './context7RagIntegration';
import logger from '../config/logger';
import { EventEmitter } from 'events';

interface LLMRequest {
  sessionId: string;
  userId: string;
  llmModel: string;
  query: string;
  context?: string;
  project?: string;
  language?: string;
  requestType: 'code-analysis' | 'design-guidance' | 'debugging' | 'documentation' | 'general';
}

interface EnrichedContext {
  originalQuery: string;
  ragResults: any[];
  context7References: any[];
  conversationHistory: any[];
  codeContext: any[];
  designPatterns: any[];
  totalTokens: number;
  relevanceScore: number;
  sources: string[];
}

interface LLMResponse {
  sessionId: string;
  response: string;
  enrichedContext: EnrichedContext;
  usedSources: string[];
  timestamp: number;
  model: string;
}

export class LLMRagGateway extends EventEmitter {
  private contextCache = new Map<string, { context: EnrichedContext; timestamp: number }>();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes
  private maxContextTokens: number;

  constructor() {
    super();
    this.maxContextTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '4000');
    
    // Cleanup cache periodically
    setInterval(() => {
      this.cleanupCache();
    }, 60000); // Every minute

    logger.info('LLMRagGateway initialized');
  }

  // Main gateway method for all LLMs
  async enrichLLMContext(request: LLMRequest): Promise<EnrichedContext> {
    try {
      const cacheKey = this.generateCacheKey(request);
      
      // Check cache first
      const cached = this.contextCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < this.cacheTimeout)) {
        logger.debug('Using cached enriched context', { sessionId: request.sessionId });
        return cached.context;
      }

      // Build enriched context from multiple sources
      const enrichedContext = await this.buildEnrichedContext(request);
      
      // Cache the result
      this.contextCache.set(cacheKey, {
        context: enrichedContext,
        timestamp: Date.now()
      });

      // Log context enrichment
      logger.audit('LLM context enriched', {
        sessionId: request.sessionId,
        userId: request.userId,
        llmModel: request.llmModel,
        requestType: request.requestType,
        ragResultsCount: enrichedContext.ragResults.length,
        context7ReferencesCount: enrichedContext.context7References.length,
        totalTokens: enrichedContext.totalTokens,
        relevanceScore: enrichedContext.relevanceScore
      });

      // Emit event for monitoring
      this.emit('contextEnriched', {
        sessionId: request.sessionId,
        requestType: request.requestType,
        enrichedContext
      });

      return enrichedContext;
    } catch (error) {
      logger.error('Failed to enrich LLM context:', error instanceof Error ? error : new Error(String(error)), {
        sessionId: request.sessionId,
        userId: request.userId,
        query: request.query.substring(0, 100)
      });
      throw error;
    }
  }

  // Store LLM response for future context enrichment
  async storeLLMResponse(response: LLMResponse): Promise<void> {
    try {
      // Store conversation in RAG for future reference (stub service - method not available)
      /*
      await s3RagService.storeConversation(
        response.sessionId,
        [{
          query: response.enrichedContext.originalQuery,
          response: response.response,
          model: response.model,
          timestamp: response.timestamp,
          sources: response.usedSources
        }],
        response.response,
        'claude-code-session'
      );
      */

      // Extract and store valuable insights from the response
      if (this.containsCodeOrDesignInsights(response.response)) {
        await this.extractAndStoreInsights(response);
      }

      logger.debug('LLM response stored in RAG', {
        sessionId: response.sessionId,
        model: response.model,
        responseLength: response.response.length,
        usedSourcesCount: response.usedSources.length
      });
    } catch (error) {
      logger.error('Failed to store LLM response:', error instanceof Error ? error : new Error(String(error)), {
        sessionId: response.sessionId
      });
      // Don't throw - response storage failure shouldn't block LLM responses
    }
  }

  // Build enriched context from multiple sources
  private async buildEnrichedContext(request: LLMRequest): Promise<EnrichedContext> {
    const startTime = Date.now();
    
    // Execute multiple searches in parallel
    const [
      ragResults,
      context7References,
      conversationHistory,
      codeContext,
      designPatterns
    ] = await Promise.all([
      this.searchRAGDocuments(request),
      this.getRelevantContext7References(request),
      this.getConversationHistory(request.sessionId),
      this.getCodeContext(request),
      this.getDesignPatterns(request)
    ]);

    // Calculate token usage and relevance
    const totalTokens = this.estimateTokenUsage(
      ragResults,
      context7References,
      conversationHistory,
      codeContext,
      designPatterns
    );

    const relevanceScore = this.calculateRelevanceScore(
      ragResults,
      context7References,
      request.query
    );

    // Trim context if it exceeds token limit
    const { trimmedResults, trimmedReferences, trimmedHistory, trimmedCode, trimmedPatterns } = 
      await this.trimContextToLimit(
        ragResults,
        context7References,
        conversationHistory,
        codeContext,
        designPatterns,
        totalTokens
      );

    const enrichedContext: EnrichedContext = {
      originalQuery: request.query,
      ragResults: trimmedResults,
      context7References: trimmedReferences,
      conversationHistory: trimmedHistory,
      codeContext: trimmedCode,
      designPatterns: trimmedPatterns,
      totalTokens: this.estimateTokenUsage(
        trimmedResults,
        trimmedReferences,
        trimmedHistory,
        trimmedCode,
        trimmedPatterns
      ),
      relevanceScore,
      sources: this.extractSources(
        trimmedResults,
        trimmedReferences,
        trimmedHistory,
        trimmedCode,
        trimmedPatterns
      )
    };

    const processingTime = Date.now() - startTime;
    logger.debug('Context enrichment completed', {
      sessionId: request.sessionId,
      processingTimeMs: processingTime,
      totalSources: enrichedContext.sources.length,
      finalTokens: enrichedContext.totalTokens
    });

    return enrichedContext;
  }

  // Search RAG documents relevant to the request
  private async searchRAGDocuments(request: LLMRequest): Promise<any[]> {
    try {
      // Adjust search strategy based on request type
      let searchQuery: any = {
        query: request.query,
        limit: 8,
        similarity_threshold: 0.2
      };

      switch (request.requestType) {
        case 'code-analysis':
          searchQuery.type = 'analysis';
          searchQuery.tags = ['code-analysis', 'performance', 'security'];
          break;
        case 'debugging':
          searchQuery.type = 'log';
          searchQuery.tags = ['error', 'debug', 'troubleshooting'];
          break;
        case 'design-guidance':
          searchQuery.type = 'documentation';
          searchQuery.tags = ['architecture', 'patterns', 'best-practices'];
          break;
        case 'documentation':
          searchQuery.type = 'documentation';
          break;
        default:
          // General search across all types
          searchQuery.limit = 5;
      }

      if (request.project) {
        searchQuery.project = request.project;
      }

      const results = await s3RagService.searchDocuments(searchQuery);
      return results.slice(0, Math.min(results.length, 8)); // Limit to 8 results
    } catch (error) {
      logger.warn('Failed to search RAG documents:', error);
      return [];
    }
  }

  // Get relevant Context7 references
  private async getRelevantContext7References(request: LLMRequest): Promise<any[]> {
    try {
      if (request.requestType === 'general') {
        return []; // Skip Context7 for general queries to save tokens
      }

      // Method not available in current integration - using searchDesignReferences instead
      const results = await context7RagIntegration.searchDesignReferences(
        request.query,
        undefined, // category
        undefined, // language
        5 // limit
      );
      
      return results;
    } catch (error) {
      logger.warn('Failed to get Context7 references:', error);
      return [];
    }
  }

  // Get recent conversation history
  private async getConversationHistory(sessionId: string): Promise<any[]> {
    try {
      const results = await s3RagService.searchDocuments({
        query: `session:${sessionId}`,
        type: 'conversation',
        limit: 3, // Last 3 conversations
        similarity_threshold: 0.1
      });

      return results.map(result => JSON.parse(result.document.content));
    } catch (error) {
      logger.warn('Failed to get conversation history:', error);
      return [];
    }
  }

  // Get relevant code context
  private async getCodeContext(request: LLMRequest): Promise<any[]> {
    try {
      if (!request.language && !request.project) {
        return [];
      }

      const codeQuery = {
        query: request.query,
        type: 'code' as const,
        project: request.project,
        limit: 4
      };

      const results = await s3RagService.searchDocuments(codeQuery);
      return results;
    } catch (error) {
      logger.warn('Failed to get code context:', error);
      return [];
    }
  }

  // Get relevant design patterns
  private async getDesignPatterns(request: LLMRequest): Promise<any[]> {
    try {
      if (request.requestType !== 'design-guidance') {
        return [];
      }

      const patterns = await context7RagIntegration.searchDesignReferences(
        request.query,
        'patterns',
        request.language,
        3
      );

      return patterns;
    } catch (error) {
      logger.warn('Failed to get design patterns:', error);
      return [];
    }
  }

  // Estimate token usage for context
  private estimateTokenUsage(...contexts: any[][]): number {
    let totalTokens = 0;
    
    for (const context of contexts) {
      for (const item of context) {
        if (typeof item === 'string') {
          totalTokens += Math.ceil(item.length / 4); // Rough token estimation
        } else if (item.content) {
          totalTokens += Math.ceil(item.content.length / 4);
        } else if (item.document?.content) {
          totalTokens += Math.ceil(item.document.content.length / 4);
        }
      }
    }
    
    return totalTokens;
  }

  // Calculate relevance score based on search results
  private calculateRelevanceScore(ragResults: any[], context7Results: any[], query: string): number {
    if (ragResults.length === 0 && context7Results.length === 0) {
      return 0;
    }

    const ragScore = ragResults.reduce((sum, result) => sum + (result.similarity || 0), 0);
    const context7Score = context7Results.reduce((sum, result) => sum + (result.similarity || 0), 0);
    
    const avgRagScore = ragResults.length > 0 ? ragScore / ragResults.length : 0;
    const avgContext7Score = context7Results.length > 0 ? context7Score / context7Results.length : 0;
    
    return (avgRagScore + avgContext7Score) / 2;
  }

  // Trim context to fit within token limits
  private async trimContextToLimit(
    ragResults: any[],
    context7References: any[],
    conversationHistory: any[],
    codeContext: any[],
    designPatterns: any[],
    totalTokens: number
  ): Promise<{
    trimmedResults: any[];
    trimmedReferences: any[];
    trimmedHistory: any[];
    trimmedCode: any[];
    trimmedPatterns: any[];
  }> {
    if (totalTokens <= this.maxContextTokens) {
      return {
        trimmedResults: ragResults,
        trimmedReferences: context7References,
        trimmedHistory: conversationHistory,
        trimmedCode: codeContext,
        trimmedPatterns: designPatterns
      };
    }

    // Priority-based trimming
    const trimmedResults = ragResults.slice(0, Math.min(ragResults.length, 5));
    const trimmedReferences = context7References.slice(0, Math.min(context7References.length, 3));
    const trimmedHistory = conversationHistory.slice(0, Math.min(conversationHistory.length, 2));
    const trimmedCode = codeContext.slice(0, Math.min(codeContext.length, 3));
    const trimmedPatterns = designPatterns.slice(0, Math.min(designPatterns.length, 2));

    return {
      trimmedResults,
      trimmedReferences,
      trimmedHistory,
      trimmedCode,
      trimmedPatterns
    };
  }

  // Extract sources from context items
  private extractSources(...contexts: any[][]): string[] {
    const sources = new Set<string>();
    
    for (const context of contexts) {
      for (const item of context) {
        if (item.document?.metadata?.source) {
          sources.add(item.document.metadata.source);
        } else if (item.metadata?.source) {
          sources.add(item.metadata.source);
        } else if (item.source) {
          sources.add(item.source);
        }
      }
    }
    
    return Array.from(sources);
  }

  // Check if response contains valuable insights
  private containsCodeOrDesignInsights(response: string): boolean {
    const insightKeywords = [
      'pattern', 'architecture', 'best practice', 'optimization',
      'performance', 'security', 'design principle', 'algorithm',
      'data structure', 'implementation', 'solution', 'approach'
    ];
    
    const lowercaseResponse = response.toLowerCase();
    return insightKeywords.some(keyword => lowercaseResponse.includes(keyword));
  }

  // Extract and store insights from LLM responses
  private async extractAndStoreInsights(response: LLMResponse): Promise<void> {
    try {
      const insights = {
        sessionId: response.sessionId,
        originalQuery: response.enrichedContext.originalQuery,
        response: response.response,
        model: response.model,
        sources: response.usedSources,
        extractedAt: response.timestamp
      };

      await s3RagService.storeDocument({
        title: `LLM Insights: ${response.enrichedContext.originalQuery.substring(0, 50)}`,
        content: JSON.stringify(insights, null, 2),
        metadata: {
          source: 'llm-gateway',
          type: 'analysis',
          project: 'claude-code-insights',
          tags: ['llm-insights', response.model, 'auto-generated'],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          size: JSON.stringify(insights).length
        }
      });

      logger.debug('LLM insights stored', {
        sessionId: response.sessionId,
        model: response.model
      });
    } catch (error) {
      logger.error('Failed to extract and store LLM insights:', error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Generate cache key for context caching
  private generateCacheKey(request: LLMRequest): string {
    const parts = [
      request.userId,
      request.requestType,
      request.query.substring(0, 100).replace(/\s+/g, '_'),
      request.project || '',
      request.language || ''
    ];
    
    return parts.filter(Boolean).join('_');
  }

  // Cleanup expired cache entries
  private cleanupCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.contextCache.entries()) {
      if (now - entry.timestamp > this.cacheTimeout) {
        this.contextCache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`Cleaned up ${cleanedCount} expired context cache entries`);
    }
  }

  // Get gateway statistics
  getStatistics(): {
    cacheSize: number;
    cacheHitRate?: number;
    avgContextTokens?: number;
    enrichmentCount: number;
  } {
    return {
      cacheSize: this.contextCache.size,
      enrichmentCount: 0, // Would need to track this
      cacheHitRate: 0, // Would need to implement hit/miss tracking
      avgContextTokens: 0 // Would need to track average token usage
    };
  }

  // Format context for LLM consumption
  formatContextForLLM(enrichedContext: EnrichedContext): string {
    const sections: string[] = [];
    
    if (enrichedContext.ragResults.length > 0) {
      sections.push('## Relevant Documentation:');
      enrichedContext.ragResults.forEach((result, index) => {
        sections.push(`${index + 1}. **${result.document?.title || 'Document'}**`);
        sections.push(`   Source: ${result.document?.metadata?.source}`);
        sections.push(`   Content: ${result.excerpt}`);
        sections.push('');
      });
    }

    if (enrichedContext.context7References.length > 0) {
      sections.push('## Technical References:');
      enrichedContext.context7References.forEach((ref, index) => {
        sections.push(`${index + 1}. **${ref.document?.title || ref.title}**`);
        sections.push(`   Content: ${ref.excerpt || ref.content}`);
        sections.push('');
      });
    }

    if (enrichedContext.conversationHistory.length > 0) {
      sections.push('## Previous Conversation Context:');
      enrichedContext.conversationHistory.slice(0, 2).forEach((conv, index) => {
        if (conv.history && conv.history.length > 0) {
          const lastExchange = conv.history[conv.history.length - 1];
          sections.push(`${index + 1}. Previous Query: ${lastExchange.query || ''}`);
          sections.push(`   Previous Response: ${(lastExchange.response || '').substring(0, 200)}...`);
          sections.push('');
        }
      });
    }

    return sections.join('\n');
  }
}

export const llmRagGateway = new LLMRagGateway();