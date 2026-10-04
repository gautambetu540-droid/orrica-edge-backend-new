import { Router } from 'express';
import {
  getAdminPortalData,
  getAuditLogs,
  createEmployeeUser,
  getEmployeeUsers,
} from '../controllers/admin-portal.controller';
import {
  getMyProfile,
  updateMyProfile,
  changePassword,
  getMySettings,
  updateMySettings,
} from '../controllers/user.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'));

// Admin profile endpoints
router.get('/profile', getMyProfile);
router.patch('/profile', updateMyProfile);
router.put('/profile', updateMyProfile);
router.post('/profile', updateMyProfile);

// Admin password & settings endpoints
router.post('/change-password', changePassword);
router.put('/password', changePassword);
router.get('/settings', getMySettings);
router.patch('/settings', updateMySettings);
router.put('/settings', updateMySettings);

// Portal operations & employees
router.get('/portal-data', getAdminPortalData);
router.get('/audit-logs', getAuditLogs);
router.get('/employees', getEmployeeUsers);
router.post('/employees', createEmployeeUser);

export default router;

