import { s3RagService } from './s3RagService';
import logger from '../config/logger';

interface Context7Request {
  type: 'library' | 'framework' | 'pattern' | 'best-practice' | 'api-reference';
  query: string;
  language?: string;
  framework?: string;
  project?: string;
}

interface Context7Response {
  query: string;
  references: {
    title: string;
    content: string;
    source: string;
    type: string;
    relevance: number;
  }[];
  summary: string;
  cached: boolean;
  timestamp: number;
}

interface DesignReference {
  id: string;
  title: string;
  category: 'architecture' | 'patterns' | 'libraries' | 'frameworks' | 'apis' | 'best-practices';
  content: string;
  metadata: {
    language?: string;
    framework?: string;
    version?: string;
    source: string;
    url?: string;
    tags: string[];
  };
  relevanceScore: number;
  lastUpdated: number;
}

export class Context7RagIntegration {
  private cacheEnabled: boolean;
  private cacheExpiryHours: number;

  constructor() {
    this.cacheEnabled = process.env.ENABLE_CONTEXT7_CACHE !== 'false';
    this.cacheExpiryHours = parseInt(process.env.CONTEXT7_CACHE_HOURS || '24');
    
    logger.info('Context7RagIntegration initialized', {
      cacheEnabled: this.cacheEnabled,
      cacheExpiryHours: this.cacheExpiryHours
    });
  }

