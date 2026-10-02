-- Persist recruiter notification and UI preferences on users.
ALTER TABLE "users"
ADD COLUMN "preferences" JSONB;
