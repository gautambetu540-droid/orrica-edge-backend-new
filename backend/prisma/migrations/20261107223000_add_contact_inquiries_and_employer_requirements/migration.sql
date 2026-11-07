-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FormEmailStatus') THEN
    CREATE TYPE "FormEmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "contact_inquiries" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "source" TEXT,
    "emailStatus" "FormEmailStatus" NOT NULL DEFAULT 'PENDING',
    "emailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "employer_requirements" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "workEmail" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "location" TEXT,
    "workMode" TEXT,
    "jobType" TEXT,
    "targetExperience" TEXT,
    "additionalDetails" TEXT,
    "source" TEXT,
    "emailStatus" "FormEmailStatus" NOT NULL DEFAULT 'PENDING',
    "emailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employer_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "contact_inquiries_createdAt_idx" ON "contact_inquiries"("createdAt");
CREATE INDEX IF NOT EXISTS "contact_inquiries_emailStatus_idx" ON "contact_inquiries"("emailStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "employer_requirements_createdAt_idx" ON "employer_requirements"("createdAt");
CREATE INDEX IF NOT EXISTS "employer_requirements_emailStatus_idx" ON "employer_requirements"("emailStatus");
