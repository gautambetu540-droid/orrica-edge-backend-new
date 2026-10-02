import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';
import { createNotification } from '../services/notification.service';
import { uploadResumeFile } from '../services/storage.service';



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
  resumeUrl: z.union([z.string().url().max(2000), z.literal('')]).optional(),
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
const canAccessCandidate = async (req: Request, candidateId: string): Promise<boolean> => {
  const user = req.user;
  if (!user) return false;
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return true;
  if (user.role !== 'RECRUITER') return false;

  const accessibleCandidate = await prisma.candidate.findFirst({
    where: {
      id: candidateId,
      OR: [
        { ownerRecruiterId: user.userId },
        { createdById: user.userId },
        { applications: { some: { recruiterId: user.userId } } },
      ],
    },
    select: { id: true },
  });

  return Boolean(accessibleCandidate);
};

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

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const from = parseDate(dateFrom);
    const to = parseDate(dateTo);
    if (to) to.setHours(23, 59, 59, 999);

    const andFilters: any[] = [];

    if (status) andFilters.push({ status });
    if (location) andFilters.push({ location: { contains: String(location), mode: 'insensitive' } });
    if (skill) andFilters.push({ skills: { has: String(skill) } });
    if (language) andFilters.push({ languages: { has: String(language) } });
    if (source) andFilters.push({ source: { contains: String(source), mode: 'insensitive' } });
    if (ownerRecruiterId) andFilters.push({ ownerRecruiterId: String(ownerRecruiterId) });
    if (createdById) andFilters.push({ createdById: String(createdById) });

    const isAdmin = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN';
    const currentUserId = req.user?.userId;

    if (!isAdmin && req.user?.role === 'RECRUITER') {
      andFilters.push({
        OR: [
          { ownerRecruiterId: currentUserId },
          { createdById: currentUserId },
          { applications: { some: { recruiterId: currentUserId } } },
        ],
      });
    }

    const applicationSome: any = {};
    if (recruiterId) applicationSome.recruiterId = String(recruiterId);
    if (jobId) applicationSome.jobId = String(jobId);

    const jobFilter: any = {};
    if (workMode) jobFilter.workMode = workMode;
    if (employmentType) jobFilter.employmentType = employmentType;
    if (Object.keys(jobFilter).length) applicationSome.job = jobFilter;

    if (Object.keys(applicationSome).length) {
      andFilters.push({ applications: { some: applicationSome } });
    }

    if (walkInStatus) {
      const actionMap: Record<string, string> = {
        SCHEDULED: 'WALK_IN_SCHEDULED',
        ATTENDED: 'WALK_IN_ATTENDED',
        NO_SHOW: 'WALK_IN_NO_SHOW',
      };
      const action = actionMap[String(walkInStatus).toUpperCase()];
      if (action) andFilters.push({ activities: { some: { action } } });
    }

    const createdAt = buildDateFilter(from, to);
    if (createdAt) andFilters.push({ createdAt });

    if (search) {
      const q = String(search);
      andFilters.push({
        OR: [
          { candidateCode: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { currentCompany: { contains: q, mode: 'insensitive' } },
          { currentDesignation: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const where = andFilters.length ? { AND: andFilters } : {};

    const [total, candidates] = await Promise.all([
      prisma.candidate.count({ where }),
      prisma.candidate.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        include: {
          ownerRecruiter: {
            select: {
              id: true,
              recruiterId: true,
              fullName: true,
              email: true,
              recruiterType: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              fullName: true,
              role: true,
              recruiterId: true,
            },
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
                select: {
                  id: true,
                  recruiterId: true,
                  fullName: true,
                  email: true,
                  recruiterType: true,
                },
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
                select: {
                  id: true,
                  recruiterId: true,
                  fullName: true,
                  recruiterType: true,
                },
              },
              user: {
                select: {
                  id: true,
                  fullName: true,
                  role: true,
                },
              },
            },
          },
          _count: {
            select: {
              applications: true,
              assessmentAttempts: true,
              activities: true,
            },
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
          resumeUrl: data.resumeUrl || '',
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

    const updated = await prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id: candidateId },
        data: { ownerRecruiterId: recruiterId },
        include: {
          ownerRecruiter: { select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true } },
        },
      });

      await tx.candidateActivity.create({
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

      if (recruiterId && recruiterId !== existing.ownerRecruiterId) {
        await tx.notification.create({
          data: {
            userId: recruiterId,
            title: 'Candidate assigned to you',
            message: 'A candidate has been assigned to your recruiter bucket. Open My Candidates to review the profile.',
            type: 'CANDIDATE_ASSIGNED',
            link: '/recruiter/candidates',
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: req.user?.userId || null,
          action: 'ASSIGN_CANDIDATE_RECRUITER',
          module: 'CANDIDATES',
          entity: 'Candidate',
          entityId: candidateId,
          oldValue: { ownerRecruiterId: existing.ownerRecruiterId },
          newValue: { ownerRecruiterId: recruiterId },
          ipAddress: req.ip || req.socket?.remoteAddress || null,
          userAgent: req.headers['user-agent'] || null,
        },
      });

      return candidate;
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
    if (!candidate || !(await canAccessCandidate(req, candidateId))) {
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
    if (!(await canAccessCandidate(req, req.params.id))) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

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
    if (!(await canAccessCandidate(req, req.params.id))) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

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

    if (!existing || !(await canAccessCandidate(req, req.params.id))) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (
      req.user?.role === 'RECRUITER' &&
      data.ownerRecruiterId !== undefined &&
      data.ownerRecruiterId !== existing.ownerRecruiterId
    ) {
      sendError(res, 'Recruiters cannot change candidate ownership.', 403);
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


export const recruiterSubmitCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId || req.user?.role !== 'RECRUITER') {
      sendError(res, 'Recruiter authentication is required.', 403);
      return;
    }

    const recruiter = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, recruiterId: true, recruiterType: true, isActive: true },
    });

    if (!recruiter || !recruiter.isActive) {
      sendError(res, 'Recruiter account is inactive or unavailable.', 403);
      return;
    }

    const body = req.body || {};
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const location = String(body.location || '').trim();
    const jobId = String(body.jobId || '').trim();

    if (fullName.length < 2 || !email || !phone || !location || !jobId) {
      sendError(res, 'Name, email, phone, location and target job are required.', 400);
      return;
    }

    const emailCheck = z.string().email().safeParse(email);
    if (!emailCheck.success) {
      sendError(res, 'Please provide a valid candidate email address.', 400);
      return;
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        status: true,
      },
    });

    if (!job) {
      sendError(res, 'Target job not found.', 404);
      return;
    }

    if (String(job.status).toUpperCase() !== 'PUBLISHED') {
      sendError(res, 'This job is not currently open for candidate submissions.', 400);
      return;
    }

    const experienceYears = Number(body.experienceYears || 0);
    const relevantExperience = Number(body.relevantExperience || 0);
    const currentCtc = Number(body.currentCtc || 0);
    const expectedCtc = Number(body.expectedCtc || 0);
    const noticePeriodDays = Number(body.noticePeriodDays || 0);

    const parseList = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
      return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
    };

    const skills = parseList(body.skills);
    const languages = parseList(body.languages);
    const dateOfJoin = parseDate(body.dateOfJoin);
    const feedback = String(body.feedback || '').trim() || undefined;
    const recruiterRemarks = String(body.recruiterRemarks || '').trim();

    const existingCandidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { email },
          { phone },
        ],
      },
      select: {
        id: true,
        candidateCode: true,
        fullName: true,
        email: true,
        phone: true,
        ownerRecruiterId: true,
        resumeUrl: true,
      },
    });

    if (existingCandidate?.ownerRecruiterId && existingCandidate.ownerRecruiterId !== recruiter.id) {
      sendError(res, 'This candidate is owned by another recruiter. Ask an admin to reassign them.', 409);
      return;
    }

    if (existingCandidate) {
      const existingApplication = await prisma.application.findUnique({
        where: {
          jobId_candidateId: {
            jobId,
            candidateId: existingCandidate.id,
          },
        },
        select: { id: true, stage: true },
      });

      if (existingApplication) {
        sendError(res, 'This candidate has already been submitted for the selected job.', 409);
        return;
      }
    }

    const uploaded = req.file ? await uploadResumeFile(req.file, fullName) : null;

    const result = await prisma.$transaction(async (tx) => {
      let candidate;

      if (existingCandidate) {
        candidate = await tx.candidate.update({
          where: { id: existingCandidate.id },
          data: {
            location,
            education: body.education ? String(body.education) : undefined,
            experienceYears: Number.isFinite(experienceYears) ? experienceYears : 0,
            currentCompany: body.currentCompany ? String(body.currentCompany) : undefined,
            currentDesignation: body.currentDesignation ? String(body.currentDesignation) : undefined,
            currentCtc: Number.isFinite(currentCtc) ? currentCtc : undefined,
            expectedCtc: Number.isFinite(expectedCtc) ? expectedCtc : undefined,
            noticePeriodDays: Number.isFinite(noticePeriodDays) ? noticePeriodDays : undefined,
            skills,
            languages: languages.length ? languages : ['English'],
            ...(uploaded ? { resumeUrl: uploaded.fileUrl } : {}),
            source: 'Recruiter Submission',
            tags: { push: 'Recruiter Submission' },
            notes: recruiterRemarks || undefined,
            feedback,
            dateOfJoin,
            ownerRecruiterId: recruiter.id,
            createdById: existingCandidate.ownerRecruiterId || recruiter.id,
          },
        });
      } else {
        const last = await tx.candidate.findFirst({
          select: { candidateCode: true },
          orderBy: { candidateCode: 'desc' },
        });
        const currentCode = last?.candidateCode
          ? Number(last.candidateCode.replace('OE-CAND-', ''))
          : 0;
        const candidateCode = `OE-CAND-${String(
          (Number.isFinite(currentCode) ? currentCode : 0) + 1
        ).padStart(4, '0')}`;

        candidate = await tx.candidate.create({
          data: {
            candidateCode,
            fullName,
            email,
            phone,
            location,
            education: body.education ? String(body.education) : undefined,
            experienceYears: Number.isFinite(experienceYears) ? experienceYears : 0,
            currentCompany: body.currentCompany ? String(body.currentCompany) : undefined,
            currentDesignation: body.currentDesignation ? String(body.currentDesignation) : undefined,
            currentCtc: Number.isFinite(currentCtc) ? currentCtc : undefined,
            expectedCtc: Number.isFinite(expectedCtc) ? expectedCtc : undefined,
            noticePeriodDays: Number.isFinite(noticePeriodDays) ? noticePeriodDays : undefined,
            skills,
            languages: languages.length ? languages : ['English'],
            resumeUrl: uploaded?.fileUrl || '',
            source: 'Recruiter Submission',
            tags: ['Recruiter Submission'],
            notes: recruiterRemarks || undefined,
            feedback,
            dateOfJoin,
            ownerRecruiterId: recruiter.id,
            createdById: recruiter.id,
            status: 'SCREENING',
          },
        });
      }

      const application = await tx.application.create({
        data: {
          candidateId: candidate.id,
          jobId,
          recruiterId: recruiter.id,
          stage: 'APPLIED',
          internalNotes: recruiterRemarks ? { recruiterRemarks } : undefined,
          timeline: [{ stage: 'APPLIED', at: new Date().toISOString(), by: recruiter.id }],
        },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: candidate.id,
          userId: recruiter.id,
          recruiterId: recruiter.id,
          applicationId: application.id,
          jobId,
          action: existingCandidate ? 'SUBMITTED_TO_JOB' : 'CANDIDATE_CREATED',
          notes: recruiterRemarks || feedback || null,
          metadata: {
            source: 'RECRUITER_SUBMISSION',
            candidateCode: candidate.candidateCode,
            ...(uploaded ? { fileUrl: uploaded.fileUrl } : {}),
          },
        },
      });

      return { candidate, application };
    });

    await createNotification({
      userId: recruiter.id,
      title: 'Candidate submitted successfully',
      message: `${result.candidate.fullName} has been added to your candidate bucket for ${job.title}.`,
      type: 'CANDIDATE_ADDED',
      link: '/recruiter/candidates',
    });

    await logAudit({
      req,
      action: existingCandidate ? 'SUBMIT_EXISTING_CANDIDATE' : 'CREATE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: result.candidate.id,
      newValue: {
        candidateCode: result.candidate.candidateCode,
        recruiterId: recruiter.recruiterId,
        jobId,
        applicationId: result.application.id,
      },
    });

    sendSuccess(
      res,
      {
        candidate: result.candidate,
        application: result.application,
        recruiter: {
          id: recruiter.id,
          recruiterId: recruiter.recruiterId,
          name: recruiter.fullName,
        },
      },
      existingCandidate
        ? 'Existing candidate submitted to the selected job successfully.'
        : 'Candidate submitted successfully.'
    );
  } catch (err) {
    next(err);
  }
};

