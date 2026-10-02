-- Candidate feedback and joining date
ALTER TABLE "candidates"
ADD COLUMN "feedback" TEXT,
ADD COLUMN "dateOfJoin" TIMESTAMP(3);

CREATE INDEX "candidates_dateOfJoin_idx"
ON "candidates"("dateOfJoin");
