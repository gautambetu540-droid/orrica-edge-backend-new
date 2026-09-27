import { Router } from 'express';
import {
  submitRecruiterApplication,
  getRecruiterApplications,
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

export default router;
