import { Router } from 'express';
import { getAdminPortalData } from '../controllers/admin-portal.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

router.get('/portal-data', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), getAdminPortalData);

export default router;
