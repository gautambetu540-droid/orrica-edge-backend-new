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
import { authenticateJwt, requireRoles, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// Public candidate confirmation routes
router.get('/confirm/:token', getWalkInConfirmation);
router.post('/confirm/:token', submitWalkInConfirmation);

// Admin/recruiter session management routes
router.post('/candidates/:id/reject', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER'), requirePermission('walkins'), rejectWalkInCandidate);
router.get('/sessions', authenticateJwt, requirePermission('walkins'), getWalkInSessions);
router.delete('/sessions/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('walkins'), deleteWalkInSession);
router.put('/sessions/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'TEAM_LEADER'), requirePermission('walkins'), updateWalkInSession);


// Walk-in Location Management Routes
router.get('/locations', getWalkInLocations);
router.post(
  '/locations',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER'),
  requirePermission('walkins'),
  createWalkInLocation
);
router.put(
  '/locations/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER'),
  requirePermission('walkins'),
  updateWalkInLocation
);
router.patch(
  '/locations/:id/deactivate',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER'),
  requirePermission('walkins'),
  deactivateWalkInLocation
);
router.put(
  '/locations/:id/deactivate',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER'),
  requirePermission('walkins'),
  deactivateWalkInLocation
);
router.delete(
  '/locations/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'),
  requirePermission('walkins'),
  deleteWalkInLocation
);

export default router;
