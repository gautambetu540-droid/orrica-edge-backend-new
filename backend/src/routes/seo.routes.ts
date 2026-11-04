import { Router } from 'express';
import { getJobPostingJsonLd, indexAllActiveJobs, indexJobBySlug } from '../controllers/seo.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Public schema lookup
router.get('/jobs/:slug/schema', getJobPostingJsonLd);

// Admin / Super Admin manual Google Indexing triggers
router.post('/jobs/index-all', authenticateJwt, requireRoles('ADMIN', 'SUPER_ADMIN'), indexAllActiveJobs);
router.post('/jobs/:slug/index', authenticateJwt, requireRoles('ADMIN', 'SUPER_ADMIN'), indexJobBySlug);

export default router;
