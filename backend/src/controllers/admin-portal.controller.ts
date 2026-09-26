import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess } from '../utils/response';

export const getAdminPortalData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const [
      clients, candidates, jobs, recruiters, interviews, assessments, attempts, payouts, replacements, invoices,
      blogPosts, inquiries, notifications, emailTemplates, auditLogs
    ] = await Promise.all([
      prisma.client.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.candidate.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 }),
      prisma.job.findMany({ include: { client: true, createdBy: { select: { id: true, fullName: true, email: true, role: true } } }, orderBy: { createdAt: 'desc' }, take: 1000 }),
      prisma.user.findMany({ where: { role: { in: ['RECRUITER', 'ADMIN', 'SUPER_ADMIN'] } }, select: { id: true, email: true, fullName: true, role: true, phone: true, isActive: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
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

    const questions = assessments.flatMap((assessment: any) => {
      const items = Array.isArray(assessment.questions) ? assessment.questions : [];
      return items.map((q: any, index: number) => ({
        id: String(q.id || `${assessment.id}-${index + 1}`),
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options : [],
        correctAnswer: q.correctOption ?? q.correctAnswer ?? null,
        explanation: q.explanation ?? '',
        difficulty: q.level || assessment.category || 'General',
        skill: q.section || assessment.category || 'General',
        language: 'English',
        assessmentId: assessment.id,
        assessmentTitle: assessment.title,
      }));
    });

    sendSuccess(res, {
      clients,
      candidates,
      jobs,
      recruiters,
      interviews,
      assessments,
      questions,
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
