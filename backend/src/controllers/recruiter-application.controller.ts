import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';
import { dispatchEmail } from '../services/email.service';

const recruiterApplicationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180),
  phone: z.string().trim().min(7).max(30),
  location: z.string().trim().min(2).max(120),
  experienceYears: z.coerce.number().min(0).max(60).default(0),
  primaryDomain: z.string().max(120).optional(),
  currentCompany: z.string().max(200).optional(),
  linkedinUrl: z.union([z.string().url().max(1000), z.literal('')]).optional(),
  message: z.string().max(5000).optional(),
  resumeUrl: z.union([z.string().url().max(2000), z.literal('')]).optional(),
  resumeFileName: z.string().max(255).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['NEW', 'REVIEWING', 'CONTACTED', 'APPROVED', 'REJECTED']),
  adminNotes: z.string().max(5000).optional(),
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

/**
 * 1. Submit Public Recruiter Application: POST /api/recruiter-applications
 */
export const submitRecruiterApplication = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = recruiterApplicationSchema.parse(req.body);
    const email = data.email.trim().toLowerCase();

    // Check if an application already exists for this email
    const existing = await prisma.recruiterApplication.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });

    if (existing && (existing.status === 'NEW' || existing.status === 'REVIEWING')) {
      sendError(
        res,
        'An application with this email is already under review. Our team will contact you shortly.',
        409
      );
      return;
    }

    const application = await prisma.recruiterApplication.create({
      data: {
        fullName: data.fullName.trim(),
        email,
        phone: data.phone.trim(),
        location: data.location.trim(),
        experienceYears: data.experienceYears,
        primaryDomain: data.primaryDomain?.trim() || null,
        currentCompany: data.currentCompany?.trim() || null,
        linkedinUrl: data.linkedinUrl?.trim() || null,
        message: data.message?.trim() || null,
        resumeUrl: data.resumeUrl?.trim() || null,
        resumeFileName: data.resumeFileName?.trim() || null,
        status: 'NEW',
      },
    });

    sendSuccess(
      res,
      { application },
      'Recruiter application submitted successfully. Our team will review your credentials.',
      201
    );
  } catch (err) {
    next(err);
  }
};

/**
 * 2. List Recruiter Applications: GET /api/recruiter-applications
 * Supports real DB filtering by status, search, pagination, and status breakdown counts.
 */
