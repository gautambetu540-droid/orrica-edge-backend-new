import { Router } from 'express';
import {
  getWalkInConfirmation,
  submitWalkInConfirmation,
  getWalkInSessions,
  updateWalkInSession,
  deleteWalkInSession,
  getWalkInLocations,
  createWalkInLocation,
  updateWalkInLocation,
  deactivateWalkInLocation,
  deleteWalkInLocation,
  rejectWalkInCandidate,
} from '../controllers/walk-in.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Public candidate confirmation routes
router.get('/confirm/:token', getWalkInConfirmation);
router.post('/confirm/:token', submitWalkInConfirmation);

// Admin/recruiter session management routes
router.post('/candidates/:id/reject', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER'), rejectWalkInCandidate);
router.get('/sessions', authenticateJwt, getWalkInSessions);
router.delete('/sessions/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), deleteWalkInSession);
router.put('/sessions/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER'), updateWalkInSession);


// Walk-in Location Management Routes
router.get('/locations', getWalkInLocations);
router.post(
  '/locations',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER'),
  createWalkInLocation
);
router.put(
  '/locations/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER'),
  updateWalkInLocation
);
router.patch(
  '/locations/:id/deactivate',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER'),
  deactivateWalkInLocation
);
router.put(
  '/locations/:id/deactivate',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER'),
  deactivateWalkInLocation
);
router.delete(
  '/locations/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  deleteWalkInLocation
);

export default router;
