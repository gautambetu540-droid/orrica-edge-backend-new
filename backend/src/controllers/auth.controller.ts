import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { sendDynamicEmail } from '../services/email.service';

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
    currentPassword: z.string().optional(),
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
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

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

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        fullName: true,
        role: true,
        phone: true,
        avatarUrl: true,
        recruiterId: true,
        recruiterType: true,
        mustSetPassword: true,
        lastLoginAt: true,
        isActive: true,
        mfaSecret: true,
        mfaEnabled: true,
        permissions: true,
        subAdminId: true,
      },
    });

    if (!user) {
      console.warn(`[AUTH] Login failed: User not found for email="${email}"`);
      res.status(401).json({ success: false, message: 'Invalid credentials or inactive account' });
      return;
    }

    if (!user.isActive) {
      console.warn(`[AUTH] Login failed: Account inactive (isActive=false) for userId="${user.id}", email="${email}"`);
      res.status(401).json({ success: false, message: 'Invalid credentials or inactive account' });
      return;
    }

    const isMatch = await bcrypt.compare(data.password, user.passwordHash);

    if (!isMatch) {
      console.warn(`[AUTH] Login failed: Password mismatch for userId="${user.id}", email="${email}"`);
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
      permissions: user.permissions || [],
      subAdminId: user.subAdminId,
    };

    if (!user.mfaEnabled) {
      const mfaSetupToken = buildMfaPendingToken(user, 'SETUP_REQUIRED');

      res.json({
        success: true,
        message: 'Password verified. Multi-factor authentication setup is required to continue.',
        data: {
          token: mfaSetupToken,
          mfaSetupToken,
          requiresMfaSetup: true,
          requiresMfa: false,
          requiresPasswordChange: Boolean(user.mustSetPassword),
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
        requiresPasswordChange: Boolean(user.mustSetPassword),
        user: userData,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const validateSetupToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const rawToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';

    if (!rawToken || !rawEmail) {
      res.status(400).json({
        success: false,
        status: 'invalid',
        tokenStatus: 'invalid',
        message: 'Setup token and registered email are required.',
      });
      return;
    }

    const tokenHash = hashSetupToken(rawToken);

    const user = await prisma.user.findUnique({
      where: { email: rawEmail },
      select: {
        id: true,
        email: true,
        fullName: true,
        mustSetPassword: true,
        resetPasswordToken: true,
        resetPasswordExpires: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(404).json({
        success: false,
        status: 'invalid',
        tokenStatus: 'invalid',
        message: 'This password setup link is invalid or the account is inactive.',
      });
      return;
    }

    if (!user.mustSetPassword) {
      res.status(400).json({
        success: false,
        status: 'already_set',
        tokenStatus: 'already_set',
        message: 'Password has already been set for this account. Please use the login page.',
      });
      return;
    }

    if (!user.resetPasswordToken || user.resetPasswordToken !== tokenHash) {
      res.status(400).json({
        success: false,
        status: 'invalid',
        tokenStatus: 'invalid',
        message: 'This password setup link is invalid.',
      });
      return;
    }

    if (!user.resetPasswordExpires || user.resetPasswordExpires.getTime() < Date.now()) {
      res.status(400).json({
        success: false,
        status: 'expired',
        tokenStatus: 'expired',
        message: 'This password setup link has expired. Password setup links are valid for 24 hours.',
      });
      return;
    }

    res.json({
      success: true,
      status: 'valid',
      tokenStatus: 'valid',
      message: 'Token is valid.',
      data: {
        email: user.email,
        name: user.fullName || 'User',
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

    // Revoke any previous refresh tokens
    await prisma.refreshToken.deleteMany({
      where: { userId: user.id },
    }).catch(() => {});

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
        mustSetPassword: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ success: false, message: 'Account is inactive or unavailable' });
      return;
    }

    if (!user.mustSetPassword) {
      if (!data.currentPassword || !data.currentPassword.trim()) {
        res.status(400).json({
          success: false,
          code: 'CURRENT_PASSWORD_REQUIRED',
          message: 'Current password is required.',
        });
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
    } else if (data.currentPassword && data.currentPassword.trim()) {
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
        permissions: true,
        subAdminId: true,
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

/**
 * 1. Request Password Reset OTP
 * POST /api/v1/auth/forgot-password
 * Rate-limited. Generic response to prevent user enumeration.
 */
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!rawEmail || !rawEmail.includes('@')) {
      res.status(400).json({
        success: false,
        message: 'A valid email address is required.',
      });
      return;
    }

    const genericMsg = 'If this email is registered, a 6-digit verification code has been sent.';

    const user = await prisma.user.findUnique({
      where: { email: rawEmail },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
      },
    });

    if (!user || user.isActive === false) {
      res.json({ success: true, message: genericMsg });
      return;
    }

    // Generate cryptographic 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    const payload = {
      type: 'FORGOT_OTP',
      hash: otpHash,
      attempts: 0,
      sentAt: Date.now(),
    };

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: JSON.stringify(payload),
        resetPasswordExpires: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
    });

    // Send email using centralized sender and Sky Blue OTP template
    try {
      await sendDynamicEmail({
        templateKey: 'OTP_VERIFICATION',
        recipient: user.email,
        variables: {
          user_name: user.fullName || 'User',
          user_email: user.email,
          otp_code: otp,
          expiry_minutes: '10',
        },
      });
    } catch (emailErr: any) {
      console.warn('[FORGOT PASSWORD EMAIL FAILED]:', emailErr.message);
    }

    res.json({
      success: true,
      message: genericMsg,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 2. Resend Password Reset OTP
 * POST /api/v1/auth/forgot-password/resend
 * 60s cooldown per user. Rate-limited per IP.
 */
export const resendForgotPasswordOtp = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!rawEmail || !rawEmail.includes('@')) {
      res.status(400).json({
        success: false,
        message: 'A valid email address is required.',
      });
      return;
    }

    const genericMsg = 'If this email is registered, a new 6-digit verification code has been sent.';

    const user = await prisma.user.findUnique({
      where: { email: rawEmail },
      select: {
        id: true,
        email: true,
        fullName: true,
        resetPasswordToken: true,
        resetPasswordExpires: true,
        isActive: true,
      },
    });

    if (!user || user.isActive === false) {
      res.json({ success: true, message: genericMsg });
      return;
    }

    // Check 60s cooldown if previous OTP was sent
    if (user.resetPasswordToken) {
      try {
        const parsed = JSON.parse(user.resetPasswordToken);
        if (parsed?.sentAt && Date.now() - parsed.sentAt < 60 * 1000) {
          const waitSecs = Math.ceil((60 * 1000 - (Date.now() - parsed.sentAt)) / 1000);
          res.status(429).json({
            success: false,
            message: `Please wait ${waitSecs} seconds before requesting a new verification code.`,
          });
          return;
        }
      } catch {}
    }

    // Generate new cryptographic 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    const payload = {
      type: 'FORGOT_OTP',
      hash: otpHash,
      attempts: 0,
      sentAt: Date.now(),
    };

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: JSON.stringify(payload),
        resetPasswordExpires: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
    });

    try {
      await sendDynamicEmail({
        templateKey: 'OTP_VERIFICATION',
        recipient: user.email,
        variables: {
          user_name: user.fullName || 'User',
          user_email: user.email,
          otp_code: otp,
          expiry_minutes: '10',
        },
      });
    } catch (emailErr: any) {
      console.warn('[RESEND OTP EMAIL FAILED]:', emailErr.message);
    }

    res.json({
      success: true,
      message: genericMsg,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 3. Verify Password Reset OTP
 * POST /api/v1/auth/forgot-password/verify
 * Max 5 attempts. Issues single-use 15-minute reset session token.
 */
export const verifyForgotPasswordOtp = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const rawOtp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : '';

    if (!rawEmail || !rawOtp || rawOtp.length !== 6) {
      res.status(400).json({
        success: false,
        message: 'A registered email and 6-digit verification code are required.',
      });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email: rawEmail },
      select: {
        id: true,
        email: true,
        resetPasswordToken: true,
        resetPasswordExpires: true,
        isActive: true,
      },
    });

    if (!user || user.isActive === false || !user.resetPasswordToken) {
      res.status(400).json({
        success: false,
        message: 'Invalid or expired verification code.',
      });
      return;
    }

    // Check expiration
    if (!user.resetPasswordExpires || user.resetPasswordExpires.getTime() < Date.now()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { resetPasswordToken: null, resetPasswordExpires: null },
      });
      res.status(400).json({
        success: false,
        message: 'This verification code has expired. Please request a new one.',
      });
      return;
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(user.resetPasswordToken);
    } catch {
      // Legacy format
    }

    if (!parsed || parsed.type !== 'FORGOT_OTP' || !parsed.hash) {
      res.status(400).json({
        success: false,
        message: 'Invalid or expired verification code.',
      });
      return;
    }

    const inputHash = crypto.createHash('sha256').update(rawOtp).digest('hex');

    if (inputHash !== parsed.hash) {
      const newAttempts = (parsed.attempts || 0) + 1;
      if (newAttempts >= 5) {
        // Burn OTP on 5 failed attempts
        await prisma.user.update({
          where: { id: user.id },
          data: { resetPasswordToken: null, resetPasswordExpires: null },
        });
        res.status(400).json({
          success: false,
          message: 'Too many incorrect attempts. This code has been invalidated. Please request a new one.',
        });
        return;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetPasswordToken: JSON.stringify({ ...parsed, attempts: newAttempts }),
        },
      });

      res.status(400).json({
        success: false,
        message: `Incorrect verification code. ${5 - newAttempts} attempt(s) remaining.`,
      });
      return;
    }

    // OTP verified successfully -> Issue single-use reset token valid for 15 minutes
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: JSON.stringify({
          type: 'RESET_SESSION',
          hash: resetTokenHash,
        }),
        resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      },
    });

    res.json({
      success: true,
      message: 'Verification code confirmed. You can now set your new password.',
      resetToken,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 4. Set New Password with Reset Token
 * POST /api/v1/auth/reset-password
 * Requires valid reset session token from step 3. Bcrypts new password.
 */
export const resetPasswordWithOtpToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const resetToken = typeof req.body?.resetToken === 'string' ? req.body.resetToken.trim() : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : '';

    if (!rawEmail || !resetToken || !newPassword) {
      res.status(400).json({
        success: false,
        message: 'Email, reset session token, and new password are required.',
      });
      return;
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      res.status(400).json({
        success: false,
        message: 'New password and confirmation password do not match.',
      });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters in length.',
      });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email: rawEmail },
      select: {
        id: true,
        email: true,
        fullName: true,
        resetPasswordToken: true,
        resetPasswordExpires: true,
        isActive: true,
      },
    });

    if (!user || user.isActive === false || !user.resetPasswordToken) {
      res.status(400).json({
        success: false,
        message: 'Invalid or expired password reset session.',
      });
      return;
    }

    if (!user.resetPasswordExpires || user.resetPasswordExpires.getTime() < Date.now()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { resetPasswordToken: null, resetPasswordExpires: null },
      });
      res.status(400).json({
        success: false,
        message: 'Your password reset session has expired. Please verify your email again.',
      });
      return;
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(user.resetPasswordToken);
    } catch {}

    if (!parsed || parsed.type !== 'RESET_SESSION' || !parsed.hash) {
      res.status(400).json({
        success: false,
        message: 'Invalid reset session.',
      });
      return;
    }

    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    if (tokenHash !== parsed.hash) {
      res.status(400).json({
        success: false,
        message: 'Invalid or forged password reset session.',
      });
      return;
    }

    // Bcrypt new password with salt 12
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(newPassword, salt);

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

    // Record audit log (sanitized)
    try {
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'PASSWORD_RESET',
          module: 'AUTH',
          entity: 'USER',
          entityId: user.id,
          ipAddress: req.ip || '',
          newValue: {
            method: 'EMAIL_OTP',
            email: user.email,
          },
        },
      });
    } catch {}

    res.json({
      success: true,
      message: 'Your password has been reset successfully. You can now sign in with your new password.',
    });
  } catch (err) {
    next(err);
  }
};
