import { Router } from 'express';
import {
  applyForJob,
  getApplications,
  updateApplicationStage,
} from '../controllers/application.controller';
import { uploadResume } from '../middlewares/upload.middleware';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Public candidate job application with resume upload
router.post('/apply', uploadResume.single('resume'), applyForJob);

// Protected ATS Pipeline endpoints
router.get('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), getApplications);
router.patch('/:id/stage', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), updateApplicationStage);

export default router;
