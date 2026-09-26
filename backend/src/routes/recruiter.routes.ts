import { Router } from 'express';
import { getRecruiters } from '../controllers/recruiter.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

router.get('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'RECRUITER'), getRecruiters);

export default router;
