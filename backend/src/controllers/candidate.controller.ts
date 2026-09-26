import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';

const updateCandidateSchema = z.object({
  fullName: z.string().min(2).optional(),
  phone: z.string().min(7).optional(),
  location: z.string().optional(),
  education: z.string().optional(),
  experienceYears: z.number().optional(),
  currentCompany: z.string().optional(),
  currentDesignation: z.string().optional(),
  currentCtc: z.number().optional(),
  expectedCtc: z.number().optional(),
  noticePeriodDays: z.number().optional(),
  skills: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  status: z
    .enum([
      'NEW',
      'SCREENING',
      'SHORTLISTED',
      'INTERVIEW',
      'SELECTED',
      'REJECTED',
      'ON_HOLD',
      'JOINED',
      'DROPPED',
    ])
    .optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

// 1. List Candidates with Filtering, Search, Pagination
export const getCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { search, status, location, skill, page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (status) where.status = status as any;
    if (location) where.location = { contains: location as string, mode: 'insensitive' };
    if (skill) where.skills = { has: skill as string };

    if (search) {
      where.OR = [
        { fullName: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
        { phone: { contains: search as string, mode: 'insensitive' } },
        { currentCompany: { contains: search as string, mode: 'insensitive' } },
        { currentDesignation: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [total, candidates] = await Promise.all([
      prisma.candidate.count({ where }),
      prisma.candidate.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        include: {
          applications: {
            orderBy: { appliedAt: 'desc' },
            include: {
              job: { select: { id: true, title: true, jobCode: true } },
            },
          },
          _count: {
            select: { applications: true, assessmentAttempts: true },
          },
        },
      }),
    ]);

    sendSuccess(res, {
      candidates,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// 2. Get Candidate Details (Full History)
export const getCandidateById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: {
        applications: {
          include: {
            job: { select: { id: true, title: true, jobCode: true, department: true } },
            interviews: true,
          },
          orderBy: { appliedAt: 'desc' },
        },
        assessmentAttempts: {
          include: { assessment: { select: { title: true, category: true } } },
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    sendSuccess(res, { candidate });
  } catch (err) {
    next(err);
  }
};

// 3. Update Candidate Profile & Status
export const updateCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const data = updateCandidateSchema.parse(req.body);

    const existing = await prisma.candidate.findUnique({ where: { id } });
    if (!existing) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const updated = await prisma.candidate.update({
      where: { id },
      data: data as any,
    });

    await logAudit({
      req,
      action: 'UPDATE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: id,
      oldValue: { status: existing.status },
      newValue: { status: updated.status },
    });

    sendSuccess(res, { candidate: updated }, 'Candidate profile updated successfully');
  } catch (err) {
    next(err);
  }
};
