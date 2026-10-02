CREATE TABLE IF NOT EXISTS "recruiter_permissions" (
  "id" TEXT NOT NULL,
  "recruiterId" TEXT NOT NULL,
  "dashboard" BOOLEAN NOT NULL DEFAULT true,
  "candidates" BOOLEAN NOT NULL DEFAULT true,
  "jobs" BOOLEAN NOT NULL DEFAULT true,
  "applications" BOOLEAN NOT NULL DEFAULT true,
  "interviews" BOOLEAN NOT NULL DEFAULT true,
  "payouts" BOOLEAN NOT NULL DEFAULT false,
  "reports" BOOLEAN NOT NULL DEFAULT false,
  "settings" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recruiter_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_permissions_recruiterId_key"
ON "recruiter_permissions"("recruiterId");

CREATE INDEX IF NOT EXISTS "recruiter_permissions_recruiterId_idx"
ON "recruiter_permissions"("recruiterId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'recruiter_permissions_recruiterId_fkey'
  ) THEN
    ALTER TABLE "recruiter_permissions"
      ADD CONSTRAINT "recruiter_permissions_recruiterId_fkey"
      FOREIGN KEY ("recruiterId")
      REFERENCES "users"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;