export const getRecruiterApplications = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { status, search, page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const andFilters: any[] = [];

    if (status && String(status).toUpperCase() !== 'ALL') {
      const normalizedStatus = String(status).toUpperCase();
      if (['NEW', 'REVIEWING', 'CONTACTED', 'APPROVED', 'REJECTED'].includes(normalizedStatus)) {
        andFilters.push({ status: normalizedStatus });
      }
    }

    if (search) {
      const q = String(search).trim();
      andFilters.push({
        OR: [
          { fullName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { location: { contains: q, mode: 'insensitive' } },
          { currentCompany: { contains: q, mode: 'insensitive' } },
          { primaryDomain: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const where = andFilters.length ? { AND: andFilters } : {};

    const [total, applications, statusGroups] = await Promise.all([
      prisma.recruiterApplication.count({ where }),
      prisma.recruiterApplication.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.recruiterApplication.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const countsMap: Record<string, number> = {
      ALL: 0,
      NEW: 0,
      REVIEWING: 0,
      CONTACTED: 0,
      APPROVED: 0,
      REJECTED: 0,
    };

    let grandTotal = 0;
    for (const group of statusGroups) {
      countsMap[group.status] = group._count._all;
      grandTotal += group._count._all;
    }
    countsMap.ALL = grandTotal;

    sendSuccess(res, {
      applications,
      counts: countsMap,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 3. Get Single Recruiter Application: GET /api/recruiter-applications/:id
 */
export const getRecruiterApplicationById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const application = await prisma.recruiterApplication.findUnique({
      where: { id },
    });

    if (!application) {
      sendError(res, 'Recruiter application not found', 404);
      return;
    }

    // Check if user account is already linked/created
    const existingUser = await prisma.user.findUnique({
      where: { email: application.email },
      select: {
        id: true,
        recruiterId: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    sendSuccess(res, {
      application,
      existingAccount: existingUser,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 4. Update Recruiter Application Status: PATCH /api/recruiter-applications/:id/status
 */
export const updateRecruiterApplicationStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const data = updateStatusSchema.parse(req.body);

    const application = await prisma.recruiterApplication.findUnique({
      where: { id },
    });

    if (!application) {
      sendError(res, 'Recruiter application not found', 404);
      return;
    }

    const updated = await prisma.recruiterApplication.update({
      where: { id },
      data: {
        status: data.status,
        adminNotes: data.adminNotes !== undefined ? data.adminNotes : application.adminNotes,
      },
    });

    await logAudit({
      req,
      action: 'UPDATE_RECRUITER_APPLICATION_STATUS',
      module: 'RECRUITER_APPLICATIONS',
      entity: 'RecruiterApplication',
      entityId: id,
      oldValue: { status: application.status },
      newValue: { status: updated.status, adminNotes: updated.adminNotes },
    });

    sendSuccess(
      res,
      { application: updated },
      `Application status updated to ${data.status}.`
    );
  } catch (err) {
    next(err);
  }
};

/**
 * 5. Approve Recruiter Application: POST /api/recruiter-applications/:id/approve
 * Atomic Workflow:
 * 1. Checks application and existing account.
 * 2. Creates User as FREELANCE_RECRUITER with secure invitation token.
 * 3. Creates RecruiterPermission defaults.
 * 4. Sets Application status to APPROVED.
 * 5. Dispatches welcome email with setup_url link.
 */
export const approveRecruiterApplication = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const application = await prisma.recruiterApplication.findUnique({
      where: { id },
    });

    if (!application) {
      sendError(res, 'Recruiter application not found', 404);
      return;
    }

    const email = application.email.trim().toLowerCase();

    // Check if account already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        recruiterId: true,
        role: true,
        isActive: true,
      },
    });

    if (existingUser) {
      // If already a recruiter, ensure application is marked approved
      if (
        existingUser.role === 'RECRUITER' ||
        existingUser.role === 'FREELANCE_RECRUITER'
      ) {
        if (application.status !== 'APPROVED') {
          await prisma.recruiterApplication.update({
            where: { id },
            data: { status: 'APPROVED' },
          });
        }

        sendSuccess(
          res,
          {
            application: { ...application, status: 'APPROVED' },
            recruiter: existingUser,
            accountExisted: true,
          },
          'Recruiter account already exists for this applicant and is active.'
        );
        return;
      }

      sendError(
        res,
        `A user account with email "${email}" already exists with role ${existingUser.role}. Cannot convert automatically.`,
        409
      );
      return;
    }

    const recruiterId = await generateRecruiterId();

    // Generate secure one-time password setup token (valid for 48h)
    const rawSetupToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    const tokenExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const initialPlaceholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

    // Atomic transaction: create user + permissions + mark application approved
    const { createdRecruiter, updatedApplication } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash: initialPlaceholderHash,
          fullName: application.fullName.trim(),
          role: 'FREELANCE_RECRUITER',
          phone: application.phone.trim(),
          recruiterId,
          recruiterType: 'FREELANCER',
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
          recruiterType: true,
          isActive: true,
          createdAt: true,
        },
      });

      await tx.recruiterPermission.create({
        data: {
          recruiterId: user.id,
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

      const app = await tx.recruiterApplication.update({
        where: { id },
        data: { status: 'APPROVED' },
      });

      return { createdRecruiter: user, updatedApplication: app };
    });

    await logAudit({
      req,
      action: 'APPROVE_RECRUITER_APPLICATION',
      module: 'RECRUITER_APPLICATIONS',
      entity: 'RecruiterApplication',
      entityId: id,
      newValue: {
        recruiterId: createdRecruiter.recruiterId,
        userId: createdRecruiter.id,
        email: createdRecruiter.email,
        status: 'APPROVED',
      },
    });

    const setupUrl = `${config.recruiter.passwordSetupUrl}?token=${rawSetupToken}&email=${encodeURIComponent(email)}`;

    dispatchEmail('RECRUITER_WELCOME', createdRecruiter.email, {
      recruiter_id: createdRecruiter.recruiterId || '',
      recruiter_name: createdRecruiter.fullName,
      recruiter_email: createdRecruiter.email,
      setup_url: setupUrl,
      login_url: config.recruiter.loginUrl,
    });

    sendSuccess(
      res,
      {
        application: updatedApplication,
        recruiter: createdRecruiter,
      },
      'Recruiter application approved successfully. Welcome email dispatched with secure setup link.'
    );
  } catch (err) {
    next(err);
  }
};
