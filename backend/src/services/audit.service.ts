import { Request } from 'express';
import { prisma } from '../prisma/client';

export interface RecordAuditOptions {
  req?: Request;
  userId?: string;
  action: string;
  module: string;
  entity: string;
  entityId: string;
  oldValue?: any;
  newValue?: any;
}

export const logAudit = async (options: RecordAuditOptions): Promise<void> => {
  const { req, userId, action, module, entity, entityId, oldValue, newValue } = options;

  const resolvedUserId = userId || req?.user?.userId || null;
  const ipAddress = req?.ip || req?.socket?.remoteAddress || null;
  const userAgent = req?.headers['user-agent'] || null;

  try {
    await prisma.auditLog.create({
      data: {
        userId: resolvedUserId,
        action,
        module,
        entity,
        entityId,
        oldValue: oldValue ? oldValue : null,
        newValue: newValue ? newValue : null,
        ipAddress: typeof ipAddress === 'string' ? ipAddress : null,
        userAgent,
      },
    });
  } catch (err: any) {
    console.error('[AUDIT LOG ERROR]:', err.message);
  }
};
