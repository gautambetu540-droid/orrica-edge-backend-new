import { Router } from 'express';
import {
  getDashboardStats,
  getAdminDashboard,
  getTLDashboard,
  getRecruiterDashboard,
} from '../controllers/dashboard.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// General Stats: accessible by Admin, TL, Recruiter, Freelance Recruiter
router.get(
  '/stats',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  getDashboardStats
);

// Admin Dashboard: accessible by Admin and Super Admin
router.get(
  '/admin',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  getAdminDashboard
);

// Team Leader Dashboard: accessible by Team Leader, Admin, Super Admin
router.get(
  '/tl',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER'),
  getTLDashboard
);

// Recruiter Dashboard: accessible by Recruiter, Freelance Recruiter, Admin, Super Admin
router.get(
  '/recruiter',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  getRecruiterDashboard
);

export default router;