  // Main entry point for Context7 reference collection
  async collectReferences(request: Context7Request): Promise<Context7Response> {
    try {
      logger.debug('Context7 reference collection requested', request);

      // Check if we have cached references first
      if (this.cacheEnabled) {
        const cached = await this.getCachedReferences(request);
        if (cached) {
          logger.debug('Returning cached Context7 references');
          return cached;
        }
      }

      // If no cache or cache expired, collect fresh references
      const references = await this.collectFreshReferences(request);
      
      // Store references in S3 RAG for future use
      if (references.references.length > 0) {
        await this.storeReferencesInRag(request, references);
      }

      return references;
    } catch (error) {
      logger.error('Failed to collect Context7 references:', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Check for cached references in S3 RAG
  private async getCachedReferences(request: Context7Request): Promise<Context7Response | null> {
    try {
      const cacheKey = this.generateCacheKey(request);
      const searchResults = await s3RagService.searchDocuments({
        query: cacheKey,
        type: 'documentation',
        tags: ['context7-cache'],
        limit: 1
      });

      if (searchResults.length === 0) {
        return null;
      }

      const cachedDoc = searchResults[0].document;
      const cacheAge = Date.now() - cachedDoc.metadata.createdAt;
      const maxAge = this.cacheExpiryHours * 60 * 60 * 1000;

      if (cacheAge > maxAge) {
        // Cache expired, clean up
        await s3RagService.deleteDocument(cachedDoc.id);
        return null;
      }

      // Parse and return cached response
      const cachedData = JSON.parse(cachedDoc.content);
      return {
        ...cachedData,
        cached: true,
        timestamp: cachedDoc.metadata.createdAt
      };
    } catch (error) {
      logger.warn('Failed to get cached Context7 references:', error);
      return null;
    }
  }

  // Collect fresh references (this is where Context7 MCP would be called)
  private async collectFreshReferences(request: Context7Request): Promise<Context7Response> {
    logger.debug('Collecting fresh Context7 references', request);

    // This is a placeholder for actual Context7 MCP integration
    // In real implementation, this would call the Context7 MCP server
    const mockReferences = await this.mockContext7Call(request);

    const response: Context7Response = {
      query: request.query,
      references: mockReferences,
      summary: this.generateSummary(mockReferences),
      cached: false,
      timestamp: Date.now()
    };

    return response;
  }

  // Store collected references in S3 RAG for future searches
  private async storeReferencesInRag(
    request: Context7Request, 
    response: Context7Response
  ): Promise<void> {
    try {
      const cacheKey = this.generateCacheKey(request);
      
      // Store the complete response as a cached document
      await s3RagService.storeDocument({
        title: `Context7 References: ${request.query}`,
        content: JSON.stringify(response, null, 2),
        metadata: {
          source: 'context7',
          type: 'documentation',
          language: request.language,
          project: request.project || 'default',
          tags: ['context7-cache', request.type, cacheKey],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          size: JSON.stringify(response).length
        }
      });

      // Also store individual references as separate searchable documents
      for (const ref of response.references) {
        await s3RagService.storeDocument({
          title: ref.title,
          content: ref.content,
          metadata: {
            source: ref.source,
            type: 'documentation',
            language: request.language,
            project: request.project || 'default',
            tags: ['context7-reference', request.type, ...(ref.source ? [ref.source] : [])],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            size: ref.content.length
          }
        });
      }

      logger.debug(`Stored ${response.references.length + 1} Context7 documents in RAG`);
    } catch (error) {
      logger.error('Failed to store Context7 references in RAG:', error instanceof Error ? error : new Error(String(error)));
      // Don't throw - reference collection should succeed even if storage fails
    }
  }

  // Search existing references for design assistance
  async searchDesignReferences(
    query: string, 
    category?: DesignReference['category'],
    language?: string,
    limit: number = 10
  ): Promise<DesignReference[]> {
    try {
      const searchQuery = {
        query,
        type: 'documentation' as const,
        tags: category ? [`context7-reference`, category] : ['context7-reference'],
        limit
      };

      const results = await s3RagService.searchDocuments(searchQuery);
      
      return results.map(result => ({
        id: result.document.id,
        title: result.document.title,
        category: this.mapTypeToCategory(result.document.metadata.tags),
        content: result.excerpt,
        metadata: {
          language: result.document.metadata.language,
          source: result.document.metadata.source,
          tags: result.document.metadata.tags
        },
        relevanceScore: result.similarity,
        lastUpdated: result.document.metadata.updatedAt
      }));
    } catch (error) {
      logger.error('Failed to search design references:', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Get references for specific design pattern
  async getPatternReferences(patternName: string, language?: string): Promise<DesignReference[]> {
    return this.searchDesignReferences(
      `${patternName} pattern implementation`,
      'patterns',
      language,
      5
    );
  }

  // Get library/framework references
  async getLibraryReferences(libraryName: string, version?: string): Promise<DesignReference[]> {
    const query = version 
      ? `${libraryName} ${version} documentation API`
      : `${libraryName} documentation API reference`;
    
    return this.searchDesignReferences(query, 'libraries', undefined, 8);
  }

  // Get best practices for specific technology
  async getBestPractices(technology: string, context?: string): Promise<DesignReference[]> {
    const query = context 
      ? `${technology} best practices ${context}`
      : `${technology} best practices guidelines`;
    
    return this.searchDesignReferences(query, 'best-practices', undefined, 6);
  }

  // Cleanup old Context7 cache entries
  async cleanupCache(maxAgeHours: number = 168): Promise<number> { // Default 1 week
    try {
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      let deletedCount = 0;

      const cacheDocuments = await s3RagService.searchDocuments({
        query: 'context7-cache',
        type: 'documentation',
        tags: ['context7-cache'],
        limit: 1000
      });

      for (const result of cacheDocuments) {
        if (result.document.metadata.createdAt < cutoffTime) {
          await s3RagService.deleteDocument(result.document.id);
          deletedCount++;
        }
      }

      logger.info(`Cleaned up ${deletedCount} old Context7 cache entries`);
      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup Context7 cache:', error instanceof Error ? error : new Error(String(error)));
      return 0;
    }
  }

  // Helper methods
  private generateCacheKey(request: Context7Request): string {
    const parts = [
      request.type,
      request.query.toLowerCase().replace(/\s+/g, '-'),
      request.language || '',
      request.framework || ''
    ].filter(Boolean);
    
    return parts.join('_');
  }

  private generateSummary(references: any[]): string {
    if (references.length === 0) {
      return 'No references found';
    }

    const summary = [
      `Found ${references.length} relevant references:`,
      ...references.slice(0, 3).map(ref => `- ${ref.title}`)
    ];

    if (references.length > 3) {
      summary.push(`... and ${references.length - 3} more`);
    }

    return summary.join('\n');
  }

  private mapTypeToCategory(tags: string[]): DesignReference['category'] {
    for (const tag of tags) {
      switch (tag) {
        case 'library':
        case 'libraries':
          return 'libraries';
        case 'framework':
        case 'frameworks':
          return 'frameworks';
        case 'pattern':
        case 'patterns':
          return 'patterns';
        case 'api-reference':
        case 'api':
          return 'apis';
        case 'best-practice':
        case 'best-practices':
          return 'best-practices';
        case 'architecture':
          return 'architecture';
      }
    }
    return 'libraries'; // default
  }

  // Mock Context7 call for development
  private async mockContext7Call(request: Context7Request): Promise<any[]> {
    // This would be replaced with actual Context7 MCP integration
    logger.debug('Mock Context7 call', request);
    
    return [
      {
        title: `${request.query} - Official Documentation`,
        content: `Official documentation for ${request.query}...`,
        source: 'official-docs',
        type: request.type,
        relevance: 0.95
      },
      {
        title: `${request.query} - Best Practices Guide`,
        content: `Best practices and patterns for ${request.query}...`,
        source: 'community-guide',
        type: 'best-practice',
        relevance: 0.85
      }
    ];
  }

  // Get statistics
  async getStatistics(): Promise<{
    totalCachedReferences: number;
    referencesByType: Record<string, number>;
    cacheHitRate?: number;
    averageReferenceAge: number;
  }> {
    try {
      const cacheDocuments = await s3RagService.searchDocuments({
        query: 'context7',
        type: 'documentation',
        tags: ['context7-cache', 'context7-reference'],
        limit: 1000
      });

      const stats = {
        totalCachedReferences: cacheDocuments.length,
        referencesByType: {} as Record<string, number>,
        averageReferenceAge: 0
      };

      let totalAge = 0;
      for (const result of cacheDocuments) {
        const doc = result.document;
        const age = Date.now() - doc.metadata.createdAt;
        totalAge += age;

        // Count by type
        const type = doc.metadata.tags.find(tag => 
          ['library', 'framework', 'pattern', 'best-practice', 'api-reference'].includes(tag)
        ) || 'unknown';
        
        stats.referencesByType[type] = (stats.referencesByType[type] || 0) + 1;
      }

      stats.averageReferenceAge = cacheDocuments.length > 0 
        ? totalAge / cacheDocuments.length 
        : 0;

      return stats;
    } catch (error) {
      logger.error('Failed to get Context7 integration statistics:', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}

export const context7RagIntegration = new Context7RagIntegration();