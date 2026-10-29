import { Router } from 'express';
import {
  getCandidates,
  createCandidate,
  getCandidateById,
  updateCandidate,
  deleteCandidate,
  assignCandidate,
  assignJobToCandidate,
  bulkAssignJobToCandidates,
  addCandidateActivity,
  getCandidateActivities,
  recruiterSubmitCandidate,
  checkDuplicateCandidate,
  getCandidateTimeline,
  updateCandidateStatus,
  resendWalkInEmail,
  sendWalkInInvitation,
  approveWalkInReschedule,
  bulkImportCandidates,
  downloadCandidateImportTemplate,
  archiveCandidate,
  bulkArchiveCandidates,
  restoreCandidate,
  getArchivedCandidatesCount,
} from '../controllers/candidate.controller';
import { uploadResume, uploadSpreadsheet } from '../middlewares/upload.middleware';
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

router.get(
  '/walk-ins',
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



// Archived Candidates Real Count (Must precede /:id)
router.get(
  '/archived/count',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  getArchivedCandidatesCount
);

// Bulk Archive Candidates API (Must precede /:id)
router.post(
  '/bulk-archive',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  bulkArchiveCandidates
);

// Single Candidate Archive API
router.post(
  '/:id/archive',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  archiveCandidate
);

// Single Candidate Restore API
router.post(
  '/:id/restore',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  restoreCandidate
);

// Bulk Job Assignment API (Must be before /:id routes)
router.post(
  '/bulk-assign-job',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  bulkAssignJobToCandidates
);

// Single Candidate Job Assignment API
router.post(
  '/:id/assign-job',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  assignJobToCandidate
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

router.patch(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  updateCandidate
);

router.patch(
  '/:id/status',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  updateCandidateStatus
);

router.put(
  '/:id/status',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  updateCandidateStatus
);

router.get(
  '/:id/timeline',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  getCandidateTimeline
);

router.get(
  '/:id/history',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  getCandidateTimeline
);

router.delete(
  '/:id',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN'),
  deleteCandidate
);


// Walk-in Management & Confirmation routes
router.post(
  '/:id/resend-walk-in-email',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  resendWalkInEmail
);

router.post(
  '/:id/send-walk-in-invitation',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  sendWalkInInvitation
);

router.post(
  '/:id/approve-walk-in-reschedule',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  approveWalkInReschedule
);


// Candidate Import Template Download
router.get(
  '/template/download',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  downloadCandidateImportTemplate
);

// Bulk Candidate Import Dry-Run Validation API
router.post(
  '/bulk-import-validate',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  uploadSpreadsheet.single('file'),
  (req, res, next) => {
    req.body = req.body || {};
    req.body.dryRun = true;
    return bulkImportCandidates(req, res, next);
  }
);

// Bulk Candidate Import Execution API
router.post(
  '/bulk-import',
  authenticateJwt,
  requireRoles('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'),
  requireRecruiterPermission('candidates'),
  uploadSpreadsheet.single('file'),
  bulkImportCandidates
);

export default router;
