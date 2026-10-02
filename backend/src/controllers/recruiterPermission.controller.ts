import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';

const permissionsSchema = z.object({
  dashboard: z.boolean(),
  candidates: z.boolean(),
  jobs: z.boolean(),
  applications: z.boolean(),
  interviews: z.boolean(),
  payouts: z.boolean(),
  reports: z.boolean(),
  settings: z.boolean(),
});

const getRecruiterIdParam = (req: Request): string => req.params.id;

const getPermissions = (permissions: {
  dashboard: boolean;
  candidates: boolean;
  jobs: boolean;
  applications: boolean;
  interviews: boolean;
  payouts: boolean;
  reports: boolean;
  settings: boolean;
}) => ({
  dashboard: permissions.dashboard,
  candidates: permissions.candidates,
  jobs: permissions.jobs,
  applications: permissions.applications,
  interviews: permissions.interviews,
  payouts: permissions.payouts,
  reports: permissions.reports,
  settings: permissions.settings,
});

export const getRecruiterPermissions = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const recruiterId = getRecruiterIdParam(req);

    const recruiter = await prisma.user.findFirst({
      where: {
        id: recruiterId,
        role: 'RECRUITER',
      },
      select: {
        id: true,
        recruiterId: true,
        fullName: true,
        email: true,
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    const permissions = await prisma.recruiterPermission.findUnique({
      where: { recruiterId: recruiter.id },
    });

    if (!permissions) {
      sendError(res, 'Recruiter permissions not found', 404);
      return;
    }

    sendSuccess(res, {
      recruiter: {
        id: recruiter.id,
        recruiterId: recruiter.recruiterId,
        fullName: recruiter.fullName,
        email: recruiter.email,
      },
      permissions: getPermissions(permissions),
    });
  } catch (err) {
    next(err);
  }
};

export const getMyRecruiterPermissions = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;

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
        fullName: true,
        email: true,
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter account not found', 404);
      return;
    }

    const permissions = await prisma.recruiterPermission.findUnique({
      where: { recruiterId: recruiter.id },
    });

    if (!permissions) {
      sendError(res, 'Recruiter permissions not found', 404);
      return;
    }

    sendSuccess(res, {
      recruiter: {
        id: recruiter.id,
        recruiterId: recruiter.recruiterId,
        fullName: recruiter.fullName,
        email: recruiter.email,
      },
      permissions: getPermissions(permissions),
    });
  } catch (err) {
    next(err);
  }
};

export const updateRecruiterPermissions = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const recruiterId = getRecruiterIdParam(req);
    const data = permissionsSchema.parse(req.body);

    const recruiter = await prisma.user.findFirst({
      where: {
        id: recruiterId,
        role: 'RECRUITER',
      },
      select: {
        id: true,
        recruiterId: true,
        fullName: true,
        email: true,
      },
    });

    if (!recruiter) {
      sendError(res, 'Recruiter not found', 404);
      return;
    }

    const existingPermissions = await prisma.recruiterPermission.findUnique({
      where: { recruiterId: recruiter.id },
    });

    const permissions = await prisma.recruiterPermission.upsert({
      where: { recruiterId: recruiter.id },
      create: {
        recruiterId: recruiter.id,
        ...data,
      },
      update: data,
    });

    await logAudit({
      req,
      action: 'UPDATE_RECRUITER_PERMISSIONS',
      module: 'RECRUITERS',
      entity: 'RecruiterPermission',
      entityId: permissions.id,
      oldValue: existingPermissions
        ? getPermissions(existingPermissions)
        : null,
      newValue: getPermissions(permissions),
    });

    sendSuccess(
      res,
      {
        recruiter: {
          id: recruiter.id,
          recruiterId: recruiter.recruiterId,
          fullName: recruiter.fullName,
          email: recruiter.email,
        },
        permissions: getPermissions(permissions),
      },
      'Recruiter permissions updated successfully.'
    );
  } catch (err) {
    next(err);
  }
};
