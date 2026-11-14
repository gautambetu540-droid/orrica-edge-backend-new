-- Migration: 20261114240000_add_candidate_call_tracking_fields
-- Purpose: Add dedicated lastCallAt, callAttempts, and lastCallOutcome to candidates table with index
-- Safe, additive migration: zero data loss, non-blocking default values.

-- 1. Add call tracking columns to candidates table
ALTER TABLE "candidates"
ADD COLUMN IF NOT EXISTS "lastCallAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "callAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "lastCallOutcome" TEXT;

-- 2. Create index for high-performance recruiter calling aggregation
CREATE INDEX IF NOT EXISTS "candidates_ownerRecruiterId_lastCallAt_idx" ON "candidates"("ownerRecruiterId", "lastCallAt");
