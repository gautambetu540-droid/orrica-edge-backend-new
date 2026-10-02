import { Router } from 'express';
import {
  getJobs,
  getJobBySlug,
  createJob,
  updateJob,
  deleteJob,
} from '../controllers/job.controller';
import { authenticateJwt, optionalAuthenticateJwt, requireRoles, requireRecruiterPermission } from '../middlewares/auth.middleware';

const router = Router();

const requireRecruiterJobPermission = (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void => {
  if (req.user?.role === 'RECRUITER') {
    void requireRecruiterPermission('jobs')(req, res, next);
    return;
  }
  next();
};

// Public routes
router.get('/', optionalAuthenticateJwt, requireRecruiterJobPermission, getJobs);
router.get('/:slug', optionalAuthenticateJwt, requireRecruiterJobPermission, getJobBySlug);

// Administrative job management
router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), createJob);
router.put('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), updateJob);
router.patch('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), updateJob);
router.delete('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), deleteJob);

export default router;
