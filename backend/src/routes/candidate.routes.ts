import { Router } from 'express';
import {
  getCandidates,
  getCandidateById,
  updateCandidate,
  deleteCandidate,
} from '../controllers/candidate.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

router.get('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), getCandidates);
router.get('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), getCandidateById);
router.put('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), updateCandidate);
router.delete('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), deleteCandidate);

export default router;
