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

import { sendRecruiterWelcomeEmail } from '../controllers/recruiter.controller';
import recruiterRoutes from './recruiter.routes';

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

// Explicit welcome email endpoints for recruiters under admin portal
router.post('/recruiters/:id/send-welcome', sendRecruiterWelcomeEmail);
router.post('/recruiters/:id/resend-welcome', sendRecruiterWelcomeEmail);

// Mount all recruiter management subroutes under /admin/recruiters
router.use('/recruiters', recruiterRoutes);

export default router;

