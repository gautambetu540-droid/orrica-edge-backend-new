import { Router, Request, Response, NextFunction } from 'express';
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

const requireRecruiterSelfOrAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const user = req.user;

  if (!user) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }

  if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
    next();
    return;
  }

  if (user.role === 'RECRUITER' && user.userId === req.params.id) {
    next();
    return;
  }

  res.status(403).json({
    success: false,
    message: 'Forbidden: Recruiters may access only their own data.',
  });
};

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
  requireRecruiterSelfOrAdmin,
  requireRecruiterPermission('dashboard'),
  getRecruiterAnalytics
);

router.get(
  '/:id/productivity',
  authenticateJwt,
  requireRecruiterSelfOrAdmin,
  requireRecruiterPermission('dashboard'),
  getRecruiterProductivity
);

router.get(
  '/:id/jobs',
  authenticateJwt,
  requireRecruiterSelfOrAdmin,
  requireRecruiterPermission('jobs'),
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
