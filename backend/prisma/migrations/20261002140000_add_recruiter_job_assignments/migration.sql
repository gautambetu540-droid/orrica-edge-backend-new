-- Recruiter to Job many-to-many assignments.
CREATE TABLE "_RecruiterJobs" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX "_RecruiterJobs_AB_unique" ON "_RecruiterJobs"("A", "B");
CREATE INDEX "_RecruiterJobs_B_index" ON "_RecruiterJobs"("B");

ALTER TABLE "_RecruiterJobs"
ADD CONSTRAINT "_RecruiterJobs_A_fkey"
FOREIGN KEY ("A") REFERENCES "jobs"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_RecruiterJobs"
ADD CONSTRAINT "_RecruiterJobs_B_fkey"
FOREIGN KEY ("B") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
