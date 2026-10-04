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
  role: z.enum(['RECRUITER', 'FREELANCE_RECRUITER']).default('RECRUITER'),
  password: z.string().min(6).max(100).optional(),
  temporaryPassword: z.string().min(6).max(100).optional(),
});

const updateRecruiterSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  avatarUrl: z.union([z.string().url().max(1000), z.literal('')]).nullable().optional(),
  recruiterType: z.enum(['INTERNAL', 'FREELANCER']).optional(),
  teamLeaderId: z.string().nullable().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
});


const generateRecruiterId = async (): Promise<string> => {
  const recruiters = await prisma.user.findMany({
    where: {
      role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
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

    // Determine temporary password: use provided password or generate a clean strong default
    const rawPassword =
      (typeof data.password === 'string' && data.password.trim()) ||
      (typeof data.temporaryPassword === 'string' && data.temporaryPassword.trim());
    const temporaryPassword = rawPassword || `Orrica@${crypto.randomBytes(4).toString('hex')}`;
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    // Generate secure one-time password setup token (valid for 24h)
    const rawSetupToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    const tokenExpiry = new Date(Date.now() + config.recruiter.passwordSetupExpiryHours * 60 * 60 * 1000);

    // Create the recruiter and their default permissions atomically.
    const recruiter = await prisma.$transaction(async (tx) => {
      const createdRecruiter = await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName: data.fullName.trim(),
          role: data.role || (data.recruiterType === 'FREELANCER' ? 'FREELANCE_RECRUITER' : 'RECRUITER'),
          phone: data.phone?.trim() || undefined,
          avatarUrl: data.avatarUrl,
          recruiterId,
          recruiterType: data.recruiterType,
          mustSetPassword: true,
          resetPasswordToken: tokenHash,
          resetPasswordExpires: tokenExpiry,
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

    const setupUrl = `${config.recruiter.passwordSetupUrl}?token=${rawSetupToken}&email=${encodeURIComponent(email)}`;

    dispatchEmail('RECRUITER_WELCOME', recruiter.email, {
      recruiter_id: recruiter.recruiterId || '',
      recruiter_name: recruiter.fullName,
      recruiter_email: recruiter.email,
      temporary_password: temporaryPassword,
      setup_url: setupUrl,
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
        temporaryPassword,
      },
      'Recruiter created successfully and welcome email dispatched with login credentials.'
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
        role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
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
      where: { id: req.params.id, role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] } },
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
      where: { id: recruiterId, role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] } },
      select: {
        id: true,
        recruiterId: true,
        fullName: true,
        isActive: true,
        assignedJobs: {
          select: { id: true },
        },
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    if (!recruiter.isActive) {
      sendError(res, 'Cannot assign jobs to an inactive recruiter.', 400);
      return;
    }

    const uniqueJobIds = [...new Set(data.jobIds)];

    const jobs = await prisma.job.findMany({
      where: { id: { in: uniqueJobIds } },
      select: { id: true, jobCode: true, title: true, status: true },
    });

    if (jobs.length !== uniqueJobIds.length) {
      sendError(res, 'One or more selected jobs were not found', 404);
      return;
    }

    const inactiveJobs = jobs.filter((job) => job.status === 'ARCHIVED' || job.status === 'CLOSED');
    if (inactiveJobs.length > 0) {
      sendError(res, `Cannot assign inactive jobs: ${inactiveJobs.map((j) => j.title).join(', ')}`, 400);
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
        role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
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
        role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
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
      where: { id: recruiterId, role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] } },
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
      where: { id: recruiterId, role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] } },
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

    const recruiters = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: selectFields,
    });

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

/**
 * GET Recruiter by ID: GET /api/recruiters/:id
 */
