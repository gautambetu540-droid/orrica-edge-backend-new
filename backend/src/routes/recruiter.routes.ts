import { Router } from 'express';
import { createRecruiter, getRecruiters } from '../controllers/recruiter.controller';
import {
  getMyRecruiterPermissions,
  getRecruiterPermissions,
  updateRecruiterPermissions,
} from '../controllers/recruiterPermission.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

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
