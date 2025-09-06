import { Request, Response } from 'express';
import { s3RagService } from '../services/s3RagService';
import { context7RagIntegration } from '../services/context7RagIntegration';
import { logger } from '../config/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    username: string;
    sessionId: string;
  };
}

export class RagController {
  // Search documents in RAG storage
  async searchDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { 
        query, 
        type, 
        project, 
        tags, 
        limit = 10, 
        similarity_threshold = 0.1 
      } = req.query;

      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'Query parameter is required' });
        return;
      }

      const searchQuery = {
        query,
        type: type as any,
        project: project as string,
        tags: tags ? (Array.isArray(tags) ? tags : [tags]) as string[] : undefined,
        limit: parseInt(limit as string),
        similarity_threshold: parseFloat(similarity_threshold as string)
      };

      const results = await s3RagService.searchDocuments(searchQuery);

      logger.audit('RAG document search', {
        username: req.user?.username,
        query: query.substring(0, 100),
        resultCount: results.length,
        type,
        project
      });

      res.json({
        query,
        results: results.map(result => ({
          id: result.document.id,
          title: result.document.title,
          excerpt: result.excerpt,
          similarity: result.similarity,
          type: result.document.metadata.type,
          source: result.document.metadata.source,
          project: result.document.metadata.project,
          tags: result.document.metadata.tags,
          createdAt: result.document.metadata.createdAt
        })),
        totalResults: results.length,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('RAG search failed:', error as Error, {
        username: req.user?.username,
        query: req.query.query
      });
      res.status(500).json({ error: 'Search failed' });
    }
  }

  // Get specific document
  async getDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { documentId } = req.params;

      if (!documentId) {
        res.status(400).json({ error: 'Document ID is required' });
        return;
      }

      const document = await s3RagService.getDocument(documentId);

      if (!document) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      logger.audit('RAG document retrieved', {
        username: req.user?.username,
        documentId,
        type: document.metadata.type,
        source: document.metadata.source
      });

      res.json(document);
    } catch (error) {
      logger.error('RAG document retrieval failed:', error as Error, {
        username: req.user?.username,
        documentId: req.params.documentId
      });
      res.status(500).json({ error: 'Document retrieval failed' });
    }
  }

  // Store new document
  async storeDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { title, content, metadata } = req.body;

      if (!title || !content || !metadata) {
        res.status(400).json({ 
          error: 'Title, content, and metadata are required' 
        });
        return;
      }

      if (!metadata.type || !metadata.source) {
        res.status(400).json({ 
          error: 'Metadata must include type and source' 
        });
        return;
      }

      // Add user context to metadata
      const enhancedMetadata = {
        ...metadata,
        createdBy: req.user?.username,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        size: content.length,
        tags: metadata.tags || []
      };

      const document = await s3RagService.storeDocument({
        title,
        content,
        metadata: enhancedMetadata
      });

      logger.audit('RAG document stored', {
        username: req.user?.username,
        documentId: document.id,
        type: document.metadata.type,
        source: document.metadata.source,
        size: document.metadata.size
      });

      res.status(201).json({
        id: document.id,
        title: document.title,
        type: document.metadata.type,
        source: document.metadata.source,
        createdAt: document.metadata.createdAt,
        tags: document.metadata.tags
      });
    } catch (error) {
      logger.error('RAG document storage failed:', error as Error, {
        username: req.user?.username,
        title: req.body.title?.substring(0, 50)
      });
      res.status(500).json({ error: 'Document storage failed' });
    }
  }

  // Store code analysis results
  async storeCodeAnalysis(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { filePath, codeContent, analysisResult, project } = req.body;

      if (!filePath || !codeContent || !analysisResult) {
        res.status(400).json({ 
          error: 'filePath, codeContent, and analysisResult are required' 
        });
        return;
      }

      const document = await s3RagService.storeCodeAnalysis(
        filePath,
        codeContent,
        analysisResult,
        project || req.user?.username
      );

      logger.audit('Code analysis stored in RAG', {
        username: req.user?.username,
        documentId: document.id,
        filePath,
        project: project || req.user?.username,
        codeSize: codeContent.length
      });

      res.status(201).json({
        id: document.id,
        filePath,
        project: document.metadata.project,
        createdAt: document.metadata.createdAt
      });
    } catch (error) {
      logger.error('Code analysis storage failed:', error as Error, {
        username: req.user?.username,
        filePath: req.body.filePath
      });
      res.status(500).json({ error: 'Code analysis storage failed' });
    }
  }

  // Context7 integration endpoints
  async collectReferences(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { query, type, language, framework, project } = req.body;

      if (!query || !type) {
        res.status(400).json({ 
          error: 'Query and type are required' 
        });
        return;
      }

      const request = {
        query,
        type,
        language,
        framework,
        project: project || req.user?.username
      };

      const references = await context7RagIntegration.collectReferences(request);

      logger.audit('Context7 references collected', {
        username: req.user?.username,
        query: query.substring(0, 100),
        type,
        referencesCount: references.references.length,
        cached: references.cached
      });

      res.json(references);
    } catch (error) {
      logger.error('Context7 reference collection failed:', error as Error, {
        username: req.user?.username,
        query: req.body.query?.substring(0, 50)
      });
      res.status(500).json({ error: 'Reference collection failed' });
    }
  }

  // Search design references
  async searchDesignReferences(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { query, category, language, limit = 10 } = req.query;

      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'Query parameter is required' });
        return;
      }

      const references = await context7RagIntegration.searchDesignReferences(
        query,
        category as any,
        language as string,
        parseInt(limit as string)
      );

      logger.audit('Design references searched', {
        username: req.user?.username,
        query: query.substring(0, 100),
        category,
        referencesCount: references.length
      });

      res.json({
        query,
        category,
        references,
        totalResults: references.length,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Design reference search failed:', error as Error, {
        username: req.user?.username,
        query: req.query.query
      });
      res.status(500).json({ error: 'Design reference search failed' });
    }
  }

  // Get pattern references
  async getPatternReferences(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { pattern } = req.params;
      const { language } = req.query;

      if (!pattern) {
        res.status(400).json({ error: 'Pattern name is required' });
        return;
      }

      const references = await context7RagIntegration.getPatternReferences(
        pattern,
        language as string
      );

      logger.audit('Pattern references retrieved', {
        username: req.user?.username,
        pattern,
        language,
        referencesCount: references.length
      });

      res.json({
        pattern,
        language,
        references,
        totalResults: references.length,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Pattern reference retrieval failed:', error as Error, {
        username: req.user?.username,
        pattern: req.params.pattern
      });
      res.status(500).json({ error: 'Pattern reference retrieval failed' });
    }
  }

  // Get library references
  async getLibraryReferences(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { library } = req.params;
      const { version } = req.query;

      if (!library) {
        res.status(400).json({ error: 'Library name is required' });
        return;
      }

      const references = await context7RagIntegration.getLibraryReferences(
        library,
        version as string
      );

      logger.audit('Library references retrieved', {
        username: req.user?.username,
        library,
        version,
        referencesCount: references.length
      });

      res.json({
        library,
        version,
        references,
        totalResults: references.length,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Library reference retrieval failed:', error as Error, {
        username: req.user?.username,
        library: req.params.library
      });
      res.status(500).json({ error: 'Library reference retrieval failed' });
    }
  }

  // Get best practices
  async getBestPractices(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { technology } = req.params;
      const { context } = req.query;

      if (!technology) {
        res.status(400).json({ error: 'Technology is required' });
        return;
      }

      const references = await context7RagIntegration.getBestPractices(
        technology,
        context as string
      );

      logger.audit('Best practices retrieved', {
        username: req.user?.username,
        technology,
        context,
        referencesCount: references.length
      });

      res.json({
        technology,
        context,
        references,
        totalResults: references.length,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Best practices retrieval failed:', error as Error, {
        username: req.user?.username,
        technology: req.params.technology
      });
      res.status(500).json({ error: 'Best practices retrieval failed' });
    }
  }

  // Delete document
  async deleteDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { documentId } = req.params;

      if (!documentId) {
        res.status(400).json({ error: 'Document ID is required' });
        return;
      }

      const success = await s3RagService.deleteDocument(documentId);

      if (!success) {
        res.status(404).json({ error: 'Document not found or deletion failed' });
        return;
      }

      logger.audit('RAG document deleted', {
        username: req.user?.username,
        documentId
      });

      res.json({ success: true, documentId });
    } catch (error) {
      logger.error('RAG document deletion failed:', error as Error, {
        username: req.user?.username,
        documentId: req.params.documentId
      });
      res.status(500).json({ error: 'Document deletion failed' });
    }
  }

  // Get RAG service statistics
  async getStatistics(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const [ragStats, context7Stats] = await Promise.all([
        s3RagService.getStatistics(),
        context7RagIntegration.getStatistics()
      ]);

      logger.audit('RAG statistics retrieved', {
        username: req.user?.username,
        totalDocuments: ragStats.totalDocuments,
        totalReferences: context7Stats.totalCachedReferences
      });

      res.json({
        rag: ragStats,
        context7: context7Stats,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('RAG statistics retrieval failed:', error as Error, {
        username: req.user?.username
      });
      res.status(500).json({ error: 'Statistics retrieval failed' });
    }
  }

  // Cleanup old documents
  async cleanup(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { daysOld = 30, context7DaysOld = 7 } = req.query;

      const [ragCleaned, context7Cleaned] = await Promise.all([
        s3RagService.cleanupOldDocuments(parseInt(daysOld as string)),
        context7RagIntegration.cleanupCache(parseInt(context7DaysOld as string) * 24)
      ]);

      logger.audit('RAG cleanup performed', {
        username: req.user?.username,
        ragDocumentsDeleted: ragCleaned,
        context7CacheDeleted: context7Cleaned
      });

      res.json({
        success: true,
        ragDocumentsDeleted: ragCleaned,
        context7CacheDeleted: context7Cleaned,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('RAG cleanup failed:', error as Error, {
        username: req.user?.username
      });
      res.status(500).json({ error: 'Cleanup failed' });
    }
  }
}

export const ragController = new RagController();