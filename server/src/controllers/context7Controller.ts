import { Request, Response } from 'express';
import { context7Cache } from '../services/context7Cache';
import { logger } from '../config/logger';

export class Context7Controller {
  
  async resolveLibrary(req: Request, res: Response) {
    try {
      const { query } = req.body;
      
      if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
      }

      logger.info(`Context7: Resolving library for query: ${query}`);
      
      const result = await context7Cache.resolveLibraryId(query);
      
      res.json({
        success: true,
        query,
        library: result,
        cached: result ? true : false
      });

    } catch (error) {
      logger.error('Context7: Error resolving library', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to resolve library',
        message: error.message 
      });
    }
  }

  async getLibraryDocs(req: Request, res: Response) {
    try {
      const { libraryId } = req.params;
      
      if (!libraryId) {
        return res.status(400).json({ error: 'Library ID is required' });
      }

      logger.info(`Context7: Getting docs for library: ${libraryId}`);
      
      const docs = await context7Cache.getLibraryDocumentation(libraryId);
      
      res.json({
        success: true,
        libraryId,
        docs,
        cached: docs ? true : false
      });

    } catch (error) {
      logger.error('Context7: Error getting library docs', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get library documentation',
        message: error.message 
      });
    }
  }

  async getCacheStats(req: Request, res: Response) {
    try {
      const stats = await context7Cache.getCacheStats();
      
      res.json({
        success: true,
        cache: stats
      });

    } catch (error) {
      logger.error('Context7: Error getting cache stats', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get cache stats',
        message: error.message 
      });
    }
  }

  async clearCache(req: Request, res: Response) {
    try {
      await context7Cache.clearCache();
      
      res.json({
        success: true,
        message: 'Cache cleared successfully'
      });

    } catch (error) {
      logger.error('Context7: Error clearing cache', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to clear cache',
        message: error.message 
      });
    }
  }

  async searchLibraries(req: Request, res: Response) {
    try {
      const { q, limit = 50 } = req.query;
      
      if (!q) {
        return res.status(400).json({ error: 'Search query (q) is required' });
      }

      logger.info(`Context7: Searching libraries for: ${q}`);
      
      // Try to get from cache first
      const cached = await context7Cache.getLibraryList(q as string);
      
      if (cached) {
        const limitedResults = cached.slice(0, parseInt(limit as string));
        return res.json({
          success: true,
          query: q,
          libraries: limitedResults,
          total: cached.length,
          cached: true
        });
      }

      // If not cached, return empty for now (in a real implementation, 
      // you would call Context7 MCP server and then cache the results)
      res.json({
        success: true,
        query: q,
        libraries: [],
        total: 0,
        cached: false,
        message: 'No cached results found. Use resolve-library endpoint to populate cache.'
      });

    } catch (error) {
      logger.error('Context7: Error searching libraries', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to search libraries',
        message: error.message 
      });
    }
  }
}