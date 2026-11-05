-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subAdminId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_subAdminId_idx" ON "users"("subAdminId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_subAdminId_fkey'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_subAdminId_fkey" FOREIGN KEY ("subAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
