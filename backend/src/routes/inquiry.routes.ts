import { Router } from 'express';
import {
  submitEmployerInquiry,
  submitRecruiterPartnerInquiry,
  submitContactInquiry,
  getInquiries,
} from '../controllers/inquiry.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Public submission endpoints
router.post('/hire-talent', submitEmployerInquiry);
router.post('/recruiter-partner', submitRecruiterPartnerInquiry);
router.post('/contact', submitContactInquiry);

// Admin review endpoint
router.get('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), getInquiries);

export default router;
