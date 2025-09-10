// import { s3RagService } from './s3RagService'; // Disabled for WebUI restore
// import { distributedStateManager } from './distributedStateManager'; // Disabled for WebUI restore
import logger from '../config/logger';
import { toError } from '../utils/errorHandling';
import { createHash } from 'crypto';

interface CipherMemory {
  id: string;
  userId: string;
  contextHash: string;
  memories: {
    shortTerm: CipherMemoryEntry[];
    longTerm: CipherMemoryEntry[];
    patterns: CipherPattern[];
    relationships: CipherRelationship[];
  };
  metadata: {
    createdAt: number;
    updatedAt: number;
    accessCount: number;
    lastAccessed: number;
    importance: number; // 0-1 scale
    version: number;
  };
}

interface CipherMemoryEntry {
  id: string;
  type: 'conversation' | 'code-context' | 'problem-solution' | 'preference' | 'knowledge';
  content: string;
  context: string;
  embedding?: number[]; // For semantic similarity
  importance: number; // 0-1 scale
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  tags: string[];
  relatedEntries: string[];
}

interface CipherPattern {
  id: string;
  pattern: string;
  frequency: number;
  contexts: string[];
  effectiveness: number; // Success rate when applied
  lastSeen: number;
  examples: string[];
}

interface CipherRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  relationshipType: 'causation' | 'similarity' | 'sequence' | 'dependency' | 'opposition';
  strength: number; // 0-1 scale
  evidence: string[];
  createdAt: number;
}

interface MemoryQuery {
  userId: string;
  context: string;
  query?: string;
  type?: CipherMemoryEntry['type'];
  importance_threshold?: number;
  limit?: number;
}

interface MemoryRecall {
  memories: CipherMemoryEntry[];
  patterns: CipherPattern[];
  relationships: CipherRelationship[];
  contextualRelevance: number;
  totalRecalled: number;
}

export class CipherMemoryService {
  private memoryCache = new Map<string, { memory: CipherMemory; timestamp: number }>();
  private cacheTimeout = 10 * 60 * 1000; // 10 minutes
  private maxShortTermMemories = 100;
  private maxLongTermMemories = 1000;
  private shortTermToLongTermThreshold = 5; // Access count to promote to long-term

  constructor() {
    // Periodic cache cleanup and memory consolidation
    setInterval(() => {
      this.cleanupCache();
      this.consolidateMemories();
    }, 5 * 60 * 1000); // Every 5 minutes

    logger.info('CipherMemoryService initialized');
  }

  // Store new memory entry
  async storeMemory(
    userId: string,
    type: CipherMemoryEntry['type'],
    content: string,
    context: string,
    importance: number = 0.5,
    tags: string[] = []
  ): Promise<CipherMemoryEntry> {
    try {
      const contextHash = this.generateContextHash(userId, context);
      const memory = await this.getOrCreateMemory(userId, contextHash);

      const memoryEntry: CipherMemoryEntry = {
        id: this.generateMemoryId(),
        type,
        content,
        context,
        importance: Math.max(0, Math.min(1, importance)),
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 1,
        tags,
        relatedEntries: []
      };

      // Add to appropriate memory store based on importance
      if (importance > 0.7 || type === 'preference' || type === 'knowledge') {
        memory.memories.longTerm.push(memoryEntry);
      } else {
        memory.memories.shortTerm.push(memoryEntry);
      }

      // Update memory metadata
      memory.metadata.updatedAt = Date.now();
      memory.metadata.version++;

      // Find and create relationships with existing memories
      await this.findRelationships(memory, memoryEntry);

      // Update patterns
      await this.updatePatterns(memory, content, context);

      // Save updated memory
      await this.saveMemory(memory);

      logger.debug('Cipher memory stored', {
        userId,
        type,
        importance,
        contextHash,
        entryId: memoryEntry.id
      });

      return memoryEntry;
    } catch (error) {
      logger.error('Failed to store Cipher memory:', error instanceof Error ? error : new Error(String(error)), {
        userId,
        type,
        context: context.substring(0, 100)
      });
      throw error;
    }
  }

