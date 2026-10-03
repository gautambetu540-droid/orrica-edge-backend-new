import { Router } from 'express';
import { globalSearch } from '../controllers/search.controller';
import { authenticateJwt } from '../middlewares/auth.middleware';

const router = Router();

// Global Search endpoint - Protected by JWT authentication
router.get('/', authenticateJwt, globalSearch);

export default router;
