import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';

const candidateStatus = z.enum([
  'NEW',
  'SCREENING',
  'SHORTLISTED',
  'INTERVIEW',
  'SELECTED',
  'REJECTED',
  'ON_HOLD',
  'JOINED',
  'DROPPED',
]);

const activitySchema = z.object({
  action: z.enum([
    'CONTACTED',
    'WALK_IN_SCHEDULED',
    'WALK_IN_ATTENDED',
    'WALK_IN_NO_SHOW',
    'SELECTED',
    'JOINED',
    'REJECTED',
    'NOTE',
  ]),
  notes: z.string().max(5000).optional(),
  jobId: z.string().uuid().optional(),
  applicationId: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
});

const createCandidateSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(180),
  phone: z.string().trim().min(7).max(30),
  location: z.string().trim().min(2).max(160),
  education: z.string().optional(),
  experienceYears: z.coerce.number().min(0).max(60).default(0),
  currentCompany: z.string().optional(),
  currentDesignation: z.string().optional(),
  currentCtc: z.coerce.number().min(0).optional(),
  expectedCtc: z.coerce.number().min(0).optional(),
  noticePeriodDays: z.coerce.number().min(0).max(3650).optional(),
  skills: z.array(z.string()).default([]),
  languages: z.array(z.string()).default(['English']),
  resumeUrl: z.string().url().max(2000),
  source: z.string().trim().max(100).optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(10000).optional(),
  feedback: z.string().max(10000).optional(),
  dateOfJoin: z.coerce.date().optional(),
  status: candidateStatus.optional(),
  ownerRecruiterId: z.string().uuid().nullable().optional(),
});

const updateCandidateSchema = createCandidateSchema.partial().extend({
  candidateCode: z.string().regex(/^OE-CAND-\d{4}$/).optional(),
});

const parseDate = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const buildDateFilter = (from?: Date, to?: Date) => {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  };
};