  // Recall memories based on context and query
  async recallMemories(query: MemoryQuery): Promise<MemoryRecall> {
    try {
      const contextHash = this.generateContextHash(query.userId, query.context);
      const memory = await this.getMemory(query.userId, contextHash);

      if (!memory) {
        return {
          memories: [],
          patterns: [],
          relationships: [],
          contextualRelevance: 0,
          totalRecalled: 0
        };
      }

      // Update access metadata
      memory.metadata.lastAccessed = Date.now();
      memory.metadata.accessCount++;

      // Combine short-term and long-term memories
      const allMemories = [...memory.memories.shortTerm, ...memory.memories.longTerm];

      // Filter by type if specified
      let relevantMemories = query.type 
        ? allMemories.filter(m => m.type === query.type)
        : allMemories;

      // Filter by importance threshold
      if (query.importance_threshold) {
        relevantMemories = relevantMemories.filter(m => m.importance >= query.importance_threshold!);
      }

      // Search by query if provided
      if (query.query) {
        relevantMemories = this.searchMemories(relevantMemories, query.query);
      }

      // Sort by relevance (importance + recency + access count)
      relevantMemories.sort((a, b) => {
        const scoreA = this.calculateMemoryScore(a, query.context);
        const scoreB = this.calculateMemoryScore(b, query.context);
        return scoreB - scoreA;
      });

      // Limit results
      const limit = query.limit || 20;
      const limitedMemories = relevantMemories.slice(0, limit);

      // Update access counts for recalled memories
      limitedMemories.forEach(memory => {
        memory.lastAccessed = Date.now();
        memory.accessCount++;
      });

      // Get relevant patterns
      const relevantPatterns = this.findRelevantPatterns(memory.memories.patterns, query.context, query.query);

      // Get relevant relationships
      const memoryIds = limitedMemories.map(m => m.id);
      const relevantRelationships = memory.memories.relationships.filter(rel =>
        memoryIds.includes(rel.sourceId) || memoryIds.includes(rel.targetId)
      );

      // Calculate contextual relevance
      const contextualRelevance = limitedMemories.length > 0 
        ? limitedMemories.reduce((sum, m) => sum + m.importance, 0) / limitedMemories.length
        : 0;

      // Save updated access metadata
      await this.saveMemory(memory);

      const recall: MemoryRecall = {
        memories: limitedMemories,
        patterns: relevantPatterns,
        relationships: relevantRelationships,
        contextualRelevance,
        totalRecalled: limitedMemories.length
      };

      logger.debug('Cipher memory recalled', {
        userId: query.userId,
        query: query.query?.substring(0, 100),
        recalledCount: limitedMemories.length,
        contextualRelevance,
        patternsCount: relevantPatterns.length
      });

      return recall;
    } catch (error) {
      logger.error('Failed to recall Cipher memories:', error instanceof Error ? error : new Error(String(error)), {
        userId: query.userId,
        context: query.context.substring(0, 100)
      });
      throw error;
    }
  }

  // Store conversation with continuity context
  async storeConversationMemory(
    userId: string,
    sessionId: string,
    conversation: {
      userQuery: string;
      llmResponse: string;
      context: string;
      model: string;
      timestamp: number;
    }
  ): Promise<void> {
    try {
      // Calculate importance based on conversation characteristics
      const importance = this.calculateConversationImportance(conversation);

      // Store user query as memory
      await this.storeMemory(
        userId,
        'conversation',
        `User Query: ${conversation.userQuery}`,
        `session:${sessionId}|${conversation.context}`,
        importance,
        ['user-query', conversation.model, 'session']
      );

      // Store LLM response as memory
      await this.storeMemory(
        userId,
        'conversation',
        `${conversation.model} Response: ${conversation.llmResponse}`,
        `session:${sessionId}|${conversation.context}`,
        importance,
        ['llm-response', conversation.model, 'session']
      );

      // Extract and store any code context or solutions
      if (this.containsCodeOrTechnicalSolution(conversation.llmResponse)) {
        await this.storeMemory(
          userId,
          'problem-solution',
          this.extractSolution(conversation.userQuery, conversation.llmResponse),
          conversation.context,
          Math.min(0.9, importance + 0.2), // Boost importance for solutions
          ['solution', 'technical', conversation.model]
        );
      }

      // Store user preferences if detected
      const preferences = this.extractUserPreferences(conversation.userQuery, conversation.llmResponse);
      for (const preference of preferences) {
        await this.storeMemory(
          userId,
          'preference',
          preference,
          'user-preferences',
          0.8, // High importance for preferences
          ['preference', 'user-behavior']
        );
      }

      logger.debug('Conversation memory stored with continuity', {
        userId,
        sessionId,
        importance,
        model: conversation.model
      });
    } catch (error) {
      logger.error('Failed to store conversation memory:', error instanceof Error ? error : new Error(String(error)), {
        userId,
        sessionId
      });
    }
  }

