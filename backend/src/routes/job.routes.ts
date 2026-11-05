import { Router } from 'express';
import {
  getJobs,
  getJobBySlug,
  createJob,
  updateJob,
  deleteJob,
} from '../controllers/job.controller';
import { authenticateJwt, optionalAuthenticateJwt, requireRoles, requireRecruiterPermission, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

const requireRecruiterJobPermission = (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void => {
  if (req.user?.role === 'RECRUITER') {
    void requireRecruiterPermission('jobs')(req, res, next);
    return;
  }
  if (req.user?.role === 'SUB_ADMIN') {
    void requirePermission('jobs')(req, res, next);
    return;
  }
  next();
};

// Public routes
router.get('/sitemap', getJobs);
router.get('/', optionalAuthenticateJwt, requireRecruiterJobPermission, getJobs);
router.get('/:slug', optionalAuthenticateJwt, requireRecruiterJobPermission, getJobBySlug);

// Administrative job management
router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('jobs'), createJob);
router.put('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('jobs'), updateJob);
router.patch('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('jobs'), updateJob);
router.delete('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('jobs'), deleteJob);

export default router;
