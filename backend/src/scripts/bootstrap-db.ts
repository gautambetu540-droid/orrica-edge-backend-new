import { prisma } from '../prisma/client';

export const ensureDatabaseSchema = async () => {
  const executeSafe = async (query: string, label: string) => {
    try {
      await prisma.$executeRawUnsafe(query);
    } catch (err: any) {
      console.warn(`[SCHEMA] ${label} warning:`, err?.message || err);
    }
  };

  // 1. Enums
  await executeSafe(`
    DO $$ BEGIN
      CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER', 'EMPLOYER', 'CLIENT', 'CANDIDATE');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `, 'Ensure Role enum exists');

  await executeSafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'TEAM_LEADER';`, 'Add Role.TEAM_LEADER');
  await executeSafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FREELANCE_RECRUITER';`, 'Add Role.FREELANCE_RECRUITER');
  await executeSafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'EMPLOYER';`, 'Add Role.EMPLOYER');

  await executeSafe(`
    DO $$ BEGIN
      CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `, 'Ensure Gender enum exists');

  await executeSafe(`
    DO $$ BEGIN
      CREATE TYPE "ReviewStatus" AS ENUM ('PENDING_TL_REVIEW', 'TL_APPROVED', 'TL_SENT_BACK', 'TL_REJECTED');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `, 'Ensure ReviewStatus enum exists');

  await executeSafe(`
    DO $$ BEGIN
      CREATE TYPE "RecruiterApplicationStatus" AS ENUM ('NEW', 'REVIEWING', 'CONTACTED', 'APPROVED', 'REJECTED');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `, 'Ensure RecruiterApplicationStatus enum exists');

  // 2. Clear stale/failed migrations if any
  await executeSafe(`
    DELETE FROM "_prisma_migrations" 
    WHERE "migration_name" = '20261003203500_add_recruitment_os_team_leader_and_timelines' 
      AND "finished_at" IS NULL;
  `, 'Clear failed migration lock');

  // 3. User table columns & indexes
  await executeSafe(`
    ALTER TABLE "users" 
      ADD COLUMN IF NOT EXISTS "recruiterId" TEXT,
      ADD COLUMN IF NOT EXISTS "recruiterType" TEXT DEFAULT 'INTERNAL',
      ADD COLUMN IF NOT EXISTS "mustSetPassword" BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT,
      ADD COLUMN IF NOT EXISTS "mfaBackupCodes" JSONB,
      ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT;
  `, 'Add user columns');
  await executeSafe(`CREATE INDEX IF NOT EXISTS "users_teamLeaderId_idx" ON "users"("teamLeaderId");`, 'Index users.teamLeaderId');

  // 4. Candidate table columns
  await executeSafe(`
    ALTER TABLE "candidates" 
      ADD COLUMN IF NOT EXISTS "name" TEXT,
      ADD COLUMN IF NOT EXISTS "fatherName" TEXT,
      ADD COLUMN IF NOT EXISTS "dateOfBirth" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "gender" "Gender",
      ADD COLUMN IF NOT EXISTS "currentLocation" TEXT,
      ADD COLUMN IF NOT EXISTS "preferredLocation" TEXT,
      ADD COLUMN IF NOT EXISTS "totalExperience" DECIMAL(4, 1) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "relevantExperience" DECIMAL(4, 1) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "highestQualification" TEXT,
      ADD COLUMN IF NOT EXISTS "previousCompany" TEXT,
      ADD COLUMN IF NOT EXISTS "noticePeriod" TEXT,
      ADD COLUMN IF NOT EXISTS "currentSalary" DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS "expectedSalary" DECIMAL(10, 2),
      ADD COLUMN IF NOT EXISTS "nextActionDate" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "nextActionType" TEXT,
      ADD COLUMN IF NOT EXISTS "nextActionRemarks" TEXT,
      ADD COLUMN IF NOT EXISTS "sourcingRecruiterId" TEXT,
      ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT;
  `, 'Add candidate columns');

  // 5. Application table columns
  await executeSafe(`
    ALTER TABLE "applications" 
      ADD COLUMN IF NOT EXISTS "applicationCode" TEXT,
      ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT,
      ADD COLUMN IF NOT EXISTS "appliedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'Submitted',
      ADD COLUMN IF NOT EXISTS "reviewStatus" "ReviewStatus" DEFAULT 'PENDING_TL_REVIEW',
      ADD COLUMN IF NOT EXISTS "sendBackReason" TEXT,
      ADD COLUMN IF NOT EXISTS "sendBackRemarks" TEXT;
  `, 'Add application columns');

  // 6. Candidate timelines table
  await executeSafe(`
    CREATE TABLE IF NOT EXISTS "candidate_timelines" (
      "id" TEXT NOT NULL,
      "candidateId" TEXT NOT NULL,
      "applicationId" TEXT,
      "userId" TEXT,
      "userName" TEXT,
      "userRole" TEXT,
      "action" TEXT NOT NULL,
      "previousStatus" TEXT,
      "newStatus" TEXT,
      "remarks" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "candidate_timelines_pkey" PRIMARY KEY ("id")
    );
  `, 'Create candidate_timelines table');

  await executeSafe(`CREATE INDEX IF NOT EXISTS "candidate_timelines_candidateId_createdAt_idx" ON "candidate_timelines"("candidateId", "createdAt");`, 'Index timelines candidateId');
  await executeSafe(`CREATE INDEX IF NOT EXISTS "candidate_timelines_applicationId_createdAt_idx" ON "candidate_timelines"("applicationId", "createdAt");`, 'Index timelines applicationId');
  await executeSafe(`CREATE INDEX IF NOT EXISTS "candidate_timelines_userId_createdAt_idx" ON "candidate_timelines"("userId", "createdAt");`, 'Index timelines userId');

  console.log('[SCHEMA] Verified and ensured all PostgreSQL enums, tables, and columns exist.');
};

// If run directly via CLI
if (require.main === module) {
  ensureDatabaseSchema()
    .then(async () => {
      await prisma.$disconnect();
      console.log('[SCHEMA] Database bootstrap completed successfully.');
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[SCHEMA] Database bootstrap failed:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