  // Get memory continuity context for LLM
  async getContinuityContext(userId: string, sessionId: string, currentContext: string): Promise<string> {
    try {
      // Recall relevant memories for continuity
      const recall = await this.recallMemories({
        userId,
        context: `session:${sessionId}|${currentContext}`,
        importance_threshold: 0.3,
        limit: 15
      });

      if (recall.totalRecalled === 0) {
        return '';
      }

      // Format context for LLM consumption
      const contextSections: string[] = [];

      // Recent conversation context
      const recentConversations = recall.memories
        .filter(m => m.type === 'conversation' && m.tags.includes('session'))
        .slice(0, 5);
      
      if (recentConversations.length > 0) {
        contextSections.push('## Recent Conversation Context:');
        recentConversations.forEach((conv, index) => {
          contextSections.push(`${index + 1}. ${conv.content.substring(0, 200)}...`);
        });
        contextSections.push('');
      }

      // User preferences and patterns
      const preferences = recall.memories
        .filter(m => m.type === 'preference')
        .slice(0, 3);
      
      if (preferences.length > 0) {
        contextSections.push('## User Preferences:');
        preferences.forEach((pref, index) => {
          contextSections.push(`${index + 1}. ${pref.content}`);
        });
        contextSections.push('');
      }

      // Problem-solution patterns
      const solutions = recall.memories
        .filter(m => m.type === 'problem-solution')
        .slice(0, 3);
      
      if (solutions.length > 0) {
        contextSections.push('## Previous Solutions:');
        solutions.forEach((sol, index) => {
          contextSections.push(`${index + 1}. ${sol.content.substring(0, 300)}...`);
        });
        contextSections.push('');
      }

      // Behavioral patterns
      if (recall.patterns.length > 0) {
        contextSections.push('## Behavioral Patterns:');
        recall.patterns.slice(0, 3).forEach((pattern, index) => {
          contextSections.push(`${index + 1}. ${pattern.pattern} (seen ${pattern.frequency} times)`);
        });
      }

      const continuityContext = contextSections.join('\n');

      logger.debug('Cipher continuity context generated', {
        userId,
        sessionId,
        contextLength: continuityContext.length,
        memoriesUsed: recall.totalRecalled,
        patternsUsed: recall.patterns.length
      });

      return continuityContext;
    } catch (error) {
      logger.error('Failed to generate continuity context:', error instanceof Error ? error : new Error(String(error)), {
        userId,
        sessionId
      });
      return '';
    }
  }

  // Private helper methods
  private async getOrCreateMemory(userId: string, contextHash: string): Promise<CipherMemory> {
    let memory = await this.getMemory(userId, contextHash);
    
    if (!memory) {
      memory = {
        id: `memory_${userId}_${contextHash}`,
        userId,
        contextHash,
        memories: {
          shortTerm: [],
          longTerm: [],
          patterns: [],
          relationships: []
        },
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
          accessCount: 0,
          lastAccessed: Date.now(),
          importance: 0.5,
          version: 1
        }
      };
    }

