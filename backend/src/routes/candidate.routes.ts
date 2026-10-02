import { Router } from 'express';
import {
  getCandidates,
  createCandidate,
  getCandidateById,
  updateCandidate,
  deleteCandidate,
  assignCandidate,
  addCandidateActivity,
  getCandidateActivities,
} from '../controllers/candidate.controller';
import {
  authenticateJwt,
  requireRoles,
  requireRecruiterPermission,
} from '../middlewares/auth.middleware';

const router = Router();

router.get(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  requireRecruiterPermission('candidates'),
  getCandidates
);

router.post(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  requireRecruiterPermission('candidates'),
  createCandidate
);

router.get(
  '/:id/activities',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  requireRecruiterPermission('candidates'),
  getCandidateActivities
);

router.post(
  '/:id/activities',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  requireRecruiterPermission('candidates'),
  addCandidateActivity
);

router.patch(
  '/:id/assign-recruiter',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  assignCandidate
);

router.get(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  requireRecruiterPermission('candidates'),
  getCandidateById
);

router.put(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'),
  requireRecruiterPermission('candidates'),
  updateCandidate
);

router.delete(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  deleteCandidate
);

export default router;
