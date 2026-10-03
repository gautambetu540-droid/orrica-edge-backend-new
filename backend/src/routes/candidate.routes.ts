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
  recruiterSubmitCandidate,
  checkDuplicateCandidate,
} from '../controllers/candidate.controller';
import { uploadResume } from '../middlewares/upload.middleware';
import {
  authenticateJwt,
  requireRoles,
  requireRecruiterPermission,
} from '../middlewares/auth.middleware';

const router = Router();

// Duplicate Candidate Check API
router.post(
  '/check-duplicate',
  authenticateJwt,
  checkDuplicateCandidate
);

router.post(
  '/recruiter-submit',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  uploadResume.single('resume'),
  recruiterSubmitCandidate
);

router.get(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  getCandidates
);

router.post(
  '/',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  createCandidate
);

router.get(
  '/:id/activities',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  getCandidateActivities
);

router.post(
  '/:id/activities',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  addCandidateActivity
);

router.patch(
  '/:id/assign-recruiter',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER'),
  assignCandidate
);

router.get(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  getCandidateById
);

router.put(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
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
