import { Router } from 'express';
import {
  getWalkInConfirmation,
  submitWalkInConfirmation,
  getWalkInSessions,
  updateWalkInSession,
} from '../controllers/walk-in.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Public candidate confirmation routes
router.get('/confirm/:token', getWalkInConfirmation);
router.post('/confirm/:token', submitWalkInConfirmation);

// Admin/recruiter session management routes
router.get('/sessions', authenticateJwt, getWalkInSessions);
router.put('/sessions/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER'), updateWalkInSession);

export default router;
