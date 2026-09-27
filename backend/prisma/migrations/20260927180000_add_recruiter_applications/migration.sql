-- CreateTable
CREATE TYPE "RecruiterApplicationStatus" AS ENUM ('NEW', 'REVIEWING', 'CONTACTED', 'APPROVED', 'REJECTED');

CREATE TABLE "recruiter_applications" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "experienceYears" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "primaryDomain" TEXT,
    "currentCompany" TEXT,
    "linkedinUrl" TEXT,
    "message" TEXT,
    "resumeUrl" TEXT,
    "resumeFileName" TEXT,
    "status" "RecruiterApplicationStatus" NOT NULL DEFAULT 'NEW',
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruiter_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recruiter_applications_email_idx" ON "recruiter_applications"("email");
CREATE INDEX "recruiter_applications_status_idx" ON "recruiter_applications"("status");
CREATE INDEX "recruiter_applications_createdAt_idx" ON "recruiter_applications"("createdAt");

-- CreateIndex
