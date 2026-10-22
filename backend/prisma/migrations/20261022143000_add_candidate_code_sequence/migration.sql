-- Create PostgreSQL sequence for atomic, collision-free candidate code generation
CREATE SEQUENCE IF NOT EXISTS candidate_code_seq START WITH 1 INCREMENT BY 1;

-- Synchronize sequence with the maximum existing numeric candidate code across both CND- and legacy OE-CAND- formats
DO $$
DECLARE
  v_max_cnd INTEGER := 0;
  v_max_legacy INTEGER := 0;
  v_max_val INTEGER := 0;
BEGIN
  -- Max from CND-XXXXXX
  SELECT COALESCE(MAX(SUBSTRING("candidateCode" FROM 5)::INTEGER), 0)
  INTO v_max_cnd
  FROM "candidates"
  WHERE "candidateCode" ~* '^CND-[0-9]+$';

  -- Max from OE-CAND-XXXX
  SELECT COALESCE(MAX(SUBSTRING("candidateCode" FROM 9)::INTEGER), 0)
  INTO v_max_legacy
  FROM "candidates"
  WHERE "candidateCode" ~* '^OE-CAND-[0-9]+$';

  v_max_val := GREATEST(v_max_cnd, v_max_legacy);

  IF v_max_val > 0 THEN
    PERFORM setval('candidate_code_seq', v_max_val + 1, false);
  ELSE
    PERFORM setval('candidate_code_seq', 1, false);
  END IF;
END $$;
