-- Migration: 20261104121500_separate_operational_status_and_pipeline_stage
-- Purpose: Separate Operational Status (calling attempt result) from Pipeline Stage (recruitment journey)
-- Safe, reversible migration: keeps original data intact, sets nullable pipelineStage, creates transition history table.

-- 1. Add operationalStatus and pipelineStage columns to candidates table
ALTER TABLE "candidates"
ADD COLUMN IF NOT EXISTS "operationalStatus" TEXT,
ADD COLUMN IF NOT EXISTS "pipelineStage" TEXT;

-- 2. Safe initial population of operationalStatus from existing status (zero data loss)
UPDATE "candidates"
SET "operationalStatus" = "status"
WHERE "operationalStatus" IS NULL;

-- 3. Create indexes for high-performance filtering
CREATE INDEX IF NOT EXISTS "candidates_operationalStatus_idx" ON "candidates"("operationalStatus");
CREATE INDEX IF NOT EXISTS "candidates_pipelineStage_idx" ON "candidates"("pipelineStage");

-- 4. Create candidate_stage_transitions history table
CREATE TABLE IF NOT EXISTS "candidate_stage_transitions" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT,
    "changedById" TEXT,
    "sourceActivity" TEXT,
    "notes" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_stage_transitions_pkey" PRIMARY KEY ("id")
);

-- 5. Create indexes and foreign keys for candidate_stage_transitions
CREATE INDEX IF NOT EXISTS "candidate_stage_transitions_candidateId_changedAt_idx" ON "candidate_stage_transitions"("candidateId", "changedAt");
CREATE INDEX IF NOT EXISTS "candidate_stage_transitions_changedById_changedAt_idx" ON "candidate_stage_transitions"("changedById", "changedAt");
CREATE INDEX IF NOT EXISTS "candidate_stage_transitions_toStage_changedAt_idx" ON "candidate_stage_transitions"("toStage", "changedAt");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'candidate_stage_transitions_candidateId_fkey'
    ) THEN
        ALTER TABLE "candidate_stage_transitions"
        ADD CONSTRAINT "candidate_stage_transitions_candidateId_fkey"
        FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'candidate_stage_transitions_changedById_fkey'
    ) THEN
        ALTER TABLE "candidate_stage_transitions"
        ADD CONSTRAINT "candidate_stage_transitions_changedById_fkey"
        FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
