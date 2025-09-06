import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { logger } from '../config/logger';
import { Readable } from 'stream';

interface RagDocument {
  id: string;
  title: string;
  content: string;
  metadata: {
    source: string;
    type: 'code' | 'documentation' | 'log' | 'conversation' | 'analysis';
    language?: string;
    project?: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    size: number;
  };
  embedding?: number[]; // For vector search (optional)
}

interface RagSearchQuery {
  query: string;
  type?: 'code' | 'documentation' | 'log' | 'conversation' | 'analysis';
  project?: string;
  tags?: string[];
  limit?: number;
  similarity_threshold?: number;
}

interface RagSearchResult {
  document: RagDocument;
  similarity: number;
  excerpt: string;
}

export class S3RagService {
  private s3Client: S3Client;
  private bucketName: string;
  private ragPrefix: string;

  constructor() {
    this.s3Client = new S3Client({ 
      region: process.env.AWS_REGION || 'us-east-1' 
    });
    this.bucketName = process.env.S3_BUCKET_NAME || 'claude-code-artifacts';
    this.ragPrefix = 'rag-documents/';
    
    logger.info('S3RagService initialized');
  }

  // Store document in S3 for RAG
  async storeDocument(document: Omit<RagDocument, 'id'>): Promise<RagDocument> {
    try {
      // Generate document ID from content hash
      const contentHash = createHash('sha256')
        .update(document.content)
        .digest('hex')
        .substring(0, 16);
      
      const docId = `${document.metadata.type}_${contentHash}_${Date.now()}`;
      
      const ragDocument: RagDocument = {
        ...document,
        id: docId,
        metadata: {
          ...document.metadata,
          updatedAt: Date.now()
        }
      };

      // Store document metadata and content
      const documentKey = `${this.ragPrefix}${docId}.json`;
      
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: documentKey,
        Body: JSON.stringify(ragDocument, null, 2),
        ContentType: 'application/json',
        Metadata: {
          'document-type': document.metadata.type,
          'document-source': document.metadata.source,
          'document-project': document.metadata.project || '',
          'document-tags': document.metadata.tags.join(','),
          'content-size': document.metadata.size.toString()
        },
        // Enable automatic server-side encryption
        ServerSideEncryption: 'AES256'
      }));

      // Also store searchable content separately for easier text search
      const contentKey = `${this.ragPrefix}content/${docId}.txt`;
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: contentKey,
        Body: document.content,
        ContentType: 'text/plain',
        Metadata: {
          'document-id': docId,
          'document-title': document.title
        },
        ServerSideEncryption: 'AES256'
      }));

      logger.debug(`RAG document stored: ${docId}`, {
        type: document.metadata.type,
        source: document.metadata.source,
        size: document.metadata.size
      });

      return ragDocument;
    } catch (error) {
      logger.error('Failed to store RAG document:', error);
      throw error;
    }
  }

  // Retrieve document by ID
  async getDocument(documentId: string): Promise<RagDocument | null> {
    try {
      const documentKey = `${this.ragPrefix}${documentId}.json`;
      
      const response = await this.s3Client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: documentKey
      }));

      if (!response.Body) {
        return null;
      }

      const documentJson = await this.streamToString(response.Body as Readable);
      return JSON.parse(documentJson) as RagDocument;
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        return null;
      }
      logger.error(`Failed to get RAG document ${documentId}:`, error);
      throw error;
    }
  }

  // Search documents by content and metadata
  async searchDocuments(query: RagSearchQuery): Promise<RagSearchResult[]> {
    try {
      // List all documents matching the filter criteria
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: this.ragPrefix,
        MaxKeys: 1000
      });

      const response = await this.s3Client.send(listCommand);
      
      if (!response.Contents) {
        return [];
      }

      // Filter documents based on metadata
      const candidateDocuments: RagDocument[] = [];
      
      for (const obj of response.Contents) {
        if (!obj.Key || !obj.Key.endsWith('.json')) continue;
        
        try {
          const docResponse = await this.s3Client.send(new GetObjectCommand({
            Bucket: this.bucketName,
            Key: obj.Key
          }));
          
          if (!docResponse.Body) continue;
          
          const docContent = await this.streamToString(docResponse.Body as Readable);
          const document = JSON.parse(docContent) as RagDocument;
          
          // Apply filters
          if (query.type && document.metadata.type !== query.type) continue;
          if (query.project && document.metadata.project !== query.project) continue;
          if (query.tags && !query.tags.some(tag => document.metadata.tags.includes(tag))) continue;
          
          candidateDocuments.push(document);
        } catch (error) {
          logger.warn(`Failed to parse document ${obj.Key}:`, error);
          continue;
        }
      }

      // Perform simple text-based similarity search
      const results: RagSearchResult[] = [];
      const queryTerms = query.query.toLowerCase().split(/\s+/).filter(term => term.length > 2);
      
      for (const document of candidateDocuments) {
        const similarity = this.calculateTextSimilarity(query.query, document);
        
        if (similarity > (query.similarity_threshold || 0.1)) {
          const excerpt = this.generateExcerpt(document.content, queryTerms);
          
          results.push({
            document,
            similarity,
            excerpt
          });
        }
      }

      // Sort by similarity and apply limit
      results.sort((a, b) => b.similarity - a.similarity);
      
      return results.slice(0, query.limit || 10);
    } catch (error) {
      logger.error('Failed to search RAG documents:', error);
      throw error;
    }
  }

  // Delete document
  async deleteDocument(documentId: string): Promise<boolean> {
    try {
      const documentKey = `${this.ragPrefix}${documentId}.json`;
      const contentKey = `${this.ragPrefix}content/${documentId}.txt`;
      
      await Promise.all([
        this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: documentKey
        })),
        this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: contentKey
        }))
      ]);

      logger.debug(`RAG document deleted: ${documentId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete RAG document ${documentId}:`, error);
      return false;
    }
  }

  // Store code analysis results for RAG
  async storeCodeAnalysis(
    filePath: string, 
    codeContent: string, 
    analysisResult: any,
    project?: string
  ): Promise<RagDocument> {
    const analysisDocument: Omit<RagDocument, 'id'> = {
      title: `Code Analysis: ${filePath}`,
      content: JSON.stringify({
        filePath,
        codeContent: codeContent.substring(0, 10000), // Limit content size
        analysis: analysisResult,
        summary: this.extractCodeSummary(analysisResult)
      }, null, 2),
      metadata: {
        source: filePath,
        type: 'analysis',
        language: this.detectLanguage(filePath),
        project: project || 'default',
        tags: ['code-analysis', 'automated', filePath.split('/').pop()?.split('.')[1] || 'unknown'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        size: codeContent.length
      }
    };

    return this.storeDocument(analysisDocument);
  }

  // Store conversation context for RAG
  async storeConversation(
    sessionId: string,
    conversationHistory: any[],
    context: string,
    project?: string
  ): Promise<RagDocument> {
    const conversationDocument: Omit<RagDocument, 'id'> = {
      title: `Conversation: ${sessionId}`,
      content: JSON.stringify({
        sessionId,
        history: conversationHistory,
        context,
        summary: this.extractConversationSummary(conversationHistory)
      }, null, 2),
      metadata: {
        source: `session:${sessionId}`,
        type: 'conversation',
        project: project || 'default',
        tags: ['conversation', 'claude-code', 'session'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        size: JSON.stringify(conversationHistory).length
      }
    };

    return this.storeDocument(conversationDocument);
  }

  // Get relevant context for Context7 integration
  async getContext7RelevantDocuments(query: string, limit: number = 5): Promise<RagSearchResult[]> {
    return this.searchDocuments({
      query,
      limit,
      similarity_threshold: 0.2,
      tags: ['code-analysis', 'conversation', 'documentation']
    });
  }

  // Helper methods
  private async streamToString(stream: Readable): Promise<string> {
    const chunks: Uint8Array[] = [];
    
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    return Buffer.concat(chunks).toString('utf-8');
  }

  private calculateTextSimilarity(query: string, document: RagDocument): number {
    const queryLower = query.toLowerCase();
    const contentLower = (document.content + ' ' + document.title).toLowerCase();
    
    // Simple keyword-based similarity
    const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);
    const contentWords = contentLower.split(/\s+/);
    
    if (queryWords.length === 0) return 0;
    
    const matches = queryWords.filter(word => contentWords.some(cWord => cWord.includes(word)));
    const similarity = matches.length / queryWords.length;
    
    // Boost score for title matches
    const titleSimilarity = queryWords.filter(word => 
      document.title.toLowerCase().includes(word)
    ).length / queryWords.length;
    
    return Math.min(1.0, similarity + (titleSimilarity * 0.5));
  }

  private generateExcerpt(content: string, queryTerms: string[]): string {
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    // Find sentences containing query terms
    const relevantSentences = sentences.filter(sentence => 
      queryTerms.some(term => sentence.toLowerCase().includes(term))
    );
    
    if (relevantSentences.length > 0) {
      return relevantSentences.slice(0, 2).join('. ') + '.';
    }
    
    // Fallback to first few sentences
    return sentences.slice(0, 2).join('. ') + '.';
  }

  private detectLanguage(filePath: string): string {
    const extension = filePath.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'go': 'go',
      'rs': 'rust',
      'php': 'php',
      'rb': 'ruby',
      'md': 'markdown',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml'
    };
    
    return languageMap[extension || ''] || 'text';
  }

  private extractCodeSummary(analysisResult: any): string {
    // Extract key information from code analysis
    if (typeof analysisResult === 'string') {
      return analysisResult.substring(0, 500) + '...';
    }
    
    if (analysisResult.summary) {
      return analysisResult.summary;
    }
    
    return 'Code analysis completed';
  }

  private extractConversationSummary(history: any[]): string {
    // Extract key topics from conversation
    const lastMessages = history.slice(-5);
    const summary = lastMessages
      .map(msg => typeof msg === 'string' ? msg : msg.content || '')
      .join(' ')
      .substring(0, 500);
    
    return summary + (summary.length >= 500 ? '...' : '');
  }

  // Cleanup old documents (for cost optimization)
  async cleanupOldDocuments(daysOld: number = 30): Promise<number> {
    try {
      const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
      let deletedCount = 0;
      
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: this.ragPrefix,
        MaxKeys: 1000
      });

      const response = await this.s3Client.send(listCommand);
      
      if (!response.Contents) {
        return 0;
      }

      for (const obj of response.Contents) {
        if (!obj.Key || !obj.Key.endsWith('.json')) continue;
        
        try {
          const docResponse = await this.s3Client.send(new GetObjectCommand({
            Bucket: this.bucketName,
            Key: obj.Key
          }));
          
          if (!docResponse.Body) continue;
          
          const docContent = await this.streamToString(docResponse.Body as Readable);
          const document = JSON.parse(docContent) as RagDocument;
          
          if (document.metadata.createdAt < cutoffTime) {
            await this.deleteDocument(document.id);
            deletedCount++;
          }
        } catch (error) {
          logger.warn(`Failed to process document ${obj.Key} for cleanup:`, error);
          continue;
        }
      }

      logger.info(`Cleaned up ${deletedCount} old RAG documents (${daysOld} days)`);
      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup old RAG documents:', error);
      return 0;
    }
  }

  // Get RAG service statistics
  async getStatistics(): Promise<{
    totalDocuments: number;
    totalSizeBytes: number;
    documentsByType: Record<string, number>;
    averageDocumentSize: number;
  }> {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: this.ragPrefix,
        MaxKeys: 1000
      });

      const response = await this.s3Client.send(listCommand);
      
      const stats = {
        totalDocuments: 0,
        totalSizeBytes: 0,
        documentsByType: {} as Record<string, number>,
        averageDocumentSize: 0
      };
      
      if (!response.Contents) {
        return stats;
      }

      for (const obj of response.Contents) {
        if (!obj.Key || !obj.Key.endsWith('.json')) continue;
        
        stats.totalDocuments++;
        stats.totalSizeBytes += obj.Size || 0;
        
        // Extract type from metadata if available
        const type = obj.Key.split('/').pop()?.split('_')[0] || 'unknown';
        stats.documentsByType[type] = (stats.documentsByType[type] || 0) + 1;
      }

      stats.averageDocumentSize = stats.totalDocuments > 0 
        ? stats.totalSizeBytes / stats.totalDocuments 
        : 0;

      return stats;
    } catch (error) {
      logger.error('Failed to get RAG service statistics:', error);
      throw error;
    }
  }
}

export const s3RagService = new S3RagService();