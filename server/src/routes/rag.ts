import { Router } from 'express';
import { ragController } from '../controllers/ragController';
import { authenticateToken } from '../middleware/auth';
import rateLimit from 'express-rate-limit';

const router = Router();

// Rate limiting for RAG endpoints
const ragRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many RAG requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const searchRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 search requests per minute
  message: 'Too many search requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // limit each IP to 20 upload requests per 5 minutes
  message: 'Too many upload requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply authentication to all RAG routes
router.use(authenticateToken);

// Document search and retrieval
router.get('/search', searchRateLimit, ragController.searchDocuments.bind(ragController));
router.get('/documents/:documentId', ragRateLimit, ragController.getDocument.bind(ragController));

// Document storage
router.post('/documents', uploadRateLimit, ragController.storeDocument.bind(ragController));
router.post('/code-analysis', uploadRateLimit, ragController.storeCodeAnalysis.bind(ragController));

// Document management
router.delete('/documents/:documentId', ragRateLimit, ragController.deleteDocument.bind(ragController));

// Context7 integration
router.post('/references/collect', ragRateLimit, ragController.collectReferences.bind(ragController));
router.get('/references/search', searchRateLimit, ragController.searchDesignReferences.bind(ragController));
router.get('/references/patterns/:pattern', ragRateLimit, ragController.getPatternReferences.bind(ragController));
router.get('/references/libraries/:library', ragRateLimit, ragController.getLibraryReferences.bind(ragController));
router.get('/references/best-practices/:technology', ragRateLimit, ragController.getBestPractices.bind(ragController));

// Administrative endpoints
router.get('/statistics', ragRateLimit, ragController.getStatistics.bind(ragController));
router.post('/cleanup', uploadRateLimit, ragController.cleanup.bind(ragController));

export { router as ragRoutes };