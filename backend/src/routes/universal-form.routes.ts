import { Router } from 'express';
import {
  getUniversalForms,
  getUniversalFormById,
  createUniversalForm,
  updateUniversalForm,
  deleteUniversalForm,
  getPublicUniversalForm,
  submitPublicUniversalForm,
  getUniversalFormSubmissions,
} from '../controllers/universal-form.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';
import { uploadResume } from '../middlewares/upload.middleware';

const router = Router();

// Public candidate-facing endpoints. Keep these above /:id routes.
router.get('/public/:slug', getPublicUniversalForm);
router.post('/public/:slug/submit', uploadResume.single('resume'), submitPublicUniversalForm);

// Admin/Recruiter management endpoints.
router.get('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), getUniversalForms);
router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), createUniversalForm);
router.get('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), getUniversalFormById);
router.get('/:id/submissions', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), getUniversalFormSubmissions);
router.put('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), updateUniversalForm);
router.delete('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), deleteUniversalForm);

export default router;
