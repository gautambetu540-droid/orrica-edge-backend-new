-- Backfill permissions for recruiters created before recruiter permissions were introduced.
-- Missing rows receive the standard recruiter defaults.
INSERT INTO "recruiter_permissions" (
  "id",
  "recruiterId",
  "dashboard",
  "candidates",
  "jobs",
  "applications",
  "interviews",
  "payouts",
  "reports",
  "settings",
  "createdAt",
  "updatedAt"
)
SELECT
  md5(u."id" || ':recruiter-permissions')::uuid,
  u."id",
  true,
  true,
  true,
  true,
  true,
  false,
  true,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "users" u
LEFT JOIN "recruiter_permissions" rp
  ON rp."recruiterId" = u."id"
WHERE u."role" = 'RECRUITER'
  AND rp."recruiterId" IS NULL;

-- Existing recruiter permission rows also receive Reports + Settings access.
UPDATE "recruiter_permissions" rp
SET
  "reports" = true,
  "settings" = true,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "users" u
WHERE rp."recruiterId" = u."id"
  AND u."role" = 'RECRUITER';
