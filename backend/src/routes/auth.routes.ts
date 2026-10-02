import { Router } from 'express';
import {
  register,
  login,
  setPassword,
  getMe,
  keepAlive,
  changeMyPassword,
} from '../controllers/auth.controller';
import { authenticateJwt } from '../middlewares/auth.middleware';

const router = Router();

// Public authentication endpoints
router.post('/register', register);
router.post('/login', login);

// Recruiter first-time password setup.
// This is token-protected at the controller level using the
// one-time token sent in the recruiter welcome email.
router.post('/set-password', setPassword);

router.put('/me/password', authenticateJwt, changeMyPassword);

// Authenticated user endpoints
router.get('/me', authenticateJwt, getMe);
router.post('/keepalive', authenticateJwt, keepAlive);

export default router;
