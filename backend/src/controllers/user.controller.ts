import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';

const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    avatarUrl: z.union([z.string().url().max(1000), z.literal('')]).nullable().optional(),
    avatar: z.union([z.string().url().max(1000), z.literal('')]).nullable().optional(),
    preferences: z.record(z.any()).optional(),
    email: z.string().email().optional(),
  })
  .passthrough();


const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'New password must be at least 8 characters long')
      .max(128, 'New password is too long'),
    confirmPassword: z.string().min(8, 'Confirm password is required').optional(),
  })
  .refine(
    (data) => !data.confirmPassword || data.newPassword === data.confirmPassword,
    {
      message: 'New password and confirmation password do not match',
      path: ['confirmPassword'],
    }
  );

const updateSettingsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    emailNotifications: z.boolean().optional(),
    candidateAlerts: z.boolean().optional(),
    jobAlerts: z.boolean().optional(),
    interviewReminders: z.boolean().optional(),
    preferences: z.record(z.any()).optional(),
    settings: z.record(z.any()).optional(),
  })
  .passthrough();


/**
 * 1. GET Current User / Profile: GET /api/user/profile or GET /api/profile or GET /api/auth/me
 * Derives user identity strictly from authenticated JWT / session token.
 */
export const getMyProfile = async (
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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        role: true,
        recruiterId: true,
        recruiterType: true,
        mustSetPassword: true,
        preferences: true,
        isActive: true,
        isEmailVerified: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        recruiterPermissions: true,
        teamLeader: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
    });

    if (!user || !user.isActive) {
      sendError(res, 'User profile not found or account is deactivated', 404);
      return;
    }

    sendSuccess(res, {
      user: {
        ...user,
        name: user.fullName,
        avatar: user.avatarUrl,
      },
      profile: {
        ...user,
        name: user.fullName,
        avatar: user.avatarUrl,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 2. UPDATE Profile: PATCH /api/user/profile or PUT /api/profile
 * Allows modifying only permitted profile fields (fullName, phone, avatarUrl, preferences).
 * Strictly forbids modifying security credentials, role, or permissions.
 */
export const updateMyProfile = async (
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

    const data = updateProfileSchema.parse(req.body);

    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        preferences: true,
        isActive: true,
      },
    });

    if (!existingUser || !existingUser.isActive) {
      sendError(res, 'User account not found or is deactivated', 404);
      return;
    }

    const nextFullName = (data.fullName || data.name)?.trim() || existingUser.fullName;
    const nextPhone =
      data.phone !== undefined ? (data.phone ? data.phone.trim() : null) : existingUser.phone;
    const nextAvatarUrl =
      data.avatarUrl !== undefined
        ? (data.avatarUrl ? data.avatarUrl : null)
        : data.avatar !== undefined
        ? (data.avatar ? data.avatar : null)
        : existingUser.avatarUrl;

    let mergedPreferences = existingUser.preferences;
    if (data.preferences && typeof data.preferences === 'object') {
      mergedPreferences = {
        ...(typeof existingUser.preferences === 'object' && existingUser.preferences !== null
          ? existingUser.preferences
          : {}),
        ...data.preferences,
      };
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        fullName: nextFullName,
        phone: nextPhone,
        avatarUrl: nextAvatarUrl,
        preferences: mergedPreferences ?? undefined,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        role: true,
        recruiterId: true,
        recruiterType: true,
        preferences: true,
        isActive: true,
        updatedAt: true,
      },
    });

    await logAudit({
      req,
      action: 'UPDATE_PROFILE',
      module: 'USER_MANAGEMENT',
      entity: 'User',
      entityId: userId,
      oldValue: {
        fullName: existingUser.fullName,
        phone: existingUser.phone,
        avatarUrl: existingUser.avatarUrl,
      },
      newValue: {
        fullName: updatedUser.fullName,
        phone: updatedUser.phone,
        avatarUrl: updatedUser.avatarUrl,
      },
    });

    sendSuccess(
      res,
      {
        user: {
          ...updatedUser,
          name: updatedUser.fullName,
          avatar: updatedUser.avatarUrl,
        },
        profile: {
          ...updatedUser,
          name: updatedUser.fullName,
          avatar: updatedUser.avatarUrl,
        },
      },
      'Profile updated successfully.'
    );
  } catch (err) {
    next(err);
  }
};

