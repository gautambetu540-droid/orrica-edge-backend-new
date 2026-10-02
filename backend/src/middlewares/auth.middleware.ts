import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../prisma/client';

export interface AuthUserPayload {
  userId: string;
  email: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'RECRUITER' | 'CLIENT' | 'CANDIDATE';
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

declare global {
  namespace Express {
    interface Request {
      user?: AuthUserPayload;
    }
  }
}

export const authenticateJwt = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token' });
    return;
  }

  const token = authHeader.split(' ')[1];

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

export const requireRecruiterPermission = (permission: RecruiterPermissionKey) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    // Admins and super admins are not restricted by recruiter module permissions.
    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN') {
      next();
      return;
    }

    if (req.user.role !== 'RECRUITER') {
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
