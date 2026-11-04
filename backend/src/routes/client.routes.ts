import { Router } from 'express';
import { getClients, createClient } from '../controllers/client.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Any authenticated role (Recruiter, TL, Admin, Super Admin) can view active companies for job creation & listing
router.get('/', authenticateJwt, getClients);

// Only Super Admin & Admin can create new Company/Client records
router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), createClient);

export default router;