// Admin gets the complete candidate database. Recruiters see only their owned,
// created, or assigned application candidates.
export const getCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      search,
      status,
      location,
      skill,
      language,
      source,
      recruiterId,
      ownerRecruiterId,
      createdById,
      jobId,
      workMode,
      employmentType,
      walkInStatus,
      dateFrom,
      dateTo,
      page = '1',
      limit = '20',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const from = parseDate(dateFrom);
    const to = parseDate(dateTo);
    if (to) to.setHours(23, 59, 59, 999);

    const where: any = {};
    if (status) where.status = status as any;
    if (location) where.location = { contains: location as string, mode: 'insensitive' };
    if (skill) where.skills = { has: skill as string };
    if (language) where.languages = { has: language as string };
    if (source) where.source = { contains: source as string, mode: 'insensitive' };
    if (ownerRecruiterId) where.ownerRecruiterId = ownerRecruiterId as string;
    if (createdById) where.createdById = createdById as string;

    const isAdmin = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN';
    const currentUserId = req.user?.userId;

    if (!isAdmin && req.user?.role === 'RECRUITER') {
      where.OR = [
        { ownerRecruiterId: currentUserId },
        { createdById: currentUserId },
        { applications: { some: { recruiterId: currentUserId } } },
      ];
    }

    if (recruiterId) {
      where.applications = { some: { recruiterId: recruiterId as string } };
    }

    if (jobId || workMode || employmentType) {
      where.applications = {
        some: {
          ...(recruiterId ? { recruiterId: recruiterId as string } : {}),
          ...(jobId ? { jobId: jobId as string } : {}),
          ...(workMode ? { job: { workMode: workMode as any } } : {}),
          ...(employmentType ? { job: { employmentType: employmentType as any } } : {}),
        },
      };
    }

    if (walkInStatus) {
      const actionMap: Record<string, string> = {
        SCHEDULED: 'WALK_IN_SCHEDULED',
        ATTENDED: 'WALK_IN_ATTENDED',
        NO_SHOW: 'WALK_IN_NO_SHOW',
      };
      const action = actionMap[String(walkInStatus).toUpperCase()];
      if (action) {
        where.activities = { some: { action } };
      }
    }

    const createdAt = buildDateFilter(from, to);
    if (createdAt) where.createdAt = createdAt;

    if (search) {
      const searchOr = [
        { fullName: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
        { phone: { contains: search as string, mode: 'insensitive' } },
        { currentCompany: { contains: search as string, mode: 'insensitive' } },
        { currentDesignation: { contains: search as string, mode: 'insensitive' } },
        { candidateCode: { contains: search as string, mode: 'insensitive' } },
      ];
      // Preserve recruiter visibility while adding search.
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: searchOr }];
        delete where.OR;
      } else {
        where.OR = searchOr;
      }
    }

    const [total, candidates] = await Promise.all([
      prisma.candidate.count({ where }),
      prisma.candidate.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        include: {
          ownerRecruiter: {
            select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true },
          },
          createdBy: {
            select: { id: true, fullName: true, role: true, recruiterId: true },
          },
          applications: {
            orderBy: { appliedAt: 'desc' },
            include: {
              job: {
                select: {
                  id: true,
                  title: true,
                  jobCode: true,
                  department: true,
                  location: true,
                  workMode: true,
                  employmentType: true,
                },
              },
              recruiter: {
                select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true },
              },
              interviews: true,
            },
          },
          activities: {
            orderBy: { createdAt: 'desc' },
            take: 25,
            select: {
              id: true,
              action: true,
              notes: true,
              metadata: true,
              createdAt: true,
              recruiter: {
                select: { id: true, recruiterId: true, fullName: true, recruiterType: true },
              },
            },
          },
          _count: {
            select: { applications: true, assessmentAttempts: true, activities: true },
          },
        },
      }),
    ]);

    sendSuccess(res, {
      candidates,
      filters: {
        search,
        status,
        location,
        skill,
        language,
        source,
        recruiterId,
        ownerRecruiterId,
        createdById,
        jobId,
        workMode,
        employmentType,
        walkInStatus,
        dateFrom,
        dateTo,
      },
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

export const createCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = createCandidateSchema.parse(req.body);
    const currentUserId = req.user?.userId;
    const isRecruiter = req.user?.role === 'RECRUITER';
    const ownerRecruiterId = isRecruiter ? currentUserId : data.ownerRecruiterId ?? null;

    if (ownerRecruiterId) {
      const recruiter = await prisma.user.findFirst({
        where: { id: ownerRecruiterId, role: 'RECRUITER', isActive: true },
        select: { id: true },
      });
      if (!recruiter) {
        sendError(res, 'Assigned recruiter not found or inactive', 400);
        return;
      }
    }

    const existing = await prisma.candidate.findUnique({
      where: { email: data.email.toLowerCase() },
      select: { id: true },
    });
    if (existing) {
      sendError(res, 'A candidate with this email already exists', 409);
      return;
    }

    const candidate = await prisma.$transaction(async (tx) => {
      const last = await tx.candidate.findMany({
        select: { candidateCode: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      const current = last[0]?.candidateCode ? Number(last[0].candidateCode.replace('OE-CAND-', '')) : 0;
      const candidateCode = `OE-CAND-${String((Number.isFinite(current) ? current : 0) + 1).padStart(4, '0')}`;

      const created = await tx.candidate.create({
        data: {
          candidateCode,
          fullName: data.fullName,
          email: data.email.toLowerCase(),
          phone: data.phone,
          location: data.location,
          education: data.education,
          experienceYears: data.experienceYears,
          currentCompany: data.currentCompany,
          currentDesignation: data.currentDesignation,
          currentCtc: data.currentCtc,
          expectedCtc: data.expectedCtc,
          noticePeriodDays: data.noticePeriodDays,
          skills: data.skills,
          languages: data.languages,
          resumeUrl: data.resumeUrl,
          source: data.source || (isRecruiter ? 'Recruiter Added' : 'Admin Added'),
          tags: data.tags,
          notes: data.notes,
          feedback: data.feedback,
          dateOfJoin: data.dateOfJoin,
          status: data.status || 'NEW',
          ownerRecruiterId,
          createdById: currentUserId || null,
        },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: created.id,
          userId: currentUserId || null,
          recruiterId: ownerRecruiterId,
          action: 'CANDIDATE_CREATED',
          metadata: { source: created.source },
        },
      });

      return created;
    });

    await logAudit({
      req,
      action: 'CREATE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: candidate.id,
      newValue: {
        candidateCode: candidate.candidateCode,
        ownerRecruiterId: candidate.ownerRecruiterId,
        createdById: candidate.createdById,
      },
    });

    sendSuccess(res, { candidate }, 'Candidate created successfully', 201);
  } catch (err) {
    next(err);
  }
};

export const assignCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const candidateId = req.params.id;
    const schema = z.object({ recruiterId: z.string().uuid().nullable() });
    const { recruiterId } = schema.parse(req.body);

    const existing = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, ownerRecruiterId: true },
    });
    if (!existing) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (recruiterId) {
      const recruiter = await prisma.user.findFirst({
        where: { id: recruiterId, role: 'RECRUITER', isActive: true },
        select: { id: true },
      });
      if (!recruiter) {
        sendError(res, 'Recruiter not found or inactive', 400);
        return;
      }
    }

    const updated = await prisma.candidate.update({
      where: { id: candidateId },
      data: { ownerRecruiterId: recruiterId },
      include: {
        ownerRecruiter: { select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true } },
      },
    });

    await prisma.candidateActivity.create({
      data: {
        candidateId,
        userId: req.user?.userId || null,
        recruiterId,
        action: 'OWNER_ASSIGNED',
        metadata: {
          previousOwnerRecruiterId: existing.ownerRecruiterId,
          newOwnerRecruiterId: recruiterId,
        },
      },
    });

    await logAudit({
      req,
      action: 'ASSIGN_CANDIDATE_RECRUITER',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: candidateId,
      oldValue: { ownerRecruiterId: existing.ownerRecruiterId },
      newValue: { ownerRecruiterId: recruiterId },
    });

    sendSuccess(res, { candidate: updated }, 'Candidate recruiter assignment updated successfully');
  } catch (err) {
    next(err);
  }
};

