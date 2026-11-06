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
router.post('/candidates/:id/reject', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'), requirePermission('walkins'), rejectWalkInCandidate);
router.get('/sessions', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('walkins'), getWalkInSessions);
router.delete('/sessions/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('walkins'), deleteWalkInSession);
router.put('/sessions/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('walkins'), updateWalkInSession);


// Walk-in Location Management Routes (Admin Only)
router.get('/locations', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), requirePermission('walkins'), getWalkInLocations);
router.post(
  '/locations',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'),
  requirePermission('walkins'),
  createWalkInLocation
);
router.put(
  '/locations/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'),
  requirePermission('walkins'),
  updateWalkInLocation
);
router.patch(
  '/locations/:id/deactivate',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'),
  requirePermission('walkins'),
  deactivateWalkInLocation
);
router.put(
  '/locations/:id/deactivate',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'),
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
