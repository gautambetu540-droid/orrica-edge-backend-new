import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verify } from 'otplib';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { decryptMfaSecret, encryptMfaSecret } from '../services/mfaCrypto.service';

const setupSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Authentication code must be 6 digits'),
});

const challengeSchema = z.object({
  token: z.string().regex(/^\d{6}$/, 'Authentication code must be 6 digits').optional(),
  backupCode: z.string().regex(/^\d{4}-\d{4}$/, 'Invalid backup code format').optional(),
}).refine((data) => Boolean(data.token || data.backupCode), {
  message: 'Authentication code or backup code is required',
});

const hashBackupCode = (code: string): string =>
  crypto.createHash('sha256').update(code).digest('hex');

const generateBackupCodes = (): { plain: string[]; hashes: string[] } => {
  const plain = Array.from({ length: 10 }, () => {
    const value = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${value.slice(0, 4)}-${value.slice(4)}`;
  });

  return {
    plain,
    hashes: plain.map(hashBackupCode),
  };
};

const getAuthenticatedUser = async (userId?: string) => {
  if (!userId) return null;

  return prisma.user.findFirst({
    where: { id: userId, isActive: true },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      mfaEnabled: true,
      mfaSecret: true,
      mfaBackupCodes: true,
      phone: true,
      avatarUrl: true,
      recruiterId: true,
    },
  });
};

export const setupMfa = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req.user?.userId);

    if (!user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    if (user.mfaEnabled) {
      res.status(400).json({
        success: false,
        code: 'MFA_ALREADY_ENABLED',
        message: 'Multi-factor authentication is already enabled.',
      });
      return;
    }

    const secret = generateSecret();
    const uri = generateURI({
      issuer: 'Orrica Edge',
      label: user.email,
      secret,
    });
    const qrCode = await QRCode.toDataURL(uri);

    // Store the pending secret. MFA becomes active only after OTP verification.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        mfaSecret: encryptMfaSecret(secret),
        mfaEnabled: false,
        mfaBackupCodes: { set: [] },
      },
    });

    res.json({
      success: true,
      data: {
        qrCode,
        secret,
        issuer: 'Orrica Edge',
        account: user.email,
        message: 'Scan the QR code with Google Authenticator, then enter the 6-digit code.',
      },
    });
  } catch (err) {
    next(err);
  }
};

export const verifyMfaSetup = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = setupSchema.parse(req.body);
    const user = await getAuthenticatedUser(req.user?.userId);

    if (!user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    if (user.mfaEnabled) {
      res.status(400).json({
        success: false,
        code: 'MFA_ALREADY_ENABLED',
        message: 'Multi-factor authentication is already enabled.',
      });
      return;
    }

    if (!user.mfaSecret) {
      res.status(400).json({
        success: false,
        code: 'MFA_SETUP_REQUIRED',
        message: 'Start MFA setup before verifying the code.',
      });
      return;
    }

    const decryptedSecret = decryptMfaSecret(user.mfaSecret);

    const result = await verify({
      secret: decryptedSecret.secret,
      token: data.code,
    });

    if (!result.valid) {
      res.status(400).json({
        success: false,
        code: 'INVALID_MFA_CODE',
        message: 'Invalid authentication code. Please enter the current 6-digit code.',
      });
      return;
    }

    // Upgrade any legacy plaintext secret to encrypted storage after a successful verification.
    if (decryptedSecret.legacy) {
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaSecret: encryptMfaSecret(decryptedSecret.secret) },
      });
    }

    const backupCodes = generateBackupCodes();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaBackupCodes: backupCodes.hashes,
        lastLoginAt: new Date(),
      },
    });

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwt.accessSecret,
      { expiresIn: '1d' }
    );

    res.json({
      success: true,
      message: 'Multi-factor authentication enabled successfully.',
      data: {
        token: accessToken,
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          phone: user.phone,
          avatarUrl: user.avatarUrl,
          recruiterId: user.recruiterId,
          mfaEnabled: true,
        },
        backupCodes: backupCodes.plain,
        backupCodesCount: backupCodes.plain.length,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const verifyMfaChallenge = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = challengeSchema.parse(req.body);
    if (req.user?.mfaState !== 'CHALLENGE_REQUIRED') {
      res.status(401).json({
        success: false,
        message: 'MFA challenge session is required.',
      });
      return;
    }

    const user = await getAuthenticatedUser(req.user?.userId);

    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      res.status(401).json({
        success: false,
        message: 'MFA challenge is invalid or expired.',
      });
      return;
    }

    const decryptedSecret = decryptMfaSecret(user.mfaSecret);

    let valid = false;
    let remainingBackupCodes: string[] = Array.isArray(user.mfaBackupCodes)
      ? user.mfaBackupCodes.filter((value): value is string => typeof value === 'string')
      : [];

    if (data.token) {
      const result = await verify({
        secret: decryptedSecret.secret,
        token: data.token,
      });
      valid = result.valid;
    } else if (data.backupCode) {
      const normalized = data.backupCode.trim().toUpperCase();
      const hash = hashBackupCode(normalized);
      const index = remainingBackupCodes.indexOf(hash);

      if (index >= 0) {
        valid = true;
        remainingBackupCodes = remainingBackupCodes.filter((_, i) => i !== index);
      }
    }

    if (!valid) {
      res.status(401).json({
        success: false,
        code: 'INVALID_MFA_CODE',
        message: 'Invalid authentication code or backup code.',
      });
      return;
    }

    if (decryptedSecret.legacy) {
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaSecret: encryptMfaSecret(decryptedSecret.secret) },
      });
    }

    if (data.backupCode) {
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaBackupCodes: remainingBackupCodes },
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwt.accessSecret,
      { expiresIn: '1d' }
    );

    res.json({
      success: true,
      message: 'MFA verification successful.',
      data: {
        token: accessToken,
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          phone: user.phone,
          avatarUrl: user.avatarUrl,
          recruiterId: user.recruiterId,
          mfaEnabled: true,
        },
        remainingBackupCodes: remainingBackupCodes.length,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const getMfaStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await getAuthenticatedUser(req.user?.userId);

    if (!user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const backupCodes = Array.isArray(user.mfaBackupCodes)
      ? user.mfaBackupCodes.filter((value): value is string => typeof value === 'string')
      : [];

    res.json({
      success: true,
      data: {
        enabled: user.mfaEnabled,
        backupCodesRemaining: backupCodes.length,
      },
    });
  } catch (err) {
    next(err);
  }
};
