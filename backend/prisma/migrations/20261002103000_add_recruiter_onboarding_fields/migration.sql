ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "recruiterId" TEXT,
  ADD COLUMN IF NOT EXISTS "mustSetPassword" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "users_recruiterId_key"
  ON "users"("recruiterId");
