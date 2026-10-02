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

export const getRecruiters = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const recruiters = await prisma.user.findMany({
      where: { role: 'RECRUITER' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        recruiterId: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        isActive: true,
        mustSetPassword: true,
        lastLoginAt: true,
        createdAt: true,
        assignedJobs: {
          select: { id: true },
        },
      },
    });

    sendSuccess(res, {
      recruiters: recruiters.map((r) => ({
        id: r.id,
        userId: r.id,
        recruiterId: r.recruiterId,
        name: r.fullName,
        email: r.email,
        phone: r.phone || '',
        location: '',
        recruiterType: 'Internal',
        experience: 0,
        specialization: [],
        assignedJobIds: r.assignedJobs.map((job) => job.id),
        submittedCount: 0,
        shortlistedCount: 0,
        interviewedCount: 0,
        selectedCount: 0,
        joinedCount: 0,
        replacementCount: 0,
        totalPayoutEarned: 0,
        pendingPayout: 0,
        status: r.isActive ? 'Active' : 'Inactive',
        mustSetPassword: r.mustSetPassword,
        lastLoginAt: r.lastLoginAt,
        avatar: r.avatarUrl || undefined,
        createdAt: r.createdAt,
      })),
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
