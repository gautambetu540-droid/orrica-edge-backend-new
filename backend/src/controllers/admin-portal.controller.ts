import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';

export const getAdminPortalData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const [
      clients, candidates, jobs, recruiters, interviews, assessments, attempts, payouts, replacements, invoices,
      blogPosts, inquiries, notifications, emailTemplates, auditLogs
    ] = await Promise.all([
      prisma.client.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.candidate.findMany({
        orderBy: { createdAt: 'desc' },
        take: 1000,
        include: {
          applications: {
            orderBy: { appliedAt: 'desc' },
            select: {
              id: true,
              jobId: true,
              stage: true,
              appliedAt: true,
              updatedAt: true,
              job: {
                select: {
                  id: true,
                  title: true,
                  jobCode: true,
                  department: true,
                },
              },
              recruiter: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          },
          _count: {
            select: {
              applications: true,
              assessmentAttempts: true,
            },
          },
        },
      }),
      prisma.job.findMany({ include: { client: true, createdBy: { select: { id: true, fullName: true, email: true, role: true } } }, orderBy: { createdAt: 'desc' }, take: 1000 }),
      prisma.user.findMany({
        where: { role: { in: ['RECRUITER', 'FREELANCE_RECRUITER', 'TEAM_LEADER', 'ADMIN', 'SUPER_ADMIN'] } },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          phone: true,
          isActive: true,
          createdAt: true,
          recruiterId: true,
          recruiterType: true,
          teamLeaderId: true,
          teamLeader: { select: { id: true, fullName: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),

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
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
            },
          },
        },
      }),
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

    const mappedAuditLogs = auditLogs.map((log: any) => ({
      id: log.id,
      userId: log.userId,
      actorName: log.user?.fullName || log.user?.email || 'System User',
      actorRole: log.user?.role || 'ADMIN',
      userName: log.user?.fullName || log.user?.email || 'System User',
      role: log.user?.role || 'ADMIN',
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      entityType: log.module,
      entityName: log.entity,
      previousValue: log.oldValue ? (typeof log.oldValue === 'string' ? log.oldValue : JSON.stringify(log.oldValue)) : '',
      newValue: log.newValue ? (typeof log.newValue === 'string' ? log.newValue : JSON.stringify(log.newValue)) : '',
      metadata: log.newValue || log.oldValue || null,
      timestamp: log.createdAt,
      createdAt: log.createdAt,
      ipAddress: log.ipAddress || '127.0.0.1',
    }));

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
      auditLogs: mappedAuditLogs,
    });
  } catch (err) {
    next(err);
  }
};

export const getAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawLogs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
          },
        },
      },
    });

    const auditLogs = rawLogs.map((log: any) => ({
      id: log.id,
      userId: log.userId,
      actorName: log.user?.fullName || log.user?.email || 'System User',
      actorRole: log.user?.role || 'ADMIN',
      userName: log.user?.fullName || log.user?.email || 'System User',
      role: log.user?.role || 'ADMIN',
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      entityType: log.module,
      entityName: log.entity,
      previousValue: log.oldValue ? (typeof log.oldValue === 'string' ? log.oldValue : JSON.stringify(log.oldValue)) : '',
      newValue: log.newValue ? (typeof log.newValue === 'string' ? log.newValue : JSON.stringify(log.newValue)) : '',
      metadata: log.newValue || log.oldValue || null,
      timestamp: log.createdAt,
      createdAt: log.createdAt,
      ipAddress: log.ipAddress || '127.0.0.1',
    }));

    sendSuccess(res, { auditLogs });
  } catch (err) {
    next(err);
  }
};

export const createEmployeeUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({
      fullName: z.string().trim().min(2).max(120),
      email: z.string().trim().email().toLowerCase(),
      phone: z.string().trim().max(30).optional(),
      role: z.enum(['ADMIN', 'SUPER_ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER']).default('RECRUITER'),
      department: z.string().trim().optional(),
      designation: z.string().trim().optional(),
      teamLeaderId: z.string().uuid().nullable().optional(),
      permissions: z.array(z.string()).optional(),
    });

    const data = schema.parse(req.body);
    const existing = await prisma.user.findUnique({
      where: { email: data.email },
      select: { id: true },
    });
    if (existing) {
      sendError(res, 'A user with this email address already exists.', 409);
      return;
    }

    const temporaryPassword = crypto.randomBytes(9).toString('base64url').slice(0, 12);
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    let recruiterId: string | null = null;
    let recruiterType: 'INTERNAL' | 'FREELANCER' | null = null;

    if (data.role === 'RECRUITER' || data.role === 'FREELANCE_RECRUITER') {
      const recruiters = await prisma.user.findMany({
        where: { role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] }, recruiterId: { not: null } },
        select: { recruiterId: true },
      });
      let highest = 0;
      for (const rec of recruiters) {
        const match = rec.recruiterId?.match(/^REC-(\d+)$/);
        if (!match) continue;
        const number = Number(match[1]);
        if (Number.isFinite(number) && number > highest) highest = number;
      }
      recruiterId = `REC-${String(highest + 1).padStart(4, '0')}`;
      recruiterType = data.role === 'FREELANCE_RECRUITER' ? 'FREELANCER' : 'INTERNAL';
    }

    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        fullName: data.fullName,
        role: data.role as any,
        phone: data.phone || undefined,
        recruiterId,
        recruiterType: recruiterType || undefined,
        teamLeaderId: data.teamLeaderId || null,
        mustSetPassword: true,
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phone: true,
        recruiterId: true,
        recruiterType: true,
        teamLeaderId: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (data.role === 'RECRUITER' || data.role === 'FREELANCE_RECRUITER') {
      await prisma.recruiterPermission.create({
        data: {
          recruiterId: user.id,
          dashboard: true,
          candidates: true,
          jobs: true,
          applications: true,
          interviews: true,
          payouts: data.role === 'FREELANCE_RECRUITER',
          reports: false,
          settings: false,
        },
      });
    }

    await logAudit({
      req,
      action: 'CREATE_EMPLOYEE',
      module: 'USERS',
      entity: 'User',
      entityId: user.id,
      newValue: { fullName: user.fullName, email: user.email, role: user.role },
    });

    sendSuccess(res, { employee: user, temporaryPassword }, 'Employee account created successfully', 201);
  } catch (err) {
    next(err);
  }
};

export const getEmployeeUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const select = {
      id: true,
      email: true,
      fullName: true,
      role: true,
      phone: true,
      isActive: true,
      recruiterId: true,
      recruiterType: true,
      teamLeaderId: true,
      teamLeader: { select: { id: true, fullName: true, email: true } },
      createdAt: true,
    };

    let employees;
    try {
      employees = await prisma.user.findMany({
        where: {
          role: { in: ['ADMIN', 'SUPER_ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'] },
        },
        select,
        orderBy: { createdAt: 'desc' },
      });
    } catch (queryErr: any) {
      if (queryErr?.message?.includes('FREELANCE_RECRUITER') || queryErr?.message?.includes('22P02')) {
        try {
          await prisma.$executeRawUnsafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FREELANCE_RECRUITER';`);
          await prisma.$executeRawUnsafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'TEAM_LEADER';`);
        } catch (_) {}
        employees = await prisma.user.findMany({
          where: {
            role: { in: ['ADMIN', 'SUPER_ADMIN', 'RECRUITER'] },
          },
          select,
          orderBy: { createdAt: 'desc' },
        });
      } else {
        throw queryErr;
      }
    }

    sendSuccess(res, { employees });
  } catch (err) {
    next(err);
  }
};
