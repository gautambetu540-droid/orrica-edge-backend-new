import { Router } from 'express';
import { register, login, getMe, keepAlive } from '../controllers/auth.controller';
import { authenticateJwt } from '../middlewares/auth.middleware';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', authenticateJwt, getMe);
router.post('/keepalive', authenticateJwt, keepAlive);

export default router;
