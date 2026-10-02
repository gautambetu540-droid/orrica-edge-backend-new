import { Router } from 'express';
import {
  scheduleInterview,
  updateInterviewStatus,
} from '../controllers/interview.controller';
import { authenticateJwt, requireRoles, requireRecruiterPermission } from '../middlewares/auth.middleware';

const router = Router();

router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), requireRecruiterPermission('interviews'), scheduleInterview);
router.patch('/:id/status', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), requireRecruiterPermission('interviews'), updateInterviewStatus);

export default router;
