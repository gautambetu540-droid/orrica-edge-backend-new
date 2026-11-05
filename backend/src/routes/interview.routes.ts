import { Router } from 'express';
import {
  scheduleInterview,
  updateInterviewStatus,
} from '../controllers/interview.controller';
import { authenticateJwt, requireRoles, requireRecruiterPermission, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'RECRUITER'), requirePermission('interviews'), requireRecruiterPermission('interviews'), scheduleInterview);
router.patch('/:id/status', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'RECRUITER'), requirePermission('interviews'), requireRecruiterPermission('interviews'), updateInterviewStatus);

export default router;
