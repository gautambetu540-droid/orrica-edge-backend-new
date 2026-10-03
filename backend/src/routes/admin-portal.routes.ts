import { Router } from 'express';
import {
  getAdminPortalData,
  getAuditLogs,
  createEmployeeUser,
  getEmployeeUsers,
} from '../controllers/admin-portal.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'));

router.get('/portal-data', getAdminPortalData);
router.get('/audit-logs', getAuditLogs);
router.get('/employees', getEmployeeUsers);
router.post('/employees', createEmployeeUser);

export default router;
