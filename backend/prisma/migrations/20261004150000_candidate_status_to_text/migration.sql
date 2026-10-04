-- Safely migrate candidates.status from enum "CandidateStatus" to TEXT
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'candidates' 
      AND column_name = 'status' 
      AND udt_name = 'CandidateStatus'
  ) THEN
    ALTER TABLE "candidates" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "candidates" ALTER COLUMN "status" TYPE TEXT USING "status"::TEXT;
    ALTER TABLE "candidates" ALTER COLUMN "status" SET DEFAULT 'New';

    UPDATE "candidates" SET "status" = 'New' WHERE "status" = 'NEW';
    UPDATE "candidates" SET "status" = 'Screening' WHERE "status" = 'SCREENING';
    UPDATE "candidates" SET "status" = 'Shortlisted' WHERE "status" = 'SHORTLISTED';
    UPDATE "candidates" SET "status" = 'Interview Scheduled' WHERE "status" = 'INTERVIEW';
    UPDATE "candidates" SET "status" = 'Selected' WHERE "status" = 'SELECTED';
    UPDATE "candidates" SET "status" = 'Rejected' WHERE "status" = 'REJECTED';
    UPDATE "candidates" SET "status" = 'On Hold' WHERE "status" = 'ON_HOLD';
    UPDATE "candidates" SET "status" = 'Joined' WHERE "status" = 'JOINED';
    UPDATE "candidates" SET "status" = 'Not Interested' WHERE "status" = 'DROPPED';
  END IF;
END $$;

-- Drop CandidateStatus enum if it exists and is no longer used by any column
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE udt_name = 'CandidateStatus'
  ) THEN
    DROP TYPE IF EXISTS "CandidateStatus";
  END IF;
END $$;
