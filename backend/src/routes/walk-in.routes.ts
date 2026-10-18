import { Router } from 'express';
import { getWalkInConfirmation, submitWalkInConfirmation } from '../controllers/walk-in.controller';

const router = Router();

router.get('/confirm/:token', getWalkInConfirmation);
router.post('/confirm/:token', submitWalkInConfirmation);

export default router;
