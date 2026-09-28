-- CreateTable
CREATE TABLE "universal_forms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "fields" JSONB NOT NULL,
    "successMessage" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "universal_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "universal_form_submissions" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "candidateId" TEXT,
    "payload" JSONB NOT NULL,
    "resumeUrl" TEXT,
    "resumeFileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "universal_form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "universal_forms_slug_key" ON "universal_forms"("slug");

-- CreateIndex
CREATE INDEX "universal_forms_isActive_idx" ON "universal_forms"("isActive");

-- CreateIndex
CREATE INDEX "universal_forms_createdAt_idx" ON "universal_forms"("createdAt");

-- CreateIndex
CREATE INDEX "universal_form_submissions_formId_createdAt_idx" ON "universal_form_submissions"("formId", "createdAt");

-- CreateIndex
CREATE INDEX "universal_form_submissions_candidateId_idx" ON "universal_form_submissions"("candidateId");

-- AddForeignKey
ALTER TABLE "universal_form_submissions"
ADD CONSTRAINT "universal_form_submissions_formId_fkey"
FOREIGN KEY ("formId") REFERENCES "universal_forms"("id")
ON DELETE CASCADE ON UPDATE CASCADE;


-- Add candidate relation so a candidate can be traced back to Universal Form submissions.
ALTER TABLE "universal_form_submissions"
ADD CONSTRAINT "universal_form_submissions_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "candidates"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
