import { Router } from 'express';
import {
  getMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../controllers/notification.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

router.get(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  getMyNotifications
);

router.patch(
  '/:id/read',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  markNotificationRead
);

router.post(
  '/read-all',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  markAllNotificationsRead
);

export default router;
