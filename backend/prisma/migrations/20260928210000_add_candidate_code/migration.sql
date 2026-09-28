-- Add permanent human-readable candidate code.
ALTER TABLE "candidates"
ADD COLUMN "candidateCode" TEXT;

-- Backfill existing candidates in creation order.
WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "candidates"
)
UPDATE "candidates" c
SET "candidateCode" = 'OE-CAND-' || LPAD(ordered.rn::TEXT, 4, '0')
FROM ordered
WHERE c.id = ordered.id;

ALTER TABLE "candidates"
ALTER COLUMN "candidateCode" SET NOT NULL;

CREATE UNIQUE INDEX "candidates_candidateCode_key"
ON "candidates"("candidateCode");