export const getRecruiterById = async (
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
        role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
      },
      select: {
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
        recruiterPermissions: true,
        assignedJobs: {
          select: {
            id: true,
            jobCode: true,
            title: true,
            department: true,
            status: true,
            location: true,
          },
        },
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    const metrics = await getRecruiterMetricSnapshot(recruiter.id);

    sendSuccess(res, {
      recruiter: {
        ...recruiter,
        name: recruiter.fullName,
        avatar: recruiter.avatarUrl,
        metrics,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * UPDATE Recruiter: PUT /api/recruiters/:id or PATCH /api/recruiters/:id
 */
export const updateRecruiter = async (
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

    const data = updateRecruiterSchema.parse(req.body);

    const recruiter = await prisma.user.findFirst({
      where: {
        id: recruiterId,
        role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    const nextFullName = (data.fullName || data.name)?.trim() || recruiter.fullName;
    const nextPhone =
      data.phone !== undefined ? (data.phone ? data.phone.trim() : null) : recruiter.phone;
    const nextAvatarUrl =
      data.avatarUrl !== undefined ? (data.avatarUrl ? data.avatarUrl : null) : recruiter.avatarUrl;
    const nextRecruiterType = data.recruiterType || recruiter.recruiterType;
    const nextIsActive = data.isActive !== undefined ? data.isActive : recruiter.isActive;
    const nextTeamLeaderId =
      data.teamLeaderId !== undefined
        ? data.teamLeaderId
          ? data.teamLeaderId
          : null
        : recruiter.teamLeaderId;

    const updated = await prisma.user.update({
      where: { id: recruiter.id },
      data: {
        fullName: nextFullName,
        phone: nextPhone,
        avatarUrl: nextAvatarUrl,
        recruiterType: nextRecruiterType,
        isActive: nextIsActive,
        teamLeaderId: nextTeamLeaderId,
      },
      select: {
        id: true,
        recruiterId: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        role: true,
        recruiterType: true,
        isActive: true,
        teamLeaderId: true,
        updatedAt: true,
      },
    });

    await logAudit({
      req,
      action: 'UPDATE_RECRUITER',
      module: 'RECRUITERS',
      entity: 'User',
      entityId: recruiter.id,
      oldValue: {
        fullName: recruiter.fullName,
        phone: recruiter.phone,
        recruiterType: recruiter.recruiterType,
        isActive: recruiter.isActive,
      },
      newValue: {
        fullName: updated.fullName,
        phone: updated.phone,
        recruiterType: updated.recruiterType,
        isActive: updated.isActive,
      },
    });

    sendSuccess(res, { recruiter: updated }, 'Recruiter updated successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE Recruiter: DELETE /api/recruiters/:id
 * Safeguarded deletion:
 * 1. Checks active mandates and non-terminal applications. If present, returns RECRUITER_HAS_ACTIVE_ASSIGNMENTS.
 * 2. If historical records exist, deactivates instead of deleting to preserve database integrity.
 * 3. If completely fresh with zero records, permanently deletes.
 */
export const deleteRecruiter = async (
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
        role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        recruiterId: true,
        isActive: true,
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    // 1. Check active job assignments
    const activeJobsCount = await prisma.job.count({
      where: {
        assignedRecruiters: { some: { id: recruiter.id } },
        status: 'PUBLISHED',
      },
    });

    // 2. Check active candidate applications (non-terminal)
    const activeAppsCount = await prisma.application.count({
      where: {
        recruiterId: recruiter.id,
        stage: { notIn: ['REJECTED', 'JOINED'] },
      },
    });

    if (activeJobsCount > 0 || activeAppsCount > 0) {
      sendError(
        res,
        `Cannot delete recruiter with active mandates (${activeJobsCount}) or in-progress candidate applications (${activeAppsCount}). Reassign them before deleting.`,
        409,
        'RECRUITER_HAS_ACTIVE_ASSIGNMENTS'
      );
      return;
    }

    // 3. Check historical records
    const [historicalCandidates, historicalApps, historicalTimelines] = await Promise.all([
      prisma.candidate.count({
        where: {
          OR: [
            { sourcingRecruiterId: recruiter.id },
            { ownerRecruiterId: recruiter.id },
            { createdById: recruiter.id },
          ],
        },
      }),
      prisma.application.count({ where: { recruiterId: recruiter.id } }),
      prisma.candidateTimeline.count({ where: { userId: recruiter.id } }),
    ]);

    const totalHistorical = historicalCandidates + historicalApps + historicalTimelines;

    if (totalHistorical > 0) {
      // Historical references exist: soft-delete to preserve data integrity and audit trail
      await prisma.user.update({
        where: { id: recruiter.id },
        data: { isActive: false },
      });

      await logAudit({
        req,
        action: 'DEACTIVATE_RECRUITER',
        module: 'RECRUITERS',
        entity: 'User',
        entityId: recruiter.id,
        oldValue: { isActive: recruiter.isActive },
        newValue: { isActive: false, reason: 'Archived due to historical records' },
      });

      sendSuccess(
        res,
        {
          deleted: false,
          deactivated: true,
          message:
            'Recruiter account was deactivated rather than permanently removed because historical hiring activities are attached to this account.',
        },
        'Recruiter deactivated successfully.'
      );
      return;
    }

    // 4. No historical records: safe permanent hard delete in transaction
    await prisma.$transaction(async (tx) => {
      await tx.recruiterPermission.deleteMany({ where: { recruiterId: recruiter.id } });
      await tx.refreshToken.deleteMany({ where: { userId: recruiter.id } });
      await tx.user.delete({ where: { id: recruiter.id } });
    });

    await logAudit({
      req,
      action: 'DELETE_RECRUITER',
      module: 'RECRUITERS',
      entity: 'User',
      entityId: recruiter.id,
      oldValue: {
        recruiterId: recruiter.recruiterId,
        email: recruiter.email,
        fullName: recruiter.fullName,
      },
    });

    sendSuccess(res, { deleted: true }, 'Recruiter permanently deleted.');
  } catch (err) {
    next(err);
  }
};

/**
 * Send / Resend Recruiter Welcome Email: POST /api/admin/recruiters/:id/send-welcome or POST /api/recruiters/:id/send-welcome
 * Generates a fresh secure setup token, sets mustSetPassword: true, and dispatches the welcome email.
 */
export const sendRecruiterWelcomeEmail = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const identifier = req.params.id;
    if (!identifier) {
      sendError(res, 'Recruiter ID is required.', 400);
      return;
    }

    const recruiter = await prisma.user.findFirst({
      where: {
        OR: [
          { id: identifier },
          { recruiterId: identifier },
        ],
        role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found.', 404);
      return;
    }

    if (!recruiter.isActive) {
      sendError(res, 'Cannot send welcome email to an inactive recruiter account.', 400);
      return;
    }

    // Determine temporary password: use provided password or generate a clean strong default
    const rawPassword =
      (typeof req.body?.password === 'string' && req.body.password.trim()) ||
      (typeof req.body?.temporaryPassword === 'string' && req.body.temporaryPassword.trim());
    const temporaryPassword = rawPassword || `Orrica@${crypto.randomBytes(4).toString('hex')}`;
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    // Generate secure one-time password setup token (valid for configured hours, default 24h)
    const rawSetupToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    const expiryHours = config.recruiter.passwordSetupExpiryHours || 24;
    const tokenExpiry = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: recruiter.id },
      data: {
        passwordHash,
        mustSetPassword: true,
        resetPasswordToken: tokenHash,
        resetPasswordExpires: tokenExpiry,
      },
    });

    const setupUrl = `${config.recruiter.passwordSetupUrl}?token=${rawSetupToken}&email=${encodeURIComponent(recruiter.email)}`;

    dispatchEmail('RECRUITER_WELCOME', recruiter.email, {
      recruiter_id: recruiter.recruiterId || '',
      recruiter_name: recruiter.fullName,
      recruiter_email: recruiter.email,
      temporary_password: temporaryPassword,
      setup_url: setupUrl,
      login_url: config.recruiter.loginUrl,
    });

    await logAudit({
      req,
      action: 'SEND_RECRUITER_WELCOME_EMAIL',
      module: 'RECRUITERS',
      entity: 'User',
      entityId: recruiter.id,
      newValue: {
        recruiterId: recruiter.recruiterId,
        email: recruiter.email,
        expiryHours,
      },
    });

    sendSuccess(
      res,
      {
        id: recruiter.id,
        recruiterId: recruiter.recruiterId,
        email: recruiter.email,
        temporaryPassword,
        sent: true,
      },
      `Welcome email dispatched successfully to ${recruiter.email} with credentials.`
    );
  } catch (err) {
    next(err);
  }
};


