import { Router, Request, Response, NextFunction } from 'express';
import {
  createRecruiter,
  getRecruiters,
  getRecruiterById,
  updateRecruiter,
  deleteRecruiter,
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
import { getRecruiterDashboard } from '../controllers/dashboard.controller';
import { prisma } from '../prisma/client';
import {
  authenticateJwt,
  requireRoles,
  requireRecruiterPermission,
} from '../middlewares/auth.middleware';

const router = Router();

const requireRecruiterSelfOrAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const user = req.user;

  if (!user) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }

  if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
    next();
    return;
  }

  if (
    (user.role === 'RECRUITER' || user.role === 'FREELANCE_RECRUITER') &&
    user.userId === req.params.id
  ) {
    next();
    return;
  }

  if (user.role === 'TEAM_LEADER') {
    const isMemberOfPod = await prisma.user.findFirst({
      where: {
        id: req.params.id,
        teamLeaderId: user.userId,
      },
      select: { id: true },
    });

    if (isMemberOfPod) {
      next();
      return;
    }
  }

  res.status(403).json({
    success: false,
    message: 'Forbidden: Recruiters may access only their own data.',
  });
};

router.get(
  '/dashboard',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  getRecruiterDashboard
);

router.post(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  createRecruiter
);

router.get(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER'),
  getRecruiters
);

router.get(
  '/me/profile',
  authenticateJwt,
  requireRoles('RECRUITER', 'FREELANCE_RECRUITER'),
  getMyRecruiterProfile
);

router.put(
  '/me/profile',
  authenticateJwt,
  requireRoles('RECRUITER', 'FREELANCE_RECRUITER'),
  updateMyRecruiterProfile
);

router.patch(
  '/me/profile',
  authenticateJwt,
  requireRoles('RECRUITER', 'FREELANCE_RECRUITER'),
  updateMyRecruiterProfile
);

router.get(
  '/me/permissions',
  authenticateJwt,
  requireRoles('RECRUITER', 'FREELANCE_RECRUITER'),
  getMyRecruiterPermissions
);

router.get(
  '/:id',
  authenticateJwt,
  requireRecruiterSelfOrAdmin,
  getRecruiterById
);

router.put(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  updateRecruiter
);

router.patch(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  updateRecruiter
);

router.delete(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  deleteRecruiter
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

