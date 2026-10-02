import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { config } from '../config';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  fullName: z.string().min(2, 'Full name is required'),
  role: z.enum(['CANDIDATE']).optional(),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
});

const setPasswordSchema = z
  .object({
    email: z.string().email(),
    token: z.string().min(32, 'Invalid password setup token'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(8, 'Confirm password is required'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

const hashSetupToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'New password must be at least 8 characters')
      .max(128, 'New password is too long'),
    confirmPassword: z.string().min(8, 'Confirm password is required'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });



export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = registerSchema.parse(req.body);

    const email = data.email.trim().toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      res.status(409).json({ success: false, message: 'User with this email already exists' });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(data.password, salt);

    const newUser = await prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName: data.fullName.trim(),
        role: 'CANDIDATE',
        phone: data.phone,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phone: true,
        createdAt: true,
      },
    });

    const mfaSetupToken = buildMfaPendingToken(newUser, 'SETUP_REQUIRED');

    res.status(201).json({
      success: true,
      message: 'Account registered successfully. MFA setup is required before accessing the account.',
      data: {
        user: {
          ...newUser,
          mfaEnabled: false,
          requiresMfaSetup: true,
        },
        token: mfaSetupToken,
        mfaSetupToken,
        requiresMfaSetup: true,
        requiresMfa: true,
      },
    });
  } catch (err) {
    next(err);
  }
};

const buildMfaPendingToken = (
  user: { id: string; email: string; role: string },
  state: 'SETUP_REQUIRED' | 'CHALLENGE_REQUIRED'
): string =>
  jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      mfaState: state,
    },
    config.jwt.accessSecret,
    { expiresIn: '10m' }
  );

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = loginSchema.parse(req.body);
    const email = data.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.isActive) {
      res.status(401).json({ success: false, message: 'Invalid credentials or inactive account' });
      return;
    }

    const isMatch = await bcrypt.compare(data.password, user.passwordHash);

    if (!isMatch) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockUntil: null,
      },
    });

    const userData = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      recruiterId: user.recruiterId,
      recruiterType: user.recruiterType,
      mustSetPassword: user.mustSetPassword,
      lastLoginAt: user.lastLoginAt,
      mfaEnabled: user.mfaEnabled,
    };

    if (!user.mfaEnabled) {
      const mfaSetupToken = buildMfaPendingToken(user, 'SETUP_REQUIRED');

      res.json({
        success: true,
        message: 'Password verified. MFA setup is required before accessing the account.',
        data: {
          token: mfaSetupToken,
          mfaSetupToken,
          requiresMfaSetup: true,
          requiresMfa: true,
          requiresPasswordChange: user.role === 'RECRUITER' && user.mustSetPassword,
          user: userData,
        },
      });
      return;
    }

    const mfaChallengeToken = buildMfaPendingToken(user, 'CHALLENGE_REQUIRED');

    res.json({
      success: true,
      message: 'Password verified. Enter your authenticator code to continue.',
      data: {
        token: mfaChallengeToken,
        mfaChallengeToken,
        requiresMfaSetup: false,
        requiresMfa: true,
        requiresPasswordChange: user.role === 'RECRUITER' && user.mustSetPassword,
        user: userData,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const setPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = setPasswordSchema.parse(req.body);
    const email = data.email.trim().toLowerCase();
    const tokenHash = hashSetupToken(data.token);

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        recruiterId: true,
        recruiterType: true,
        mustSetPassword: true,
        resetPasswordToken: true,
        resetPasswordExpires: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(404).json({ success: false, message: 'Account not found or inactive' });
      return;
    }

    if (user.role !== 'RECRUITER') {
      res.status(400).json({
        success: false,
        message: 'Password setup is only available for recruiter accounts',
      });
      return;
    }

    if (!user.mustSetPassword) {
      res.status(400).json({
        success: false,
        code: 'PASSWORD_ALREADY_SET',
        message: 'Password has already been set. Please use the login page.',
      });
      return;
    }

    if (
      !user.resetPasswordToken ||
      !user.resetPasswordExpires ||
      user.resetPasswordExpires.getTime() < Date.now() ||
      user.resetPasswordToken !== tokenHash
    ) {
      res.status(400).json({
        success: false,
        code: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'This password setup link is invalid or has expired.',
      });
      return;
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustSetPassword: false,
        resetPasswordToken: null,
        resetPasswordExpires: null,
        failedLoginAttempts: 0,
        lockUntil: null,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phone: true,
        avatarUrl: true,
        recruiterId: true,
        mustSetPassword: true,
      },
    });

    res.json({
      success: true,
      message: 'Password set successfully. You can now log in.',
      data: { user: updatedUser },
    });
  } catch (err) {
    next(err);
  }
};


export const changeMyPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const data = changePasswordSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        passwordHash: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ success: false, message: 'Account is inactive or unavailable' });
      return;
    }

    const currentPasswordMatches = await bcrypt.compare(
      data.currentPassword,
      user.passwordHash
    );

    if (!currentPasswordMatches) {
      res.status(400).json({
        success: false,
        code: 'INVALID_CURRENT_PASSWORD',
        message: 'Current password is incorrect.',
      });
      return;
    }

    const samePassword = await bcrypt.compare(data.newPassword, user.passwordHash);

    if (samePassword) {
      res.status(400).json({
        success: false,
        code: 'PASSWORD_UNCHANGED',
        message: 'New password must be different from the current password.',
      });
      return;
    }

    const passwordHash = await bcrypt.hash(data.newPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustSetPassword: false,
        resetPasswordToken: null,
        resetPasswordExpires: null,
        failedLoginAttempts: 0,
        lockUntil: null,
      },
    });

    res.json({
      success: true,
      message: 'Password changed successfully. Please log in again.',
    });
  } catch (err) {
    next(err);
  }
};

export const getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phone: true,
        avatarUrl: true,
        recruiterId: true,
        mustSetPassword: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    res.json({ success: true, data: { user } });
  } catch (err) {
    next(err);
  }
};

export const keepAlive = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ success: false, message: 'Session inactive' });
      return;
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwt.accessSecret,
      { expiresIn: '1h' }
    );

    res.json({ success: true, data: { token } });
  } catch (err) {
    next(err);
  }
};
