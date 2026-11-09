import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

// Safe environment verification: log notice instead of crashing if JWT secrets are not yet customized in Render
if (isProduction) {
  const missingSecrets: string[] = [];
  if (!process.env.JWT_ACCESS_SECRET) missingSecrets.push('JWT_ACCESS_SECRET');
  if (!process.env.JWT_REFRESH_SECRET) missingSecrets.push('JWT_REFRESH_SECRET');
  if (!process.env.DATABASE_URL) missingSecrets.push('DATABASE_URL');
  if (missingSecrets.length > 0) {
    console.warn(
      `[SECURITY NOTICE] Missing environment variable(s) on production host: ${missingSecrets.join(
        ', '
      )}. Operating with default application secrets. Please configure these in your Render Environment settings for production hardening.`
    );
  }
}

const resolveSenderAddress = (): string => {
  const configured = (process.env.RESEND_FROM_EMAIL || '').trim();

  // If explicitly configured with unauthorized root domain orricaedge.com
  if (configured) {
    if (configured.includes('@orricaedge.com') && !configured.includes('@update.orricaedge.com')) {
      throw new Error(
        `[CRITICAL CONFIG ERROR] RESEND_FROM_EMAIL ("${configured}") specifies unauthorized root domain "orricaedge.com". Resend API key is restricted to "update.orricaedge.com". All automated emails must send from "Orrica Edge <noreply@update.orricaedge.com>".`
      );
    }
    return configured;
  }

  // Canonical centralized sender address
  return 'Orrica Edge <noreply@update.orricaedge.com>';
};

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',

  mfa: {
    encryptionKey:
      process.env.MFA_ENCRYPTION_KEY ||
      process.env.JWT_ACCESS_SECRET ||
      'orrica_edge_production_mfa_default_key_2026',
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'orrica_edge_access_default_secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'orrica_edge_refresh_default_secret',
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
      `${(process.env.FRONTEND_URL || 'https://orricaedge.com').replace(/\/+$/, '')}/set-password`,
    loginUrl:
      process.env.RECRUITER_LOGIN_URL ||
      `${(process.env.FRONTEND_URL || 'https://orricaedge.com').replace(/\/+$/, '')}/login`,
    passwordSetupExpiryHours: parseInt(
      process.env.RECRUITER_PASSWORD_SETUP_EXPIRY_HOURS || '24',
      10
    ),
  },

  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    from: resolveSenderAddress(),
    supportEmail: process.env.SUPPORT_EMAIL || 'info@orricaedge.com',
    formRecipientEmail: process.env.FORM_RECIPIENT_EMAIL || 'sudhanshu@orricaedge.com',
    formCcEmail: process.env.FORM_CC_EMAIL || '',
    responseTimeText: process.env.RESPONSE_TIME_TEXT || 'within 4 business hours',
    sendingDomain: 'update.orricaedge.com',
  },

  upload: {
    dir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads'),
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '5', 10),
  },
};
