import { Router } from 'express';
import {
  submitRecruiterApplication,
  getRecruiterApplications,
  getRecruiterApplicationById,
  updateRecruiterApplicationStatus,
  approveRecruiterApplication,
} from '../controllers/recruiter-application.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Public recruiter application submission.
router.post('/', submitRecruiterApplication);

// Admin recruiter application listing.
router.get(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  getRecruiterApplications
);

// Admin single recruiter application details.
router.get(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  getRecruiterApplicationById
);

// Admin update recruiter application status.
router.patch(
  '/:id/status',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  updateRecruiterApplicationStatus
);

// Admin approve recruiter application.
router.post(
  '/:id/approve',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  approveRecruiterApplication
);

export default router;
