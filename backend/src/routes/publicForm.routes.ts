import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  submitPublicContactInquiry,
  submitPublicEmployerRequirement,
} from '../controllers/publicForm.controller';

const router = Router();

// Rate limiter: 5 submissions per hour per IP per endpoint
const formLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    errors: {
      form: 'Too many submissions from this network. Please wait an hour or contact us directly at info@orricaedge.com.',
    },
  },
});

router.post('/contact-inquiries', formLimiter, submitPublicContactInquiry);
router.post('/employer-requirements', formLimiter, submitPublicEmployerRequirement);

export default router;
