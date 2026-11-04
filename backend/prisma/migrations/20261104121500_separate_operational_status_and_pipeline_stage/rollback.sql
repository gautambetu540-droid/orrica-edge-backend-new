-- Rollback script for 20261104121500_separate_operational_status_and_pipeline_stage
DROP TABLE IF EXISTS "candidate_stage_transitions";
DROP INDEX IF EXISTS "candidates_operationalStatus_idx";
DROP INDEX IF EXISTS "candidates_pipelineStage_idx";
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "operationalStatus";
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "pipelineStage";