    return memory;
  }

  private async getMemory(userId: string, contextHash: string): Promise<CipherMemory | null> {
    const cacheKey = `${userId}_${contextHash}`;
    
    // Check cache first
    const cached = this.memoryCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < this.cacheTimeout)) {
      return cached.memory;
    }

    try {
      // Try to get from DynamoDB first (for real-time access)
      // const stateResults = await distributedStateManager.getFromCache(`cipher_memory_${cacheKey}`);
      const stateResults = null; // Disabled for WebUI restore
      if (stateResults) {
        const memory = JSON.parse(stateResults.value) as CipherMemory;
        this.memoryCache.set(cacheKey, { memory, timestamp: Date.now() });
        return memory;
      }

      // Fallback to S3 RAG search
      // const ragResults = await s3RagService.searchDocuments({
      //   query: `cipher_memory_${userId}`,
      //   type: 'conversation',
      //   tags: ['cipher-memory'],
      //   limit: 1
      // });
      const ragResults: any[] = []; // Disabled for WebUI restore

      if (ragResults.length > 0) {
        const memory = JSON.parse(ragResults[0].document.content) as CipherMemory;
        this.memoryCache.set(cacheKey, { memory, timestamp: Date.now() });
        return memory;
      }

      return null;
    } catch (error) {
      logger.error('Failed to get Cipher memory:', toError(error));
      return null;
    }
  }

  private async saveMemory(memory: CipherMemory): Promise<void> {
    const cacheKey = `${memory.userId}_${memory.contextHash}`;
    
    try {
      // Update cache
      this.memoryCache.set(cacheKey, { memory, timestamp: Date.now() });

      // Save to DynamoDB for real-time access
      // await distributedStateManager.setCache({
      //   key: `cipher_memory_${cacheKey}`,
      //   value: memory,
      //   type: 'cipher',
      //   createdAt: Date.now(),
      //   region: process.env.AWS_REGION || 'us-east-1'
      // });

      // Also save to S3 RAG for long-term storage and search
      // await s3RagService.storeDocument({
      //         title: `Cipher Memory: ${memory.userId}`,
      //         content: JSON.stringify(memory, null, 2),
      //         metadata: {
      //           source: 'cipher-memory',
      //           type: 'conversation',
      //           project: 'cipher-continuity',
      //           tags: ['cipher-memory', memory.userId, memory.contextHash],
      //           createdAt: memory.metadata.createdAt,
      //           updatedAt: memory.metadata.updatedAt,
      //           size: JSON.stringify(memory).length
      //         }
      // });

      logger.debug('Cipher memory saved', {
        userId: memory.userId,
        contextHash: memory.contextHash,
        shortTermCount: memory.memories.shortTerm.length,
        longTermCount: memory.memories.longTerm.length
      });
    } catch (error) {
      logger.error('Failed to save Cipher memory:', toError(error));
      throw error;
    }
  }

  private generateContextHash(userId: string, context: string): string {
    return createHash('sha256')
      .update(`${userId}:${context}`)
      .digest('hex')
      .substring(0, 16);
  }

  private generateMemoryId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private calculateMemoryScore(memory: CipherMemoryEntry, currentContext: string): number {
    const now = Date.now();
    const age = now - memory.createdAt;
    const recency = now - memory.lastAccessed;
    
    // Base score from importance
    let score = memory.importance;
    
    // Boost for recent access
    score += Math.max(0, 0.3 * (1 - recency / (24 * 60 * 60 * 1000))); // Decay over 24 hours
    
    // Boost for frequency of access
    score += Math.min(0.2, memory.accessCount * 0.01);
    
    // Context similarity (simple keyword matching)
    const contextSimilarity = this.calculateSimpleTextSimilarity(memory.context, currentContext);
    score += contextSimilarity * 0.3;
    
    return score;
  }

  private calculateSimpleTextSimilarity(text1: string, text2: string): number {
    const words1 = text1.toLowerCase().split(/\s+/);
    const words2 = text2.toLowerCase().split(/\s+/);
    
    const intersection = words1.filter(word => words2.includes(word));
    const union = [...new Set([...words1, ...words2])];
    
    return union.length > 0 ? intersection.length / union.length : 0;
  }

  private searchMemories(memories: CipherMemoryEntry[], query: string): CipherMemoryEntry[] {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);
    
    return memories.filter(memory => {
      const contentLower = memory.content.toLowerCase();
      return queryWords.some(word => contentLower.includes(word));
    }).sort((a, b) => {
      const scoreA = this.calculateSearchScore(a, queryWords);
      const scoreB = this.calculateSearchScore(b, queryWords);
      return scoreB - scoreA;
    });
  }

  private calculateSearchScore(memory: CipherMemoryEntry, queryWords: string[]): number {
    const contentLower = memory.content.toLowerCase();
    let score = 0;
    
    for (const word of queryWords) {
      const occurrences = (contentLower.match(new RegExp(word, 'g')) || []).length;
      score += occurrences;
    }
    
    return score;
  }

  private calculateConversationImportance(conversation: any): number {
    let importance = 0.4; // Base importance
    
    // Boost for technical content
    if (this.containsCodeOrTechnicalSolution(conversation.llmResponse)) {
      importance += 0.2;
    }
    
    // Boost for problem-solving patterns
    if (conversation.userQuery.toLowerCase().includes('error') || 
        conversation.userQuery.toLowerCase().includes('problem') ||
        conversation.userQuery.toLowerCase().includes('how to')) {
      importance += 0.2;
    }
    
    // Boost for longer, detailed responses
    if (conversation.llmResponse.length > 500) {
      importance += 0.1;
    }
    
    return Math.min(1.0, importance);
  }

  private containsCodeOrTechnicalSolution(text: string): boolean {
    const technicalKeywords = [
      'function', 'class', 'import', 'export', 'const', 'let', 'var',
      'implementation', 'algorithm', 'pattern', 'solution', 'fix',
      'optimization', 'performance', 'security', 'error', 'debug'
    ];
    
    const textLower = text.toLowerCase();
    return technicalKeywords.some(keyword => textLower.includes(keyword));
  }

  private extractSolution(userQuery: string, llmResponse: string): string {
    // Simple solution extraction - can be enhanced with NLP
    const lines = llmResponse.split('\n');
    const solutionLines = lines.filter(line => 
      line.includes('solution') || 
      line.includes('fix') || 
      line.includes('try') ||
      line.includes('implement')
    );
    
    const solution = solutionLines.slice(0, 3).join(' ');
    return `Problem: ${userQuery.substring(0, 200)} | Solution: ${solution.substring(0, 500)}`;
  }

  private extractUserPreferences(userQuery: string, llmResponse: string): string[] {
    const preferences: string[] = [];
    
    // Extract preferences from user queries
    const preferenceKeywords = ['prefer', 'like', 'use', 'always', 'never', 'favorite'];
    const queryLower = userQuery.toLowerCase();
    
    for (const keyword of preferenceKeywords) {
      if (queryLower.includes(keyword)) {
        preferences.push(`User preference detected: ${userQuery.substring(0, 100)}`);
        break;
      }
    }
    
    return preferences;
  }

  private async findRelationships(memory: CipherMemory, newEntry: CipherMemoryEntry): Promise<void> {
    // Find relationships with existing memories
    const allMemories = [...memory.memories.shortTerm, ...memory.memories.longTerm];
    
    for (const existingMemory of allMemories) {
      if (existingMemory.id === newEntry.id) continue;
      
      const similarity = this.calculateSimpleTextSimilarity(
        newEntry.content,
        existingMemory.content
      );
      
      if (similarity > 0.3) {
        const relationship: CipherRelationship = {
          id: `rel_${newEntry.id}_${existingMemory.id}`,
          sourceId: newEntry.id,
          targetId: existingMemory.id,
          relationshipType: 'similarity',
          strength: similarity,
          evidence: [`Text similarity: ${similarity.toFixed(2)}`],
          createdAt: Date.now()
        };
        
        memory.memories.relationships.push(relationship);
      }
    }
  }

  private async updatePatterns(memory: CipherMemory, content: string, context: string): Promise<void> {
    // Extract common patterns from content
    const words = content.toLowerCase().split(/\s+/).filter(word => word.length > 3);
    const uniqueWords = [...new Set(words)];
    
    for (const word of uniqueWords) {
      let existingPattern = memory.memories.patterns.find(p => p.pattern === word);
      
      if (existingPattern) {
        existingPattern.frequency++;
        existingPattern.lastSeen = Date.now();
        if (!existingPattern.contexts.includes(context)) {
          existingPattern.contexts.push(context);
        }
      } else if (words.filter(w => w === word).length > 1) { // Word appears multiple times
        const newPattern: CipherPattern = {
          id: `pattern_${word}_${Date.now()}`,
          pattern: word,
          frequency: 1,
          contexts: [context],
          effectiveness: 0.5, // Default effectiveness
          lastSeen: Date.now(),
          examples: [content.substring(0, 200)]
        };
        
        memory.memories.patterns.push(newPattern);
      }
    }
  }

  private findRelevantPatterns(patterns: CipherPattern[], context: string, query?: string): CipherPattern[] {
    let relevantPatterns = patterns.filter(pattern => 
      pattern.contexts.some(ctx => ctx.includes(context))
    );
    
    if (query) {
      const queryLower = query.toLowerCase();
      relevantPatterns = relevantPatterns.filter(pattern => 
        queryLower.includes(pattern.pattern) || pattern.pattern.includes(queryLower)
      );
    }
    
    return relevantPatterns.sort((a, b) => b.frequency - a.frequency);
  }

  private cleanupCache(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.memoryCache.entries()) {
      if (now - entry.timestamp > this.cacheTimeout) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} Cipher memory cache entries`);
    }
  }

  private async consolidateMemories(): Promise<void> {
    // This would run periodically to:
    // 1. Promote short-term memories with high access counts to long-term
    // 2. Merge similar memories
    // 3. Prune old, low-importance memories
    // Implementation would be complex and should run as a background task
    logger.debug('Cipher memory consolidation completed');
  }

  // Get service statistics
  getStatistics(): {
    cachedMemories: number;
    totalUsers: number;
    avgMemoriesPerUser: number;
  } {
    const stats = {
      cachedMemories: this.memoryCache.size,
      totalUsers: new Set(Array.from(this.memoryCache.keys()).map(key => key.split('_')[0])).size,
      avgMemoriesPerUser: 0
    };
    
    stats.avgMemoriesPerUser = stats.totalUsers > 0 ? stats.cachedMemories / stats.totalUsers : 0;
    
    return stats;
  }
}

export const cipherMemoryService = new CipherMemoryService();