-- Add recruiter type
ALTER TABLE "users"
ADD COLUMN "recruiterType" TEXT NOT NULL DEFAULT 'INTERNAL';

-- Candidate ownership and creator tracking
ALTER TABLE "candidates"
ADD COLUMN "ownerRecruiterId" TEXT,
ADD COLUMN "createdById" TEXT;

CREATE INDEX "candidates_ownerRecruiterId_idx" ON "candidates"("ownerRecruiterId");
CREATE INDEX "candidates_createdById_idx" ON "candidates"("createdById");

ALTER TABLE "candidates"
ADD CONSTRAINT "candidates_ownerRecruiterId_fkey"
FOREIGN KEY ("ownerRecruiterId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "candidates"
ADD CONSTRAINT "candidates_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Candidate activity / EOD productivity ledger
CREATE TABLE "candidate_activities" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "userId" TEXT,
  "recruiterId" TEXT,
  "applicationId" TEXT,
  "jobId" TEXT,
  "action" TEXT NOT NULL,
  "notes" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_activities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "candidate_activities_candidateId_createdAt_idx"
ON "candidate_activities"("candidateId","createdAt");

CREATE INDEX "candidate_activities_recruiterId_createdAt_idx"
ON "candidate_activities"("recruiterId","createdAt");

CREATE INDEX "candidate_activities_action_createdAt_idx"
ON "candidate_activities"("action","createdAt");

CREATE INDEX "candidate_activities_jobId_createdAt_idx"
ON "candidate_activities"("jobId","createdAt");

ALTER TABLE "candidate_activities"
ADD CONSTRAINT "candidate_activities_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "candidates"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "candidate_activities"
ADD CONSTRAINT "candidate_activities_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "candidate_activities"
ADD CONSTRAINT "candidate_activities_recruiterId_fkey"
FOREIGN KEY ("recruiterId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "candidate_activities"
ADD CONSTRAINT "candidate_activities_applicationId_fkey"
FOREIGN KEY ("applicationId") REFERENCES "applications"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "candidate_activities"
ADD CONSTRAINT "candidate_activities_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "jobs"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
