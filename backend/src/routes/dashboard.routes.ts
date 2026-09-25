import { Router } from 'express';
import { getDashboardStats } from '../controllers/dashboard.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

router.get('/stats', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), getDashboardStats);

export default router;
