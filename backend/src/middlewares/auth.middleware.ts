import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../prisma/client';

export interface AuthUserPayload {
  userId: string;
  email: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'SUB_ADMIN' | 'TEAM_LEADER' | 'RECRUITER' | 'FREELANCE_RECRUITER' | 'EMPLOYER' | 'CLIENT' | 'CANDIDATE';
  mfaState?: 'SETUP_REQUIRED' | 'CHALLENGE_REQUIRED';
}

export type RecruiterPermissionKey =
  | 'dashboard'
  | 'candidates'
  | 'jobs'
  | 'applications'
  | 'interviews'
  | 'payouts'
  | 'reports'
  | 'settings';

export type SubAdminSectionKey =
  | 'candidates'
  | 'recruiters'
  | 'jobs'
  | 'interviews'
  | 'walkins'
  | 'reports';

export const ALLOWED_SUB_ADMIN_SECTIONS: SubAdminSectionKey[] = [
  'candidates',
  'recruiters',
  'jobs',
  'interviews',
  'walkins',
  'reports',
];

export const ADMIN_ONLY_SECTIONS = [
  'settings',
  'sub-admin management',
  'billing',
  'bulk import',
  'exports',
];

declare global {
  namespace Express {
    interface Request {
      user?: AuthUserPayload;
    }
  }
}

export const authenticateJwt = (req: Request, res: Response, next: NextFunction): void => {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      token = match[1].trim();
    }
  }

  // Also check cookies if available
  if (!token && (req as any).cookies) {
    token =
      (req as any).cookies.oe_auth_token ||
      (req as any).cookies.token ||
      (req as any).cookies.accessToken;
  }

  // Also check x-access-token header
  if (!token && req.headers['x-access-token']) {
    token = String(req.headers['x-access-token']).trim();
  }

  if (!token) {
    res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token' });
    return;
  }

  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret) as AuthUserPayload;

    if (!decoded.userId || !decoded.role || !decoded.email) {
      res.status(401).json({ success: false, message: 'Unauthorized: Invalid token payload' });
      return;
    }

    req.user = decoded;

    if (decoded.mfaState && !req.path.startsWith('/mfa/')) {
      res.status(403).json({
        success: false,
        code: decoded.mfaState === 'SETUP_REQUIRED' ? 'MFA_SETUP_REQUIRED' : 'MFA_CHALLENGE_REQUIRED',
        message: decoded.mfaState === 'SETUP_REQUIRED'
          ? 'MFA setup is required before accessing this resource.'
          : 'MFA verification is required before accessing this resource.',
      });
      return;
    }

    next();
  } catch {
    res.status(401).json({ success: false, message: 'Unauthorized: Invalid or expired token' });
  }
};

export const optionalAuthenticateJwt = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.headers.authorization) {
    next();
    return;
  }

  authenticateJwt(req, res, next);
};

export const requireRoles = (...allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: `Forbidden: Access restricted to roles [${allowedRoles.join(', ')}]`,
      });
      return;
    }

    next();
  };
};

/**
 * Section permission guard for SUB_ADMIN role.
 * - SUPER_ADMIN & ADMIN always pass.
 * - SUB_ADMIN only passes if the section is in their granted permissions array.
 * - Other roles pass through (handled by their respective role guards).
 */
export const requirePermission = (sectionKey: SubAdminSectionKey) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    // Admins always have unrestricted access
    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN') {
      next();
      return;
    }

    // For SUB_ADMIN, check their database record permissions
    if (req.user.role === 'SUB_ADMIN') {
      try {
        const user = await prisma.user.findUnique({
          where: { id: req.user.userId },
          select: { permissions: true, isActive: true },
        });

        if (!user || !user.isActive) {
          res.status(403).json({
            success: false,
            code: 'ACCOUNT_INACTIVE',
            message: 'Your Sub-Admin account is inactive or suspended.',
          });
          return;
        }

        const userPerms = Array.isArray(user.permissions) ? user.permissions : [];
        if (!userPerms.includes(sectionKey)) {
          res.status(403).json({
            success: false,
            code: 'SECTION_PERMISSION_DENIED',
            message: `Forbidden: You do not have permission to access the '${sectionKey}' section.`,
          });
          return;
        }

        next();
        return;
      } catch (error) {
        next(error);
        return;
      }
    }

    // Other roles proceed through to their own handlers
    next();
  };
};

/**
 * Strict export guard: blocks SUB_ADMIN and non-admin roles from bulk export,
 * downloads, templates, CSVs, and Excel reports.
 */
export const blockSubAdminExport = (req: Request, res: Response, next: NextFunction): void => {
  if (req.user?.role === 'SUB_ADMIN') {
    res.status(403).json({
      success: false,
      code: 'EXPORT_FORBIDDEN',
      message: 'Forbidden: Export, report download, and bulk extract capabilities are disabled for Sub-Admin.',
    });
    return;
  }
  next();
};

export const requireRecruiterPermission = (permission: RecruiterPermissionKey) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    // Admins, super admins, and team leaders are not restricted by recruiter module permissions.
    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN' || req.user.role === 'SUB_ADMIN' || req.user.role === 'TEAM_LEADER') {
      next();
      return;
    }

    if (req.user.role === 'FREELANCE_RECRUITER') {
      // Freelance recruiters have access to standard operations (candidates, jobs, applications, dashboard)
      if (['candidates', 'jobs', 'applications', 'dashboard', 'interviews'].includes(permission)) {
        next();
        return;
      }
    }

    if (req.user.role !== 'RECRUITER' && req.user.role !== 'FREELANCE_RECRUITER') {
      res.status(403).json({
        success: false,
        code: 'RECRUITER_PERMISSION_REQUIRED',
        message: 'This resource is restricted to recruiters with the required permission.',
      });
      return;
    }

    try {
      const permissions = await prisma.recruiterPermission.findUnique({
        where: { recruiterId: req.user.userId },
        select: {
          dashboard: true,
          candidates: true,
          jobs: true,
          applications: true,
          interviews: true,
          payouts: true,
          reports: true,
          settings: true,
        },
      });

      if (!permissions) {
        // Base ATS operational modules default to granted for any active recruiter
        const baseRecruiterModules: RecruiterPermissionKey[] = [
          'dashboard',
          'candidates',
          'jobs',
          'applications',
          'interviews',
        ];
        if (baseRecruiterModules.includes(permission)) {
          next();
          return;
        }

        res.status(403).json({
          success: false,
          code: 'RECRUITER_PERMISSIONS_NOT_FOUND',
          message: 'Recruiter permissions are not configured.',
        });
        return;
      }

      if (!permissions[permission]) {
        res.status(403).json({
          success: false,
          code: 'RECRUITER_PERMISSION_DENIED',
          message: `You do not have permission to access the ${permission} module.`,
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
