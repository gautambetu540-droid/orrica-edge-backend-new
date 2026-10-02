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

    const accessToken = jwt.sign(
      { userId: newUser.id, email: newUser.email, role: newUser.role },
      config.jwt.accessSecret,
      { expiresIn: '1h' }
    );

    res.status(201).json({
      success: true,
      message: 'Account registered successfully',
      data: { user: newUser, token: accessToken },
    });
  } catch (err) {
    next(err);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = loginSchema.parse(req.body);
    const email = data.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.isActive) {
      res.status(401).json({ success: false, message: 'Invalid credentials or inactive account' });
      return;
    }

    if (user.role === 'RECRUITER' && user.mustSetPassword) {
      res.status(403).json({
        success: false,
        code: 'PASSWORD_SETUP_REQUIRED',
        message: 'Please set your password before logging in.',
        data: {
          recruiterId: user.recruiterId,
          email: user.email,
        },
      });
      return;
    }

    const isMatch = await bcrypt.compare(data.password, user.passwordHash);

    if (!isMatch) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const loggedInAt = new Date();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: loggedInAt,
        failedLoginAttempts: 0,
        lockUntil: null,
      },
    });

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwt.accessSecret,
      { expiresIn: '1d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token: accessToken,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          phone: user.phone,
          avatarUrl: user.avatarUrl,
          recruiterId: user.recruiterId,
          mustSetPassword: user.mustSetPassword,
          lastLoginAt: loggedInAt,
        },
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
