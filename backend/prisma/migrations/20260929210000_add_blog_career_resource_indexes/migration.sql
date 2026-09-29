-- Career Resources already use BlogPost as the CMS entity.
-- Add supporting indexes for efficient public/admin filtering and newest-first ordering.
CREATE INDEX IF NOT EXISTS "blog_posts_status_publishedAt_idx" ON "blog_posts"("status", "publishedAt");
CREATE INDEX IF NOT EXISTS "blog_posts_isFeatured_publishedAt_idx" ON "blog_posts"("isFeatured", "publishedAt");
CREATE INDEX IF NOT EXISTS "blog_posts_category_publishedAt_idx" ON "blog_posts"("category", "publishedAt");
