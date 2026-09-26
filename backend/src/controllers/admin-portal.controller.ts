import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess } from '../utils/response';

export const getAdminPortalData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const [
      clients, interviews, assessments, attempts, payouts, replacements, invoices,
      blogPosts, inquiries, notifications, emailTemplates, auditLogs
    ] = await Promise.all([
      prisma.client.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.interview.findMany({ orderBy: { scheduledAt: 'desc' }, take: 500 }),
      prisma.assessment.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.assessmentAttempt.findMany({ orderBy: { submittedAt: 'desc' }, take: 500 }),
      prisma.payout.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
      prisma.replacementCase.findMany({ orderBy: { requestedAt: 'desc' }, take: 500 }),
      prisma.invoice.findMany({ orderBy: { billingDate: 'desc' }, take: 500 }),
      prisma.blogPost.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.inquiry.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
      prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.emailTemplate.findMany({ orderBy: { updatedAt: 'desc' } }),
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
    ]);

    sendSuccess(res, {
      clients,
      interviews,
      assessments,
      attempts,
      payouts,
      replacements,
      invoices,
      blogPosts,
      inquiries,
      notifications,
      emailTemplates,
      auditLogs,
    });
  } catch (err) {
    next(err);
  }
};
