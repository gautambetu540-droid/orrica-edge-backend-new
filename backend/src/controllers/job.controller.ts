import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { cache } from '../utils/cache';
import { sendSuccess, sendError } from '../utils/response';

const createJobSchema = z.object({
  title: z.string().min(3),
  clientId: z.string().uuid(),
  department: z.string().min(2),
  category: z.string().min(2),
  location: z.string().min(2),
  workMode: z.enum(['WORK_FROM_OFFICE', 'HYBRID', 'REMOTE']).default('WORK_FROM_OFFICE'),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP']).default('FULL_TIME'),
  experienceMin: z.coerce.number().int().min(0).default(0),
  experienceMax: z.coerce.number().int().min(0).default(3),
  salaryMin: z.coerce.number().optional(),
  salaryMax: z.coerce.number().optional(),
  salaryText: z.string().optional(),
  vacancies: z.coerce.number().int().min(1).default(1),
  skills: z.array(z.string()).default([]),
  contentHtml: z.string().min(10),
  status: z.enum(['DRAFT', 'PUBLISHED', 'PAUSED', 'CLOSED', 'ARCHIVED']).default('DRAFT'),
});

const generateJobCode = async (): Promise<string> => {
  const currentYear = new Date().getFullYear();
  const count = await prisma.job.count();
  const nextSeq = String(count + 1).padStart(3, '0');
  return `OE-${currentYear}-${nextSeq}`;
};

const slugify = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

