import { Router } from 'express';
import {
  createRecruiter,
  getRecruiters,
  getMyRecruiterProfile,
  updateMyRecruiterProfile,
  updateRecruiterStatus,
  getRecruiterJobs,
  updateRecruiterJobs,
  getRecruiterAnalytics,
  getRecruiterProductivity,
} from '../controllers/recruiter.controller';
import {
  getMyRecruiterPermissions,
  getRecruiterPermissions,
  updateRecruiterPermissions,
} from '../controllers/recruiterPermission.controller';
import {
  authenticateJwt,
  requireRoles,
  requireRecruiterPermission,
} from '../middlewares/auth.middleware';

const router = Router();

router.post(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  createRecruiter
);

router.get(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  getRecruiters
);

router.patch(
  '/:id/status',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  updateRecruiterStatus
);

router.get(
  '/:id/analytics',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  getRecruiterAnalytics
);

router.get(
  '/:id/productivity',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  getRecruiterProductivity
);

router.get(
  '/:id/jobs',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  getRecruiterJobs
);

router.put(
  '/:id/jobs',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  updateRecruiterJobs
);

router.get(
  '/me/profile',
  authenticateJwt,
  requireRoles('RECRUITER'),
  requireRecruiterPermission('settings'),
  getMyRecruiterProfile
);

router.put(
  '/me/profile',
  authenticateJwt,
  requireRoles('RECRUITER'),
  requireRecruiterPermission('settings'),
  updateMyRecruiterProfile
);

router.get(
  '/me/permissions',
  authenticateJwt,
  requireRoles('RECRUITER'),
  getMyRecruiterPermissions
);

router.get(
  '/:id/permissions',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  getRecruiterPermissions
);

router.put(
  '/:id/permissions',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  updateRecruiterPermissions
);

export default router;
