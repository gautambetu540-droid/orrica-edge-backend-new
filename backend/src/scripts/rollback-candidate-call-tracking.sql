-- Rollback: Remove lastCallAt, callAttempts, and lastCallOutcome from candidates table
DROP INDEX IF EXISTS "candidates_ownerRecruiterId_lastCallAt_idx";

ALTER TABLE "candidates"
DROP COLUMN IF EXISTS "lastCallOutcome",
DROP COLUMN IF EXISTS "callAttempts",
DROP COLUMN IF EXISTS "lastCallAt";