export const addCandidateActivity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const candidateId = req.params.id;
    const data = activitySchema.parse(req.body);

    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, ownerRecruiterId: true },
    });
    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    let recruiterId = candidate.ownerRecruiterId || null;
    if (req.user?.role === 'RECRUITER') recruiterId = req.user.userId;

    const activity = await prisma.candidateActivity.create({
      data: {
        candidateId,
        userId: req.user?.userId || null,
        recruiterId,
        applicationId: data.applicationId,
        jobId: data.jobId,
        action: data.action,
        notes: data.notes,
        metadata: data.metadata,
      },
      include: {
        recruiter: { select: { id: true, recruiterId: true, fullName: true, recruiterType: true } },
      },
    });

    const statusByAction: Record<string, any> = {
      SELECTED: 'SELECTED',
      JOINED: 'JOINED',
      REJECTED: 'REJECTED',
    };
    if (statusByAction[data.action]) {
      await prisma.candidate.update({
        where: { id: candidateId },
        data: { status: statusByAction[data.action] },
      });
    }

    sendSuccess(res, { activity }, 'Candidate activity recorded successfully', 201);
  } catch (err) {
    next(err);
  }
};

export const getCandidateActivities = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const activities = await prisma.candidateActivity.findMany({
      where: { candidateId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        recruiter: { select: { id: true, recruiterId: true, fullName: true, recruiterType: true } },
        user: { select: { id: true, fullName: true, role: true } },
        job: { select: { id: true, title: true, jobCode: true } },
      },
    });
    sendSuccess(res, { activities });
  } catch (err) {
    next(err);
  }
};

export const getCandidateById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      include: {
        ownerRecruiter: {
          select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true },
        },
        createdBy: { select: { id: true, fullName: true, role: true, recruiterId: true } },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 200,
          include: {
            recruiter: { select: { id: true, recruiterId: true, fullName: true, recruiterType: true } },
            user: { select: { id: true, fullName: true, role: true } },
            job: { select: { id: true, title: true, jobCode: true } },
          },
        },
        applications: {
          include: {
            job: { select: { id: true, title: true, jobCode: true, department: true, location: true, workMode: true, employmentType: true } },
            recruiter: { select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true } },
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

export const deleteCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const existing = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      select: { id: true, candidateCode: true, fullName: true, email: true },
    });
    if (!existing) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    await prisma.candidate.delete({ where: { id: req.params.id } });

    await logAudit({
      req,
      action: 'DELETE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: req.params.id,
      oldValue: existing,
      newValue: null,
    });

    sendSuccess(res, { candidateId: req.params.id, candidateCode: existing.candidateCode }, 'Candidate deleted successfully');
  } catch (err) {
    next(err);
  }
};

export const updateCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = updateCandidateSchema.parse(req.body);
    const existing = await prisma.candidate.findUnique({ where: { id: req.params.id } });

    if (!existing) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const updated = await prisma.candidate.update({
      where: { id: req.params.id },
      data: {
        ...data,
        email: data.email ? data.email.toLowerCase() : undefined,
      } as any,
    });

    if (data.status && data.status !== existing.status) {
      await prisma.candidateActivity.create({
        data: {
          candidateId: req.params.id,
          userId: req.user?.userId || null,
          recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
          action: data.status === 'SELECTED' ? 'SELECTED' : data.status === 'JOINED' ? 'JOINED' : data.status === 'REJECTED' ? 'REJECTED' : 'STATUS_UPDATED',
          metadata: { oldStatus: existing.status, newStatus: data.status },
        },
      });
    }

    await logAudit({
      req,
      action: 'UPDATE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: req.params.id,
      oldValue: { status: existing.status, ownerRecruiterId: existing.ownerRecruiterId },
      newValue: { status: updated.status, ownerRecruiterId: updated.ownerRecruiterId },
    });

    sendSuccess(res, { candidate: updated }, 'Candidate profile updated successfully');
  } catch (err) {
    next(err);
  }
};
