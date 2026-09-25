import { Router } from 'express';
import { getJobPostingJsonLd } from '../controllers/seo.controller';

const router = Router();

router.get('/jobs/:slug/schema', getJobPostingJsonLd);

export default router;
