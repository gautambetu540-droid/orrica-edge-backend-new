-- 1. Create ReviewStatus Enum if it doesn't exist
DO $$ BEGIN
    CREATE TYPE "ReviewStatus" AS ENUM ('PENDING_TL_REVIEW', 'TL_APPROVED', 'TL_SENT_BACK', 'TL_REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Add teamLeaderId to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT;

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_teamLeaderId_fkey" FOREIGN KEY ("teamLeaderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "users_teamLeaderId_idx" ON "users"("teamLeaderId");

-- 3. Add columns to candidates
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "name" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "fatherName" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "gender" "Gender";
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "currentLocation" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "preferredLocation" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "totalExperience" DECIMAL(4, 1) DEFAULT 0;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "relevantExperience" DECIMAL(4, 1) DEFAULT 0;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "highestQualification" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "previousCompany" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "noticePeriod" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "currentSalary" DECIMAL(10, 2);
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "expectedSalary" DECIMAL(10, 2);
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "nextActionDate" TIMESTAMP(3);
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "nextActionType" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "nextActionRemarks" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "sourcingRecruiterId" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT;

DO $$ BEGIN
  ALTER TABLE "candidates" ADD CONSTRAINT "candidates_sourcingRecruiterId_fkey" FOREIGN KEY ("sourcingRecruiterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "candidates" ADD CONSTRAINT "candidates_teamLeaderId_fkey" FOREIGN KEY ("teamLeaderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "candidates_status_idx" ON "candidates"("status");
CREATE INDEX IF NOT EXISTS "candidates_phone_idx" ON "candidates"("phone");
CREATE INDEX IF NOT EXISTS "candidates_email_idx" ON "candidates"("email");
CREATE INDEX IF NOT EXISTS "candidates_candidateCode_idx" ON "candidates"("candidateCode");
CREATE INDEX IF NOT EXISTS "candidates_sourcingRecruiterId_idx" ON "candidates"("sourcingRecruiterId");
CREATE INDEX IF NOT EXISTS "candidates_teamLeaderId_idx" ON "candidates"("teamLeaderId");
CREATE INDEX IF NOT EXISTS "candidates_nextActionDate_idx" ON "candidates"("nextActionDate");

-- 4. Add columns to applications
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "applicationCode" TEXT;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "appliedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'Submitted';
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "reviewStatus" "ReviewStatus" DEFAULT 'PENDING_TL_REVIEW';
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "sendBackReason" TEXT;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "sendBackRemarks" TEXT;

DO $$ BEGIN
  ALTER TABLE "applications" ADD CONSTRAINT "applications_teamLeaderId_fkey" FOREIGN KEY ("teamLeaderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "applications_status_idx" ON "applications"("status");
CREATE INDEX IF NOT EXISTS "applications_reviewStatus_idx" ON "applications"("reviewStatus");
CREATE INDEX IF NOT EXISTS "applications_recruiterId_idx" ON "applications"("recruiterId");
CREATE INDEX IF NOT EXISTS "applications_teamLeaderId_idx" ON "applications"("teamLeaderId");

-- 5. Create candidate_timelines table
CREATE TABLE IF NOT EXISTS "candidate_timelines" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "applicationId" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "userRole" TEXT,
    "action" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_timelines_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "candidate_timelines" ADD CONSTRAINT "candidate_timelines_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "candidate_timelines" ADD CONSTRAINT "candidate_timelines_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "candidate_timelines" ADD CONSTRAINT "candidate_timelines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "candidate_timelines_candidateId_createdAt_idx" ON "candidate_timelines"("candidateId", "createdAt");
CREATE INDEX IF NOT EXISTS "candidate_timelines_applicationId_createdAt_idx" ON "candidate_timelines"("applicationId", "createdAt");
CREATE INDEX IF NOT EXISTS "candidate_timelines_userId_createdAt_idx" ON "candidate_timelines"("userId", "createdAt");
