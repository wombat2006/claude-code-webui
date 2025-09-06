import express from 'express';
import { Context7Controller } from '../controllers/context7Controller';
import { authenticateToken } from '../middleware/auth';
import { body, param, query } from 'express-validator';
import { validateRequest } from '../middleware/validation';

const router = express.Router();
const context7Controller = new Context7Controller();

// All Context7 routes require authentication
router.use(authenticateToken);

// Resolve library ID from query
router.post('/resolve', 
  body('query').notEmpty().withMessage('Query is required'),
  validateRequest,
  context7Controller.resolveLibrary
);

// Get library documentation
router.get('/docs/:libraryId',
  param('libraryId').notEmpty().withMessage('Library ID is required'),
  validateRequest,
  context7Controller.getLibraryDocs
);

// Search libraries
router.get('/search',
  query('q').notEmpty().withMessage('Search query is required'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  validateRequest,
  context7Controller.searchLibraries
);

// Cache management
router.get('/cache/stats', context7Controller.getCacheStats);
router.delete('/cache', context7Controller.clearCache);

export default router;