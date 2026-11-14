-- Rollback script for Candidate Status SSOT Migration
-- Run this script if you need to revert candidate status columns to un-normalized states.

-- 1. Create a backup table before running any destructive changes (recommended)
-- CREATE TABLE "Candidate_status_backup" AS SELECT id, status, "operationalStatus", "pipelineStage" FROM "Candidate";

-- 2. Optional: Reset operationalStatus where it equals pipelineStage
UPDATE "Candidate"
SET "operationalStatus" = NULL
WHERE "operationalStatus" = "pipelineStage";

-- 3. Restore 'New' status default where status is empty
UPDATE "Candidate"
SET status = 'New'
WHERE status IS NULL OR status = '';
