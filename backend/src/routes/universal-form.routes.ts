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

// Universal form management and candidate submissions contain sensitive data.
router.get('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), getUniversalForms);
router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), createUniversalForm);
router.get('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), getUniversalFormById);
router.get('/:id/submissions', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), getUniversalFormSubmissions);
router.put('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), updateUniversalForm);
router.delete('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), deleteUniversalForm);

export default router;
