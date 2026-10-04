import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';
import { dispatchEmail } from '../services/email.service';

const createRecruiterSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180),
  phone: z.string().trim().max(30).optional(),
  avatarUrl: z.string().url().max(1000).optional(),
  recruiterType: z.enum(['INTERNAL', 'FREELANCER']).default('INTERNAL'),
});

const generateRecruiterId = async (): Promise<string> => {
  const recruiters = await prisma.user.findMany({
    where: {
      role: 'RECRUITER',
      recruiterId: { not: null },
    },
    select: { recruiterId: true },
  });

  let highest = 0;

  for (const recruiter of recruiters) {
    const match = recruiter.recruiterId?.match(/^REC-(\d+)$/);
    if (!match) continue;

    const number = Number(match[1]);
    if (Number.isFinite(number) && number > highest) {
      highest = number;
    }
  }

  return `REC-${String(highest + 1).padStart(4, '0')}`;
};

export const createRecruiter = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = createRecruiterSchema.parse(req.body);
    const email = data.email.trim().toLowerCase();

    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      sendError(res, 'A user with this email already exists', 409);
      return;
    }

    const recruiterId = await generateRecruiterId();

    // Generate a temporary password for first login. Only its bcrypt hash is stored.
    const temporaryPassword = crypto.randomBytes(9).toString('base64url').slice(0, 12);
    const temporaryPasswordHash = await bcrypt.hash(temporaryPassword, 12);

    // Create the recruiter and their default permissions atomically.
    const recruiter = await prisma.$transaction(async (tx) => {
      const createdRecruiter = await tx.user.create({
        data: {
          email,
          passwordHash: temporaryPasswordHash,
          fullName: data.fullName.trim(),
          role: 'RECRUITER',
          phone: data.phone?.trim() || undefined,
          avatarUrl: data.avatarUrl,
          recruiterId,
          recruiterType: data.recruiterType,
          mustSetPassword: true,
        },
        select: {
          id: true,
          recruiterId: true,
          email: true,
          fullName: true,
          role: true,
          phone: true,
          avatarUrl: true,
          isActive: true,
          mustSetPassword: true,
          recruiterType: true,
          createdAt: true,
        },
      });

      await tx.recruiterPermission.create({
        data: {
          recruiterId: createdRecruiter.id,
          dashboard: true,
          candidates: true,
          jobs: true,
          applications: true,
          interviews: true,
          payouts: false,
          reports: true,
          settings: true,
        },
      });

      return createdRecruiter;
    });

    await logAudit({
      req,
      action: 'CREATE_RECRUITER',
      module: 'RECRUITERS',
      entity: 'User',
      entityId: recruiter.id,
      newValue: {
        recruiterId: recruiter.recruiterId,
        email: recruiter.email,
        fullName: recruiter.fullName,
        role: recruiter.role,
      },
    });

    dispatchEmail('RECRUITER_WELCOME', recruiter.email, {
      recruiter_id: recruiter.recruiterId || '',
      recruiter_name: recruiter.fullName,
      recruiter_email: recruiter.email,
      temporary_password: temporaryPassword,
      login_url: config.recruiter.loginUrl,
    });

    sendSuccess(
      res,
      {
        recruiter: {
          id: recruiter.id,
          recruiterId: recruiter.recruiterId,
          email: recruiter.email,
          fullName: recruiter.fullName,
          role: recruiter.role,
          phone: recruiter.phone,
          avatarUrl: recruiter.avatarUrl,
          isActive: recruiter.isActive,
          mustSetPassword: recruiter.mustSetPassword,
          recruiterType: recruiter.recruiterType,
          createdAt: recruiter.createdAt,
        },
      },
      'Recruiter created successfully and temporary password sent by email.'
    );
  } catch (err) {
    next(err);
  }
};


