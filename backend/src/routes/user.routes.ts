import { Router } from 'express';
import {
  getMyProfile,
  updateMyProfile,
  changePassword,
  getMySettings,
  updateMySettings,
  logout,
} from '../controllers/user.controller';
import { authenticateJwt } from '../middlewares/auth.middleware';

const router = Router();

// All user/profile routes require valid JWT authentication
router.use(authenticateJwt);

// Profile
router.get('/profile', getMyProfile);
router.patch('/profile', updateMyProfile);
router.put('/profile', updateMyProfile);

// Password Change
router.post('/change-password', changePassword);
router.put('/password', changePassword);

// Settings
router.get('/settings', getMySettings);
router.patch('/settings', updateMySettings);
router.put('/settings', updateMySettings);

// Logout
router.post('/logout', logout);

export default router;