/**
 * 3. CHANGE PASSWORD: POST /api/user/change-password or POST /api/change-password
 * Requires current password verification, strong new password validation, difference check,
 * secure bcrypt re-hashing (12 rounds), session token revocation, and atomic update.
 */
export const changePassword = async (
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

    const data = changePasswordSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      sendError(res, 'Account not found or inactive', 401);
      return;
    }

    // 1. Verify current password
    const matchesCurrent = await bcrypt.compare(data.currentPassword, user.passwordHash);
    if (!matchesCurrent) {
      sendError(res, 'Current password is incorrect.', 400);
      return;
    }

    // 2. Verify new password is not identical to current password
    const isSamePassword = await bcrypt.compare(data.newPassword, user.passwordHash);
    if (isSamePassword) {
      sendError(res, 'New password must be different from current password.', 400);
      return;
    }

    // 3. Hash new password securely with bcrypt (12 rounds)
    const newHash = await bcrypt.hash(data.newPassword, 12);

    // 4. Update in database and revoke existing refresh tokens atomically
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          mustSetPassword: false,
          resetPasswordToken: null,
          resetPasswordExpires: null,
          failedLoginAttempts: 0,
          lockUntil: null,
        },
      });

      // Revoke any existing refresh tokens to force re-authentication across active sessions
      await tx.refreshToken.deleteMany({
        where: { userId: user.id },
      });
    });

    await logAudit({
      req,
      action: 'CHANGE_PASSWORD',
      module: 'AUTH',
      entity: 'User',
      entityId: user.id,
      newValue: { status: 'PASSWORD_CHANGED' },
    });

    sendSuccess(
      res,
      { success: true },
      'Password changed successfully. Please log in with your new password.'
    );
  } catch (err) {
    next(err);
  }
};

/**
 * 4. GET Settings: GET /api/user/settings or GET /api/settings
 * Retrieves user preferences and configuration.
 */
export const getMySettings = async (
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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        preferences: true,
        mfaEnabled: true,
      },
    });

    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    sendSuccess(res, {
      settings: user.preferences || {},
      mfaEnabled: user.mfaEnabled,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 5. UPDATE Settings: PATCH /api/user/settings or PATCH /api/settings
 * Persists user UI/notification preferences to PostgreSQL.
 */
export const updateMySettings = async (
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

    const data = updateSettingsSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });

    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    const currentPreferences =
      typeof user.preferences === 'object' && user.preferences !== null
        ? (user.preferences as Record<string, any>)
        : {};

    const incomingData = data.settings || data.preferences || data;

    const nextPreferences = {
      ...currentPreferences,
      ...incomingData,
      ...(data.theme ? { theme: data.theme } : {}),
      ...(typeof data.emailNotifications === 'boolean'
        ? { emailNotifications: data.emailNotifications }
        : {}),
      ...(typeof data.candidateAlerts === 'boolean'
        ? { candidateAlerts: data.candidateAlerts }
        : {}),
      ...(typeof data.jobAlerts === 'boolean' ? { jobAlerts: data.jobAlerts } : {}),
      ...(typeof data.interviewReminders === 'boolean'
        ? { interviewReminders: data.interviewReminders }
        : {}),
    };

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { preferences: nextPreferences },
      select: {
        id: true,
        preferences: true,
        mfaEnabled: true,
      },
    });

    sendSuccess(
      res,
      {
        settings: updatedUser.preferences,
        preferences: updatedUser.preferences,
        mfaEnabled: updatedUser.mfaEnabled,
      },
      'Settings updated successfully.'
    );

  } catch (err) {
    next(err);
  }
};

/**
 * 6. LOGOUT: POST /api/auth/logout or POST /api/user/logout
 * Revokes refresh tokens for authenticated user.
 */
export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (userId) {
      await prisma.refreshToken.deleteMany({
        where: { userId },
      });
      await logAudit({
        req,
        action: 'LOGOUT',
        module: 'AUTH',
        entity: 'User',
        entityId: userId,
      });
    }

    res.clearCookie('refreshToken');
    sendSuccess(res, { success: true }, 'Logged out successfully.');
  } catch (err) {
    next(err);
  }
};