// 1. Get Public / Filtered Jobs (Cached & Lean Field Selection)
export const getJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      search,
      department,
      category,
      location,
      workMode,
      employmentType,
      status = 'PUBLISHED',
      page = '1',
      limit = '10',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    // Check cache for standard public queries
    const cacheKey = `jobs:${search || ''}:${department || ''}:${category || ''}:${location || ''}:${workMode || ''}:${status}:${pageNum}:${limitNum}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      sendSuccess(res, cachedData);
      return;
    }

    const where: any = {
      status: status as any,
    };

    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { location: { contains: search as string, mode: 'insensitive' } },
        { department: { contains: search as string, mode: 'insensitive' } },
        { skills: { has: search as string } },
      ];
    }

    if (department) where.department = department as string;
    if (category) where.category = category as string;
    if (location) where.location = { contains: location as string, mode: 'insensitive' };
    if (workMode) where.workMode = workMode as any;
    if (employmentType) where.employmentType = employmentType as any;

    const [total, jobs] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { publishedAt: 'desc' },
        // LEAN SELECT: Never return huge contentHtml on list endpoints!
        select: {
          id: true,
          jobCode: true,
          title: true,
          slug: true,
          department: true,
          category: true,
          location: true,
          workMode: true,
          employmentType: true,
          experienceMin: true,
          experienceMax: true,
          salaryText: true,
          vacancies: true,
          skills: true,
          contentHtml: true,
          status: true,
          views: true,
          publishedAt: true,
          createdAt: true,
          client: {
            select: { id: true, companyName: true, industry: true },
          },
        },
      }),
    ]);

    const result = {
      jobs,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    };

    // Cache result for 60 seconds
    cache.set(cacheKey, result, 60);

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// 2. Get Single Job by Slug (Full Details)
export const getJobBySlug = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { slug } = req.params;

    const cacheKey = `job:slug:${slug}`;
    const cachedJob = cache.get(cacheKey);
    if (cachedJob) {
      // Async increment view counter without blocking
      prisma.job.update({ where: { slug }, data: { views: { increment: 1 } } }).catch(() => {});
      sendSuccess(res, { job: cachedJob });
      return;
    }

    const job = await prisma.job.findFirst({
      where: {
        OR: [{ slug }, { id: slug }, { jobCode: slug }],
      },
      include: {
        client: {
          select: { id: true, companyName: true, industry: true, website: true },
        },
      },
    });

    if (!job) {
      sendError(res, 'Job not found', 404);
      return;
    }

    // Cache single job for 120 seconds
    cache.set(cacheKey, job, 120);

    // Asynchronous view increment (Fire and forget)
    prisma.job.update({ where: { id: job.id }, data: { views: { increment: 1 } } }).catch(() => {});

    sendSuccess(res, { job });
  } catch (err) {
    next(err);
  }
};

// 3. Create Job (Admin / Recruiter) - Invalidates Cache
export const createJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = createJobSchema.parse(req.body);
    const userId = req.user!.userId;

    const jobCode = await generateJobCode();
    const baseSlug = slugify(data.title);
    const slug = `${baseSlug}-${jobCode.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

    const newJob = await prisma.job.create({
      data: {
        ...data,
        jobCode,
        slug,
        createdById: userId,
        publishedAt: data.status === 'PUBLISHED' ? new Date() : null,
      },
    });

    // Invalidate jobs cache
    cache.del('jobs:');

    sendSuccess(res, { job: newJob }, 'Job created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// 4. Update Job - Invalidates Cache
export const updateJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;

    const existing = await prisma.job.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'Job not found', 404);
      return;
    }

    // The frontend editor sends UI-only fields. Never pass the complete
    // frontend object directly to Prisma.
    const body = req.body || {};
    const updateData: any = {};

    const scalarFields = [
      'jobCode',
      'title',
      'slug',
      'department',
      'category',
      'location',
      'workMode',
      'employmentType',
      'experienceMin',
      'experienceMax',
      'salaryMin',
      'salaryMax',
      'salaryText',
      'vacancies',
      'skills',
      'languages',
      'contentHtml',
      'eligibilityCriteria',
      'requirements',
      'applicationQuestions',
      'status',
      'views',
      'publishedAt',
      'metaTitle',
      'metaDescription',
    ];

    for (const field of scalarFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }

    // Frontend sends clientId; Prisma relation updates use `client`.
    if (body.clientId !== undefined && body.clientId !== null && body.clientId !== '') {
      const clientId = String(body.clientId);

      const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { id: true },
      });

      if (!client) {
        sendError(res, 'Selected client not found', 400);
        return;
      }

      updateData.client = {
        connect: { id: clientId },
      };
    }

    // Keep numeric database fields numeric even when the frontend sends strings.
    if (body.experienceMin !== undefined) {
      updateData.experienceMin = Number(body.experienceMin);
    }

    if (body.experienceMax !== undefined) {
      updateData.experienceMax = Number(body.experienceMax);
    }

    if (body.salaryMin !== undefined && body.salaryMin !== null && body.salaryMin !== '') {
      updateData.salaryMin = Number(body.salaryMin);
    }

    if (body.salaryMax !== undefined && body.salaryMax !== null && body.salaryMax !== '') {
      updateData.salaryMax = Number(body.salaryMax);
    }

    if (body.vacancies !== undefined) {
      updateData.vacancies = Number(body.vacancies);
    }

    if (body.status === 'PUBLISHED' && existing.status !== 'PUBLISHED' && body.publishedAt === undefined) {
      updateData.publishedAt = new Date();
    }

    const updatedJob = await prisma.job.update({
      where: { id },
      data: updateData,
    });

    cache.del('jobs:');
    cache.del('job:slug:' + existing.slug);

    if (updatedJob.slug && updatedJob.slug !== existing.slug) {
      cache.del('job:slug:' + updatedJob.slug);
    }

    sendSuccess(res, { job: updatedJob }, 'Job updated successfully');
  } catch (err) {
    next(err);
  }
};

// 5. Delete Job - Invalidates Cache
export const deleteJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const existing = await prisma.job.findUnique({ where: { id } });

    await prisma.job.delete({ where: { id } });

    cache.del('jobs:');
    if (existing?.slug) cache.del(`job:slug:${existing.slug}`);

    sendSuccess(res, null, 'Job deleted successfully');
  } catch (err) {
    next(err);
  }
};
