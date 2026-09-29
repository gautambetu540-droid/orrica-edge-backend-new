import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { cache } from '../utils/cache';
import { sendSuccess, sendError } from '../utils/response';

const blogPostSchema = z.object({
  title: z.string().min(5).max(200),
  slug: z.string().min(3).max(220).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must contain lowercase letters, numbers and hyphens only'),
  category: z.string().min(2).max(100),
  excerpt: z.string().min(10).max(500),
  contentMarkdown: z.string().min(20),
  featuredImage: z.string().url().or(z.string().min(3)),
  authorName: z.string().min(1).max(150).default('Orrica Edge Career Editorial Team'),
  authorRole: z.string().min(1).max(150).default('Career Insights & Recruitment'),
  readingTime: z.string().min(1).max(50).default('8 min read'),
  isFeatured: z.boolean().default(false),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
  metaTitle: z.string().max(200).optional(),
  metaDescription: z.string().max(500).optional(),
  ogImage: z.string().url().or(z.string().min(3)).optional(),
});

const blogPostUpdateSchema = blogPostSchema.partial().extend({
  publishedAt: z.union([z.string().datetime(), z.null()]).optional(),
});

// In-memory cache keys are prefixed; invalidate every cached list entry safely.
const invalidateBlogCaches = (slug?: string) => {
  cache.del('blogs:');
  if (slug) cache.del(`blog:slug:${slug}`);
};

// 1. Get Blog Posts (public, published only)
export const getBlogPosts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { category, search, page = '1', limit = '12' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10) || 12));
    const skip = (pageNum - 1) * limitNum;

    const categoryValue = typeof category === 'string' ? category.trim() : '';
    const searchValue = typeof search === 'string' ? search.trim() : '';

    const cacheKey = `blogs:${categoryValue || 'all'}:${searchValue}:${pageNum}:${limitNum}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      sendSuccess(res, cached);
      return;
    }

    const where: any = {
      status: 'PUBLISHED',
    };

    if (categoryValue && categoryValue !== 'All Resources') {
      where.category = categoryValue;
    }

    if (searchValue) {
      where.OR = [
        { title: { contains: searchValue, mode: 'insensitive' } },
        { excerpt: { contains: searchValue, mode: 'insensitive' } },
        { category: { contains: searchValue, mode: 'insensitive' } },
      ];
    }

    const [total, posts] = await Promise.all([
      prisma.blogPost.count({ where }),
      prisma.blogPost.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: [{ isFeatured: 'desc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          title: true,
          slug: true,
          category: true,
          excerpt: true,
          featuredImage: true,
          authorName: true,
          authorRole: true,
          readingTime: true,
          isFeatured: true,
          publishedAt: true,
          updatedAt: true,
          views: true,
          metaTitle: true,
          metaDescription: true,
          ogImage: true,
        },
      }),
    ]);

    const result = {
      posts,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    };

    cache.set(cacheKey, result, 120);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// 2. Get Single Published Article by Slug (public)
export const getBlogPostBySlug = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { slug } = req.params;

    const cacheKey = `blog:slug:${slug}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      prisma.blogPost.update({ where: { id: cached.post?.id }, data: { views: { increment: 1 } } }).catch(() => {});
      sendSuccess(res, cached);
      return;
    }

    const post = await prisma.blogPost.findFirst({
      where: {
        slug,
        status: 'PUBLISHED',
      },
    });

    if (!post) {
      sendError(res, 'Article not found', 404);
      return;
    }

    const relatedPosts = await prisma.blogPost.findMany({
      where: {
        id: { not: post.id },
        status: 'PUBLISHED',
        category: post.category,
      },
      take: 3,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        slug: true,
        category: true,
        excerpt: true,
        featuredImage: true,
        readingTime: true,
        publishedAt: true,
      },
    });

    const result = { post, relatedPosts };
    cache.set(cacheKey, result, 180);

    prisma.blogPost.update({
      where: { id: post.id },
      data: { views: { increment: 1 } },
    }).catch(() => {});

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// 3. Create Article (Admin)
export const createBlogPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = blogPostSchema.parse(req.body);

    const existingSlug = await prisma.blogPost.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (existingSlug) {
      sendError(res, 'An article with this slug already exists.', 409);
      return;
    }

    const newPost = await prisma.blogPost.create({
      data: {
        ...data,
        publishedAt: data.status === 'PUBLISHED' ? new Date() : null,
      },
    });

    invalidateBlogCaches();
    sendSuccess(res, { post: newPost }, data.status === 'PUBLISHED' ? 'Article published successfully' : 'Article saved as draft', 201);
  } catch (err) {
    if (err instanceof z.ZodError) {
      sendError(res, 'Invalid article data.', 400, err.flatten());
      return;
    }
    next(err);
  }
};

// 4. Update Article (Admin)
export const updateBlogPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const updateData = blogPostUpdateSchema.parse(req.body);

    const existing = await prisma.blogPost.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'Article not found', 404);
      return;
    }

    if (updateData.slug && updateData.slug !== existing.slug) {
      const slugOwner = await prisma.blogPost.findUnique({
        where: { slug: updateData.slug },
        select: { id: true },
      });
      if (slugOwner && slugOwner.id !== id) {
        sendError(res, 'An article with this slug already exists.', 409);
        return;
      }
    }

    const data: any = { ...updateData };

    if (updateData.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') {
      data.publishedAt = new Date();
    } else if (updateData.status === 'DRAFT') {
      data.publishedAt = null;
    }

    const post = await prisma.blogPost.update({
      where: { id },
      data,
    });

    invalidateBlogCaches(existing.slug);
    if (post.slug !== existing.slug) {
      invalidateBlogCaches(post.slug);
    }

    sendSuccess(res, { post }, post.status === 'PUBLISHED' ? 'Article published successfully' : 'Article updated successfully');
  } catch (err) {
    if (err instanceof z.ZodError) {
      sendError(res, 'Invalid article data.', 400, err.flatten());
      return;
    }
    next(err);
  }
};

// 5. Delete Article (Admin)
export const deleteBlogPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const existing = await prisma.blogPost.findUnique({ where: { id }, select: { id: true, slug: true } });

    if (!existing) {
      sendError(res, 'Article not found', 404);
      return;
    }

    await prisma.blogPost.delete({ where: { id } });

    invalidateBlogCaches(existing.slug);
    sendSuccess(res, null, 'Article deleted successfully');
  } catch (err) {
    next(err);
  }
};
