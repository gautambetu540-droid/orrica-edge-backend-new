import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

// Fail safely in production if mandatory secrets are missing or using insecure fallbacks
if (isProduction) {
  const missingSecrets: string[] = [];
  if (!process.env.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_SECRET === 'orrica_edge_access_default_secret') {
    missingSecrets.push('JWT_ACCESS_SECRET');
  }
  if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET === 'orrica_edge_refresh_default_secret') {
    missingSecrets.push('JWT_REFRESH_SECRET');
  }
  if (!process.env.DATABASE_URL) {
    missingSecrets.push('DATABASE_URL');
  }
  if (missingSecrets.length > 0) {
    throw new Error(
      `[CRITICAL SECURITY CONFIG] Mandatory production environment variable(s) missing or insecure: ${missingSecrets.join(
        ', '
      )}. Server cannot start with insecure fallback secrets in production.`
    );
  }
}

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',

  mfa: {
    encryptionKey:
      process.env.MFA_ENCRYPTION_KEY ||
      process.env.JWT_ACCESS_SECRET ||
      (isProduction ? '' : 'orrica_edge_production_mfa_default_key_2026'),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || (isProduction ? '' : 'orrica_edge_access_default_secret'),
    refreshSecret: process.env.JWT_REFRESH_SECRET || (isProduction ? '' : 'orrica_edge_refresh_default_secret'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '1d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'https://orricaedge.com',
        'https://www.orricaedge.com',
        'https://orrica-edge-frontend-new.vercel.app',
      ],

  recruiter: {
    passwordSetupUrl:
      process.env.RECRUITER_PASSWORD_SETUP_URL ||
      'https://orricaedge.com/set-password',
    loginUrl:
      process.env.RECRUITER_LOGIN_URL ||
      'https://orricaedge.com/login',
    passwordSetupExpiryHours: parseInt(
      process.env.RECRUITER_PASSWORD_SETUP_EXPIRY_HOURS || '24',
      10
    ),
  },

  email: {
    from: process.env.EMAIL_FROM || 'Orrica Edge <no-reply@orricaedge.com>',
    supportEmail: process.env.SUPPORT_EMAIL || 'no-reply@orricaedge.com',
  },

  upload: {
    dir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads'),
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '5', 10),
  },
};