export const updateRecruiterStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const recruiterId = req.params.id;

    if (!recruiterId) {
      sendError(res, 'Recruiter ID is required', 400);
      return;
    }

    const recruiter = await prisma.user.findFirst({
      where: {
        id: recruiterId,
        role: 'RECRUITER',
      },
      select: {
        id: true,
        recruiterId: true,
        email: true,
        fullName: true,
        isActive: true,
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    const nextStatus =
      typeof req.body?.isActive === 'boolean'
        ? req.body.isActive
        : undefined;

    if (nextStatus === undefined) {
      sendError(res, 'isActive must be a boolean', 400);
      return;
    }

    if (recruiter.isActive === nextStatus) {
      sendSuccess(
        res,
        {
          recruiter: {
            id: recruiter.id,
            recruiterId: recruiter.recruiterId,
            email: recruiter.email,
            fullName: recruiter.fullName,
            isActive: recruiter.isActive,
          },
        },
        `Recruiter is already ${nextStatus ? 'active' : 'inactive'}.`
      );
      return;
    }

    const updatedRecruiter = await prisma.user.update({
      where: { id: recruiter.id },
      data: { isActive: nextStatus },
      select: {
        id: true,
        recruiterId: true,
        email: true,
        fullName: true,
        isActive: true,
        updatedAt: true,
      },
    });

    await logAudit({
      req,
      action: nextStatus ? 'ACTIVATE_RECRUITER' : 'DEACTIVATE_RECRUITER',
      module: 'RECRUITERS',
      entity: 'User',
      entityId: updatedRecruiter.id,
      oldValue: {
        isActive: recruiter.isActive,
      },
      newValue: {
        isActive: updatedRecruiter.isActive,
      },
    });

    sendSuccess(
      res,
      {
        recruiter: updatedRecruiter,
      },
      `Recruiter ${nextStatus ? 'activated' : 'deactivated'} successfully.`
    );
  } catch (err) {
    next(err);
  }
};

const updateRecruiterJobsSchema = z.object({
  jobIds: z.array(z.string().uuid()).max(500),
});

export const getRecruiterJobs = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const recruiter = await prisma.user.findFirst({
      where: { id: req.params.id, role: 'RECRUITER' },
      select: {
        id: true,
        recruiterId: true,
        assignedJobs: {
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            jobCode: true,
            title: true,
            slug: true,
            location: true,
            status: true,
            publishedAt: true,
          },
        },
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    sendSuccess(res, {
      recruiterId: recruiter.recruiterId,
      jobs: recruiter.assignedJobs,
      jobIds: recruiter.assignedJobs.map((job) => job.id),
    });
  } catch (err) {
    next(err);
  }
};

export const updateRecruiterJobs = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const recruiterId = req.params.id;
    const data = updateRecruiterJobsSchema.parse(req.body);

    const recruiter = await prisma.user.findFirst({
      where: { id: recruiterId, role: 'RECRUITER' },
      select: {
        id: true,
        recruiterId: true,
        fullName: true,
        assignedJobs: {
          select: { id: true },
        },
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    const uniqueJobIds = [...new Set(data.jobIds)];

    const jobs = await prisma.job.findMany({
      where: { id: { in: uniqueJobIds } },
      select: { id: true, jobCode: true, title: true },
    });

    if (jobs.length !== uniqueJobIds.length) {
      sendError(res, 'One or more selected jobs were not found', 404);
      return;
    }

    const previousJobIds = recruiter.assignedJobs.map((job) => job.id);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: recruiter.id },
        data: {
          assignedJobs: {
            set: uniqueJobIds.map((id) => ({ id })),
          },
        },
      });
    });

    const addedJobIds = uniqueJobIds.filter((id) => !previousJobIds.includes(id));
    const removedJobIds = previousJobIds.filter((id) => !uniqueJobIds.includes(id));

    await logAudit({
      req,
      action: 'UPDATE_RECRUITER_JOB_ASSIGNMENTS',
      module: 'RECRUITERS',
      entity: 'User',
      entityId: recruiter.id,
      oldValue: {
        assignedJobIds: previousJobIds,
      },
      newValue: {
        assignedJobIds: uniqueJobIds,
        addedJobIds,
        removedJobIds,
      },
    });

    sendSuccess(
      res,
      {
        recruiter: {
          id: recruiter.id,
          recruiterId: recruiter.recruiterId,
          name: recruiter.fullName,
        },
        jobs,
        jobIds: uniqueJobIds,
      },
      'Recruiter job assignments updated successfully.'
    );
  } catch (err) {
    next(err);
  }
};


const updateRecruiterProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).nullable().optional(),
  avatarUrl: z.string().url().max(1000).nullable().optional(),
});

export const getMyRecruiterProfile = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      sendError(res, 'Authentication required', 401);
      return;
    }

    const recruiter = await prisma.user.findFirst({
      where: {
        id: userId,
        role: 'RECRUITER',
      },
      select: {
        id: true,
        recruiterId: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        isActive: true,
        isEmailVerified: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter account not found', 404);
      return;
    }

    sendSuccess(res, {
      profile: {
        id: recruiter.id,
        recruiterId: recruiter.recruiterId,
        email: recruiter.email,
        fullName: recruiter.fullName,
        phone: recruiter.phone,
        avatarUrl: recruiter.avatarUrl,
        isActive: recruiter.isActive,
        isEmailVerified: recruiter.isEmailVerified,
        lastLoginAt: recruiter.lastLoginAt,
        createdAt: recruiter.createdAt,
        updatedAt: recruiter.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const updateMyRecruiterProfile = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      sendError(res, 'Authentication required', 401);
      return;
    }

    const data = updateRecruiterProfileSchema.parse(req.body);

    const existingRecruiter = await prisma.user.findFirst({
      where: {
        id: userId,
        role: 'RECRUITER',
      },
      select: {
        id: true,
        recruiterId: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        isActive: true,
      },
    });

    if (!existingRecruiter) {
      sendError(res, 'Recruiter account not found', 404);
      return;
    }

    if (!existingRecruiter.isActive) {
      sendError(res, 'Recruiter account is inactive', 403);
      return;
    }

    const updatedRecruiter = await prisma.user.update({
      where: { id: existingRecruiter.id },
      data: {
        fullName: data.fullName.trim(),
        phone:
          data.phone === undefined
            ? existingRecruiter.phone
            : data.phone?.trim() || null,
        avatarUrl:
          data.avatarUrl === undefined
            ? existingRecruiter.avatarUrl
            : data.avatarUrl || null,
      },
      select: {
        id: true,
        recruiterId: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        isActive: true,
        updatedAt: true,
      },
    });

    await logAudit({
      req,
      action: 'UPDATE_RECRUITER_PROFILE',
      module: 'RECRUITERS',
      entity: 'User',
      entityId: updatedRecruiter.id,
      oldValue: {
        fullName: existingRecruiter.fullName,
        phone: existingRecruiter.phone,
        avatarUrl: existingRecruiter.avatarUrl,
      },
      newValue: {
        fullName: updatedRecruiter.fullName,
        phone: updatedRecruiter.phone,
        avatarUrl: updatedRecruiter.avatarUrl,
      },
    });

    sendSuccess(
      res,
      {
        profile: updatedRecruiter,
      },
      'Recruiter profile updated successfully.'
    );
  } catch (err) {
    next(err);
  }
};


type ProductivityRange = { from?: Date; to?: Date };

const getRecruiterMetricSnapshot = async (recruiterId: string, range: ProductivityRange = {}) => {
  const dateFilter = range.from || range.to
    ? {
        ...(range.from ? { gte: range.from } : {}),
        ...(range.to ? { lte: range.to } : {}),
      }
    : undefined;

  const recruiterCandidateScope = {
    OR: [
      { ownerRecruiterId: recruiterId },
      { createdById: recruiterId },
      { applications: { some: { recruiterId } } },
    ],
  };
  const candidateWhere: any = {
    ...recruiterCandidateScope,
    ...(dateFilter ? { createdAt: dateFilter } : {}),
  };

  const [candidateGroups, activityGroups] = await Promise.all([
    prisma.candidate.groupBy({
      by: ['status'],
      where: candidateWhere,
      _count: { _all: true },
    }),
    prisma.candidateActivity.groupBy({
      by: ['action'],
      where: {
        recruiterId,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
        candidate: { is: recruiterCandidateScope },
      },
      _count: { _all: true },
    }),
  ]);

  const candidateCounts = new Map(
    candidateGroups.map((group) => [group.status, group._count._all])
  );
  const activityCounts = new Map(
    activityGroups.map((group) => [group.action, group._count._all])
  );
  const countStatus = (status: string) => candidateCounts.get(status as any) || 0;
  const candidates = candidateGroups.reduce((total, group) => total + group._count._all, 0);

  return {
    candidates,
    submittedCount: candidates,
    shortlistedCount: countStatus('SHORTLISTED'),
    interviewedCount: countStatus('INTERVIEW'),
    selectedCount: countStatus('SELECTED'),
    joinedCount: countStatus('JOINED'),
    rejectedCount: countStatus('REJECTED'),
    walkInAttended: activityCounts.get('WALK_IN_ATTENDED') || 0,
    walkInScheduled: activityCounts.get('WALK_IN_SCHEDULED') || 0,
    walkInNoShow: activityCounts.get('WALK_IN_NO_SHOW') || 0,
    pendingCount: countStatus('NEW') + countStatus('SCREENING'),
  };
};
const parseAnalyticsRange = (req: Request): ProductivityRange => {
  const from = typeof req.query.dateFrom === 'string' ? new Date(req.query.dateFrom) : undefined;
  const to = typeof req.query.dateTo === 'string' ? new Date(req.query.dateTo) : undefined;
  if (to) to.setHours(23, 59, 59, 999);
  return {
    from: from && !Number.isNaN(from.getTime()) ? from : undefined,
    to: to && !Number.isNaN(to.getTime()) ? to : undefined,
  };
};

export const getRecruiterAnalytics = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const recruiterId = req.params.id;
    const recruiter = await prisma.user.findFirst({
      where: { id: recruiterId, role: 'RECRUITER' },
      select: {
        id: true,
        recruiterId: true,
        fullName: true,
        email: true,
        recruiterType: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        preferences: true,
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    const metrics = await getRecruiterMetricSnapshot(recruiterId, parseAnalyticsRange(req));
    sendSuccess(res, { recruiter, metrics });
  } catch (err) {
    next(err);
  }
};

export const getRecruiterProductivity = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const recruiterId = req.params.id;
    const recruiter = await prisma.user.findFirst({
      where: { id: recruiterId, role: 'RECRUITER' },
      select: { id: true, recruiterId: true, fullName: true, recruiterType: true },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    const range = parseAnalyticsRange(req);
    const from = range.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = range.to || new Date();
    to.setHours(23, 59, 59, 999);

    const activities = await prisma.candidateActivity.findMany({
      where: {
        recruiterId,
        createdAt: { gte: from, lte: to },
      },
      select: { action: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const buckets = new Map<string, {
      date: string;
      candidatesAdded: number;
      walkInsScheduled: number;
      walkInsAttended: number;
      walkInsNoShow: number;
      selected: number;
      joined: number;
    }>();

    for (const activity of activities) {
      const date = activity.createdAt.toISOString().slice(0, 10);
      const row = buckets.get(date) || {
        date,
        candidatesAdded: 0,
        walkInsScheduled: 0,
        walkInsAttended: 0,
        walkInsNoShow: 0,
        selected: 0,
        joined: 0,
      };
      if (activity.action === 'CANDIDATE_CREATED') row.candidatesAdded += 1;
      if (activity.action === 'WALK_IN_SCHEDULED') row.walkInsScheduled += 1;
      if (activity.action === 'WALK_IN_ATTENDED') row.walkInsAttended += 1;
      if (activity.action === 'WALK_IN_NO_SHOW') row.walkInsNoShow += 1;
      if (activity.action === 'SELECTED') row.selected += 1;
      if (activity.action === 'JOINED') row.joined += 1;
      buckets.set(date, row);
    }

    sendSuccess(res, {
      recruiter,
      range: { from, to },
      daily: Array.from(buckets.values()),
      totals: {
        candidatesAdded: Array.from(buckets.values()).reduce((n, x) => n + x.candidatesAdded, 0),
        walkInsScheduled: Array.from(buckets.values()).reduce((n, x) => n + x.walkInsScheduled, 0),
        walkInsAttended: Array.from(buckets.values()).reduce((n, x) => n + x.walkInsAttended, 0),
        walkInsNoShow: Array.from(buckets.values()).reduce((n, x) => n + x.walkInsNoShow, 0),
        selected: Array.from(buckets.values()).reduce((n, x) => n + x.selected, 0),
        joined: Array.from(buckets.values()).reduce((n, x) => n + x.joined, 0),
      },
    });
  } catch (err) {
    next(err);
  }
};

export const getRecruiters = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user;
    const where: any = {
      role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
    };

    if (user?.role === 'TEAM_LEADER') {
      where.teamLeaderId = user.userId;
    }

    const selectFields = {
      id: true,
      recruiterId: true,
      email: true,
      fullName: true,
      phone: true,
      avatarUrl: true,
      role: true,
      recruiterType: true,
      isActive: true,
      mustSetPassword: true,
      mfaEnabled: true,
      lastLoginAt: true,
      createdAt: true,
      teamLeaderId: true,
      teamLeader: {
        select: {
          id: true,
          fullName: true,
          email: true,
        },
      },
      assignedJobs: {
        select: { id: true },
      },
    };

    let recruiters;
    try {
      recruiters = await prisma.user.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: selectFields,
      });
    } catch (queryErr: any) {
      if (
        queryErr?.message?.includes('FREELANCE_RECRUITER') ||
        queryErr?.message?.includes('22P02')
      ) {
        console.warn(
          '[RECRUITER] PostgreSQL Role enum missing FREELANCE_RECRUITER. Triggering auto-heal...'
        );
        try {
          await prisma.$executeRawUnsafe(
            `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FREELANCE_RECRUITER';`
          );
        } catch (healErr) {
          console.warn('[RECRUITER] Auto-heal warning:', healErr);
        }

        // Retry with RECRUITER only if FREELANCE_RECRUITER is not immediately available
        recruiters = await prisma.user.findMany({
          where: { ...where, role: 'RECRUITER' },
          orderBy: { createdAt: 'asc' },
          select: selectFields,
        });
      } else {
        throw queryErr;
      }
    }

    const recruiterRecords = await Promise.all(recruiters.map(async (recruiter) => {
      const [
        metrics,
        replacementCount,
      ] = await Promise.all([
        getRecruiterMetricSnapshot(recruiter.id),
        prisma.replacementCase.count({
          where: {
            primaryCandidate: {
              is: { ownerRecruiterId: recruiter.id },
            },
          },
        }),
      ]);

      return {
        id: recruiter.id,
        userId: recruiter.id,
        recruiterId: recruiter.recruiterId,
        recruiterType: recruiter.recruiterType,
        role: recruiter.role,
        fullName: recruiter.fullName,
        name: recruiter.fullName,
        email: recruiter.email,
        phone: recruiter.phone || '',
        avatarUrl: recruiter.avatarUrl,
        avatar: recruiter.avatarUrl || undefined,
        teamLeaderId: recruiter.teamLeaderId,
        teamLeaderName: recruiter.teamLeader?.fullName || null,
        isActive: recruiter.isActive,
        status: recruiter.isActive ? 'Active' : 'Inactive',
        lastLoginAt: recruiter.lastLoginAt,
        mustSetPassword: recruiter.mustSetPassword,
        mfaEnabled: recruiter.mfaEnabled,
        createdAt: recruiter.createdAt,
        assignedJobIds: recruiter.assignedJobs.map((job) => job.id),
        submittedCount: metrics.submittedCount,
        shortlistedCount: metrics.shortlistedCount,
        interviewedCount: metrics.interviewedCount,
        selectedCount: metrics.selectedCount,
        joinedCount: metrics.joinedCount,
        replacementCount,
        totalPayoutEarned: 0,
        pendingPayout: 0,
        metrics,
      };
    }));

    sendSuccess(res, {
      recruiters: recruiterRecords,
      pagination: {
        total: recruiters.length,
        page: 1,
        limit: recruiters.length || 1,
        totalPages: 1,
      },
    });
  } catch (err) {
    next(err);
  }
};
