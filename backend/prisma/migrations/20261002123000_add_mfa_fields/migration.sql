-- MFA/TOTP settings for all authenticated user roles.
ALTER TABLE "users"
ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "mfaSecret" TEXT,
ADD COLUMN "mfaBackupCodes" JSONB;
