import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
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

    // Only the hash is stored. The raw setup token is sent once by email.
    const setupToken = crypto.randomBytes(32).toString('hex');
    const setupTokenHash = crypto.createHash('sha256').update(setupToken).digest('hex');

    const setupExpiresAt = new Date(
      Date.now() + config.recruiter.passwordSetupExpiryHours * 60 * 60 * 1000
    );

    // Create the recruiter and their default permissions atomically.
    const recruiter = await prisma.$transaction(async (tx) => {
      const createdRecruiter = await tx.user.create({
        data: {
          email,
          passwordHash: setupTokenHash,
          fullName: data.fullName.trim(),
          role: 'RECRUITER',
          phone: data.phone?.trim() || undefined,
          avatarUrl: data.avatarUrl,
          recruiterId,
          mustSetPassword: true,
          resetPasswordToken: setupTokenHash,
          resetPasswordExpires: setupExpiresAt,
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

    const setupUrl =
      `${config.recruiter.passwordSetupUrl}?token=${encodeURIComponent(setupToken)}&email=${encodeURIComponent(recruiter.email)}`;

    dispatchEmail('RECRUITER_WELCOME', recruiter.email, {
      recruiter_id: recruiter.recruiterId || '',
      recruiter_name: recruiter.fullName,
      recruiter_email: recruiter.email,
      password_setup_url: setupUrl,
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
      'Recruiter created successfully and welcome email queued.'
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
        assignedJobIds: [],
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
