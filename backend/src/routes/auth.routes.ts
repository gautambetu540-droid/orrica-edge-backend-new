import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  register,
  login,
  setPassword,
  getMe,
  keepAlive,
  changeMyPassword,
} from '../controllers/auth.controller';
import {
  setupMfa,
  verifyMfaSetup,
  verifyMfaChallenge,
  getMfaStatus,
} from '../controllers/mfa.controller';
import { authenticateJwt } from '../middlewares/auth.middleware';

const router = Router();

// Keep MFA verification endpoints protected against OTP/backup-code brute force.
const mfaVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'MFA_RATE_LIMITED',
    message: 'Too many MFA verification attempts. Please try again later.',
  },
});

// Public authentication endpoints
router.post('/register', register);
router.post('/login', login);

// Recruiter first-time password setup.
// This is token-protected at the controller level using the
// one-time token sent in the recruiter welcome email.
router.post('/set-password', setPassword);

router.put('/me/password', authenticateJwt, changeMyPassword);

router.get('/mfa/status', authenticateJwt, getMfaStatus);
router.post('/mfa/setup', authenticateJwt, setupMfa);
router.post('/mfa/verify-setup', authenticateJwt, mfaVerificationLimiter, verifyMfaSetup);
router.post('/mfa/verify', authenticateJwt, mfaVerificationLimiter, verifyMfaChallenge);

// Authenticated user endpoints
router.get('/me', authenticateJwt, getMe);
router.post('/keepalive', authenticateJwt, keepAlive);

export default router;
