import { Router } from 'express';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';
import { runDynamoMigration } from '../scripts/migrate-dynamodb';

const router = Router();

let running = false;

router.post(
  '/dynamodb',
  authenticateJwt,
  requireRoles('SUPER_ADMIN'),
  async (req, res, next) => {
    if (process.env.DYNAMODB_MIGRATION_ENABLED !== 'true') {
      res.status(403).json({ success: false, message: 'DynamoDB migration endpoint is disabled.' });
      return;
    }

    if (running) {
      res.status(409).json({ success: false, message: 'A DynamoDB migration is already running.' });
      return;
    }

    const apply = req.query.apply === 'true';
    running = true;

    try {
      console.log(`[DDB MIGRATION] Started by ${req.user?.email}; apply=${apply}`);
      await runDynamoMigration(apply);
      res.json({
        success: true,
        mode: apply ? 'APPLY' : 'DRY-RUN',
        message: apply
          ? 'DynamoDB migration completed successfully.'
          : 'DynamoDB dry-run completed successfully. No PostgreSQL writes were performed.',
      });
    } catch (error) {
      next(error);
    } finally {
      running = false;
    }
  }
);

export default router;
