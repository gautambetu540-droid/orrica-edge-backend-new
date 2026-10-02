-- Add assessment question-bank and candidate assessment-attempt tables.
-- These models already exist in prisma/schema.prisma but were missing
-- from the production migration history.

CREATE TABLE "Assessment" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "timeLimit" INTEGER NOT NULL DEFAULT 30,
  "passingScore" INTEGER NOT NULL DEFAULT 60,
  "questions" JSONB NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssessmentAttempt" (
  "id" TEXT NOT NULL,
  "assessmentId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "totalMarks" INTEGER NOT NULL,
  "percentage" DECIMAL(5,2) NOT NULL,
  "isPassed" BOOLEAN NOT NULL,
  "answers" JSONB,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssessmentAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AssessmentAttempt"
ADD CONSTRAINT "AssessmentAttempt_assessmentId_fkey"
FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssessmentAttempt"
ADD CONSTRAINT "AssessmentAttempt_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "candidates"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
