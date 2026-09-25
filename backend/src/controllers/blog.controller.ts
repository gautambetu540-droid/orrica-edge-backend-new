import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { cache } from '../utils/cache';
import { sendSuccess, sendError } from '../utils/response';

const blogPostSchema = z.object({
  title: z.string().min(5),
  slug: z.string().min(3),
  category: z.string().min(2),
  excerpt: z.string().min(10),
  contentMarkdown: z.string().min(20),
  featuredImage: z.string().url().or(z.string().min(3)),
  authorName: z.string().default('Orrica Edge Career Editorial Team'),
  authorRole: z.string().default('Career Insights & Recruitment'),
  readingTime: z.string().default('8 min read'),
  isFeatured: z.boolean().default(false),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('PUBLISHED'),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
});

// 1. Get Blog Posts (Cached & Lean Field Projection)
export const getBlogPosts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { category, search, page = '1', limit = '12' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = `blogs:${category || 'all'}:${search || ''}:${pageNum}:${limitNum}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      sendSuccess(res, cached);
      return;
    }

    const where: any = {
      status: 'PUBLISHED',
    };

    if (category && category !== 'All Resources') {
      where.category = category as string;
    }

    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { excerpt: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [total, posts] = await Promise.all([
      prisma.blogPost.count({ where }),
      prisma.blogPost.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: [{ isFeatured: 'desc' }, { publishedAt: 'desc' }],
        // LEAN SELECT: Exclude huge contentMarkdown on grid listing!
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
          views: true,
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

// 2. Get Single Article by Slug (Full Markdown Content)
export const getBlogPostBySlug = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { slug } = req.params;

    const cacheKey = `blog:slug:${slug}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      prisma.blogPost.update({ where: { slug }, data: { views: { increment: 1 } } }).catch(() => {});
      sendSuccess(res, cached);
      return;
    }

    const post = await prisma.blogPost.findFirst({
      where: { OR: [{ slug }, { id: slug }] },
    });

    if (!post) {
      sendError(res, 'Article not found', 404);
      return;
    }

    // Get 3 related articles from same category
    const relatedPosts = await prisma.blogPost.findMany({
      where: {
        id: { not: post.id },
        status: 'PUBLISHED',
        category: post.category,
      },
      take: 3,
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

    prisma.blogPost.update({ where: { id: post.id }, data: { views: { increment: 1 } } }).catch(() => {});

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// 3. Create Article (Admin) - Invalidates Cache
export const createBlogPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = blogPostSchema.parse(req.body);

    const newPost = await prisma.blogPost.create({
      data: {
        ...data,
        publishedAt: data.status === 'PUBLISHED' ? new Date() : null,
      },
    });

    cache.del('blogs:');

    sendSuccess(res, { post: newPost }, 'Article published successfully', 201);
  } catch (err) {
    next(err);
  }
};

// 4. Update Article - Invalidates Cache
export const updateBlogPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const post = await prisma.blogPost.update({
      where: { id },
      data: updateData,
    });

    cache.del('blogs:');
    cache.del(`blog:slug:${post.slug}`);

    sendSuccess(res, { post }, 'Article updated successfully');
  } catch (err) {
    next(err);
  }
};

// 5. Delete Article - Invalidates Cache
export const deleteBlogPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const existing = await prisma.blogPost.findUnique({ where: { id } });

    await prisma.blogPost.delete({ where: { id } });

    cache.del('blogs:');
    if (existing?.slug) cache.del(`blog:slug:${existing.slug}`);

    sendSuccess(res, null, 'Article deleted successfully');
  } catch (err) {
    next(err);
  }
};
