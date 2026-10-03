import { Router } from 'express';
import {
  getPendingApprovals,
  approveApplication,
  sendBackApplication,
  rejectApplication,
  getTeamMembers,
} from '../controllers/team-leader.controller';
import { getTLDashboard } from '../controllers/dashboard.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Protected Gateway APIs: Accessible by TEAM_LEADER, ADMIN, SUPER_ADMIN
router.use(authenticateJwt, requireRoles('TEAM_LEADER', 'ADMIN', 'SUPER_ADMIN'));

router.get('/dashboard', getTLDashboard);
router.get('/pending-approvals', getPendingApprovals);
router.post('/applications/:id/approve', approveApplication);
router.post('/applications/:id/send-back', sendBackApplication);
router.post('/applications/:id/reject', rejectApplication);
router.get('/team-members', getTeamMembers);

export default router;
