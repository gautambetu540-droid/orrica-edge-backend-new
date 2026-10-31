import { Router } from 'express';
import {
  getEmailTemplates,
  getEmailTemplateByKey,
  updateEmailTemplate,
  resetEmailTemplateToDefault,
  previewEmailTemplate,
  sendTestEmail,
  getEmailLogs,
} from '../controllers/template.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Protected admin routes for email template control
router.get('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), getEmailTemplates);
router.get('/logs', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), getEmailLogs);
router.post('/preview', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), previewEmailTemplate);
router.post('/send-test', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), sendTestEmail);

router.get('/:key', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), getEmailTemplateByKey);
router.put('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), updateEmailTemplate);
router.post('/:id/reset', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'), resetEmailTemplateToDefault);

export default router;
