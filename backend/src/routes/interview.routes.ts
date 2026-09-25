import { Router } from 'express';
import {
  scheduleInterview,
  updateInterviewStatus,
} from '../controllers/interview.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), scheduleInterview);
router.patch('/:id/status', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), updateInterviewStatus);

export default router;
