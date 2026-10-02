-- Persist recruiter walk-in and follow-up scheduling on candidate records.
ALTER TABLE "candidates"
ADD COLUMN "walkInStatus" TEXT,
ADD COLUMN "walkInDate" TIMESTAMP(3),
ADD COLUMN "walkInTime" TEXT,
ADD COLUMN "followUpAt" TIMESTAMP(3),
ADD COLUMN "followUpCompletedAt" TIMESTAMP(3),
ADD COLUMN "rescheduleCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "candidates_ownerRecruiterId_followUpAt_idx"
ON "candidates"("ownerRecruiterId", "followUpAt");

CREATE INDEX "candidates_ownerRecruiterId_walkInDate_idx"
ON "candidates"("ownerRecruiterId", "walkInDate");
