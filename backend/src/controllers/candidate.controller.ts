import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';
import { createNotification } from '../services/notification.service';
import { uploadResumeFile } from '../services/storage.service';
import { generateCandidateCode, generateApplicationCode } from '../utils/codeGenerators';
import { logCandidateTimeline } from '../services/timeline.service';

export const CANONICAL_PIPELINE_STAGES = [
  'New',
  'Contacted',
  'Interested',
  'Screening',
  'Eligible',
  'Submitted',
  'Shortlisted',
  'Assessment',
  'Interview Scheduled',
  'Interview Completed',
  'Selected',
  'Joining Pending',
  'Joined',
  'Rejected',
  'On Hold',
  'Not Interested',
  'No Response',
  'Not Eligible',
  'Withdrawn',
  'Duplicate',
  'NEW',
  'SCREENING',
  'SHORTLISTED',
  'INTERVIEW',
  'SELECTED',
  'REJECTED',
  'ON_HOLD',
  'JOINED',
  'DROPPED',
] as const;

const candidateStatus = z.string();

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

const walkInStatuses = ['EXPECTED', 'CONFIRMED', 'ARRIVED', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED', 'COMPLETED'] as const;
const walkInResponses = ['COMING_TODAY', 'COMING_TOMORROW', 'SPECIFIC_DATE', 'NOT_SURE', 'NOT_INTERESTED', 'NO_RESPONSE'] as const;

const safeDate = z
  .union([z.coerce.date(), z.string(), z.literal('')])
  .nullable()
  .optional()
  .transform((val) => {
    if (!val || val === '') return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  });

const createCandidateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  fullName: z.string().trim().min(2).max(160).optional(),
  email: z.string().trim().email().max(180),
  phone: z.string().trim().min(7).max(30),
  fatherName: z.string().trim().max(160).nullable().optional(),
  dateOfBirth: safeDate,
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable().optional(),
  currentLocation: z.string().trim().max(160).optional(),
  location: z.string().trim().max(160).optional(),
  preferredLocation: z.string().trim().max(160).nullable().optional(),
  totalExperience: z.coerce.number().min(0).max(60).optional(),
  relevantExperience: z.coerce.number().min(0).max(60).optional(),
  experienceYears: z.coerce.number().min(0).max(60).optional(),
  highestQualification: z.string().trim().max(160).optional(),
  education: z.string().optional(),
  currentCompany: z.string().nullable().optional(),
  currentDesignation: z.string().nullable().optional(),
  previousCompany: z.string().nullable().optional(),
  noticePeriod: z.union([z.string(), z.number()]).nullable().optional(),
  noticePeriodDays: z.coerce.number().min(0).max(3650).optional(),
  currentSalary: z.coerce.number().min(0).optional(),
  expectedSalary: z.coerce.number().min(0).optional(),
  currentCtc: z.coerce.number().min(0).optional(),
  expectedCtc: z.coerce.number().min(0).optional(),
  skills: z.array(z.string()).default([]),
  languages: z.array(z.string()).default(['English', 'Hindi']),
  resumeUrl: z.union([z.string().url().max(2000), z.literal('')]).optional(),
  source: z.string().trim().max(100).optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(10000).optional(),
  feedback: z.string().max(10000).optional(),
  recruiterRemarks: z.string().max(10000).optional(),
  dateOfJoin: safeDate,
  walkInStatus: z.enum(walkInStatuses).nullable().optional(),
  walkInResponse: z.enum(walkInResponses).nullable().optional(),
  walkInDate: safeDate,
  walkInTime: z.string().max(32).nullable().optional(),
  followUpAt: safeDate,
  followUpCompletedAt: safeDate,
  rescheduleReason: z.string().trim().max(1000).optional(),
  status: candidateStatus.optional(),
  sourcingRecruiterId: z.string().nullable().optional(),
  teamLeaderId: z.string().nullable().optional(),
  ownerRecruiterId: z.string().nullable().optional(),
  assignedRecruiterId: z.string().nullable().optional(),
  jobId: z.string().nullable().optional(),
  targetJobId: z.string().nullable().optional(),
  nextActionDate: safeDate,
  nextActionType: z.enum(['Call', 'Confirm Interview', 'Follow-up', 'Prep']).nullable().optional(),
  nextActionRemarks: z.string().max(5000).nullable().optional(),
});

const updateCandidateSchema = createCandidateSchema.partial().extend({
  candidateCode: z.string().optional(),
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

// Admin gets the complete candidate database.
// Team Leader sees all candidates in their pod.
// Recruiters see only their owned, sourced, created, or assigned candidates.
const canAccessCandidate = async (req: Request, candidateIdentifier: string): Promise<boolean> => {
  const user = req.user;
  if (!user) return false;
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return true;

  const candidateIdFilter = [
    { id: candidateIdentifier },
    { candidateCode: candidateIdentifier },
  ];

  if (user.role === 'TEAM_LEADER') {
    const accessible = await prisma.candidate.findFirst({
      where: {
        OR: candidateIdFilter,
        AND: {
          OR: [
            { teamLeaderId: user.userId },
            { sourcingRecruiter: { teamLeaderId: user.userId } },
            { sourcingRecruiterId: user.userId },
            { ownerRecruiterId: user.userId },
          ],
        },
      },
      select: { id: true },
    });
    return Boolean(accessible);
  }

  if (user.role === 'RECRUITER' || user.role === 'FREELANCE_RECRUITER') {
    const accessibleCandidate = await prisma.candidate.findFirst({
      where: {
        OR: candidateIdFilter,
        AND: {
          OR: [
            { sourcingRecruiterId: user.userId },
            { ownerRecruiterId: user.userId },
            { createdById: user.userId },
            { applications: { some: { recruiterId: user.userId } } },
          ],
        },
      },
      select: { id: true },
    });
    return Boolean(accessibleCandidate);
  }

  return false;
};

/**
 * 2. DUPLICATE CANDIDATE CHECK API (Critical Requirement)
 * Endpoint: POST /api/candidates/check-duplicate
 */
export const checkDuplicateCandidate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const phone = req.body.phone ? String(req.body.phone).trim() : undefined;
    const email = req.body.email ? String(req.body.email).trim().toLowerCase() : undefined;

    if (!phone && !email) {
      sendError(res, 'At least one of phone or email is required to check for duplicates.', 400);
      return;
    }

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          ...(phone ? [{ phone }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
      include: {
        sourcingRecruiter: {
          select: { id: true, fullName: true, email: true },
        },
        teamLeader: {
          select: { id: true, fullName: true, email: true },
        },
        ownerRecruiter: {
          select: { id: true, fullName: true, email: true },
        },
        applications: {
          orderBy: { appliedDate: 'desc' },
          take: 1,
          include: {
            job: {
              select: { id: true, jobCode: true, title: true, department: true },
            },
          },
        },
      },
    });

    if (candidate) {
      const latestApp = candidate.applications[0];
      const sourcingRecruiterName =
        candidate.sourcingRecruiter?.fullName ||
        candidate.ownerRecruiter?.fullName ||
        null;
      const teamLeaderName = candidate.teamLeader?.fullName || null;

      sendSuccess(res, {
        exists: true,
        candidateId: candidate.candidateCode || candidate.id,
        candidate: {
          id: candidate.id,
          candidateCode: candidate.candidateCode,
          name: candidate.name || candidate.fullName,
          phone: candidate.phone,
          email: candidate.email,
          status: candidate.status,
          sourcingRecruiterName,
          teamLeaderName,
          currentApplication: latestApp
            ? {
                jobCode: latestApp.job.jobCode,
                jobTitle: latestApp.job.title,
                status: latestApp.status || latestApp.stage,
              }
            : null,
        },
      });
      return;
    }

    sendSuccess(res, {
      exists: false,
      candidate: null,
    });
  } catch (err) {
    next(err);
  }
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
      sourcingRecruiterId,
      teamLeaderId,
      ownerRecruiterId,
      createdById,
      jobId,
      workMode,
      employmentType,
      walkInStatus,
      walkInDateFrom,
      walkInDateTo,
      followUpDateFrom,
      followUpDateTo,
      followUpPending,
      followUpCategory,
      nextActionType,
      joiningDateFrom,
      joiningDateTo,
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
    if (sourcingRecruiterId) andFilters.push({ sourcingRecruiterId: String(sourcingRecruiterId) });
    if (teamLeaderId) andFilters.push({ teamLeaderId: String(teamLeaderId) });
    if (createdById) andFilters.push({ createdById: String(createdById) });
    if (nextActionType) andFilters.push({ nextActionType: String(nextActionType) });

    // Section 5: Follow-Up Engine API filters
    if (followUpCategory) {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      const upcomingEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000); // 72 hours window

      if (followUpCategory === 'overdue') {
        andFilters.push({ nextActionDate: { lt: startOfToday } });
      } else if (followUpCategory === 'due_today') {
        andFilters.push({ nextActionDate: { gte: startOfToday, lte: endOfToday } });
      } else if (followUpCategory === 'upcoming') {
        andFilters.push({ nextActionDate: { gt: endOfToday, lte: upcomingEnd } });
      }
    }

    // Section 4: Role-Based Access Control (RBAC) & Data Ownership
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;

    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      andFilters.push({
        OR: [
          { sourcingRecruiterId: currentUserId },
          { ownerRecruiterId: currentUserId },
          { createdById: currentUserId },
          { applications: { some: { recruiterId: currentUserId } } },
        ],
      });
    } else if (userRole === 'TEAM_LEADER') {
      andFilters.push({
        OR: [
          { teamLeaderId: currentUserId },
          { sourcingRecruiter: { teamLeaderId: currentUserId } },
          { sourcingRecruiterId: currentUserId },
          { ownerRecruiterId: currentUserId },
        ],
      });
    }
    // Admins and Super Admins have global visibility across all candidates.

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
      const requestedStatus = String(walkInStatus).toUpperCase();
      const actionMap: Record<string, string> = {
        SCHEDULED: 'WALK_IN_SCHEDULED',
        ATTENDED: 'WALK_IN_ATTENDED',
        NO_SHOW: 'WALK_IN_NO_SHOW',
      };
      const action = actionMap[requestedStatus];
      andFilters.push({
        OR: [
          { walkInStatus: requestedStatus },
          ...(action ? [{ activities: { some: { action } } }] : []),
        ],
      });
    }

    const walkInDate = buildDateFilter(parseDate(walkInDateFrom), parseDate(walkInDateTo));
    if (walkInDate) andFilters.push({ walkInDate });
    const followUpAt = buildDateFilter(parseDate(followUpDateFrom), parseDate(followUpDateTo));
    if (followUpAt) andFilters.push({ followUpAt });
    if (String(followUpPending).toLowerCase() === 'true') andFilters.push({ followUpAt: { not: null }, followUpCompletedAt: null });
    const dateOfJoin = buildDateFilter(parseDate(joiningDateFrom), parseDate(joiningDateTo));
    if (dateOfJoin) andFilters.push({ dateOfJoin });

    const createdAt = buildDateFilter(from, to);
    if (createdAt) andFilters.push({ createdAt });

    if (search) {
      const q = String(search).trim();
      andFilters.push({
        OR: [
          { candidateCode: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { currentCompany: { contains: q, mode: 'insensitive' } },
          { currentDesignation: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const where = andFilters.length ? { AND: andFilters } : {};
    const statusFilters = andFilters.filter((filter: any) => !Object.prototype.hasOwnProperty.call(filter, 'status'));
    const statusSummaryWhere = statusFilters.length ? { AND: statusFilters } : {};

    const [total, candidates, statusGroups] = await Promise.all([
      prisma.candidate.count({ where }),
      prisma.candidate.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        include: {
          sourcingRecruiter: {
            select: {
              id: true,
              recruiterId: true,
              fullName: true,
              email: true,
              recruiterType: true,
            },
          },
          teamLeader: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
          },
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
            orderBy: { appliedDate: 'desc' },
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
              teamLeader: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
              interviews: true,
            },
          },
          timelines: {
            orderBy: { createdAt: 'desc' },
            take: 20,
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
              timelines: true,
            },
          },
        },
      }),
      prisma.candidate.groupBy({
        by: ['status'],
        where: statusSummaryWhere,
        _count: { _all: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      statusGroups.map((group) => [group.status, group._count._all])
    );

    sendSuccess(res, {
      candidates,
      statusCounts,
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
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;

    const cleanPhone = data.phone.trim();
    const cleanEmail = data.email.trim().toLowerCase();

    // 2. Hard server-side duplicate check (Critical Requirement)
    const existingCandidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { phone: cleanPhone },
          { email: cleanEmail },
        ],
      },
      include: {
        sourcingRecruiter: { select: { id: true, fullName: true, email: true } },
        teamLeader: { select: { id: true, fullName: true, email: true } },
        ownerRecruiter: { select: { id: true, fullName: true, email: true } },
        applications: {
          orderBy: { appliedDate: 'desc' },
          take: 1,
          include: {
            job: { select: { id: true, jobCode: true, title: true } },
          },
        },
      },
    });

    if (existingCandidate) {
      const latestApp = existingCandidate.applications[0];
      const sourcingRecruiterName =
        existingCandidate.sourcingRecruiter?.fullName ||
        existingCandidate.ownerRecruiter?.fullName ||
        null;
      const teamLeaderName = existingCandidate.teamLeader?.fullName || null;

      res.status(409).json({
        success: false,
        code: 'DUPLICATE_CANDIDATE',
        message: 'A candidate with this phone number or email already exists in the system.',
        data: {
          exists: true,
          candidateId: existingCandidate.candidateCode || existingCandidate.id,
          candidate: {
            id: existingCandidate.id,
            candidateCode: existingCandidate.candidateCode,
            name: existingCandidate.name || existingCandidate.fullName,
            phone: existingCandidate.phone,
            email: existingCandidate.email,
            status: existingCandidate.status,
            sourcingRecruiterName,
            teamLeaderName,
            currentApplication: latestApp
              ? {
                  jobCode: latestApp.job.jobCode,
                  jobTitle: latestApp.job.title,
                  status: latestApp.status || latestApp.stage,
                }
              : null,
          },
        },
      });
      return;
    }

    // Determine Recruiter Pod Lineage
    let sourcingRecruiterId = data.sourcingRecruiterId || null;
    let teamLeaderId = data.teamLeaderId || null;

    if (!sourcingRecruiterId && (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER')) {
      sourcingRecruiterId = currentUserId || null;
    }

    if (sourcingRecruiterId && !teamLeaderId) {
      const recruiter = await prisma.user.findUnique({
        where: { id: sourcingRecruiterId },
        select: { teamLeaderId: true },
      });
      if (recruiter?.teamLeaderId) {
        teamLeaderId = recruiter.teamLeaderId;
      }
    }

    if (!teamLeaderId && userRole === 'TEAM_LEADER') {
      teamLeaderId = currentUserId || null;
    }

    const ownerRecruiterId = (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER')
      ? currentUserId
      : (data.assignedRecruiterId || data.ownerRecruiterId || sourcingRecruiterId || null);

    const targetJobIdentifier = data.jobId || data.targetJobId;
    let targetJob: { id: string; jobCode: string; title: string; department: string | null } | null = null;
    if (targetJobIdentifier) {
      targetJob = await prisma.job.findFirst({
        where: {
          OR: [
            { id: targetJobIdentifier },
            { jobCode: targetJobIdentifier },
          ],
        },
        select: { id: true, jobCode: true, title: true, department: true },
      });
    }

    const candidateName = data.name || data.fullName || 'Candidate';
    const candidateLocation = data.currentLocation || data.location || '';
    const totalExp = data.totalExperience ?? data.experienceYears ?? 0;
    const relExp = data.relevantExperience ?? 0;
    const highestQual = data.highestQualification || data.education || null;
    const notice = data.noticePeriod !== undefined ? String(data.noticePeriod) : (data.noticePeriodDays ? `${data.noticePeriodDays} Days` : null);
    const currSal = data.currentSalary ?? data.currentCtc ?? null;
    const expSal = data.expectedSalary ?? data.expectedCtc ?? null;
    const candidateNotes = data.notes || data.recruiterRemarks || null;

    const candidate = await prisma.$transaction(async (tx) => {
      // 7. Auto-incrementing candidate code: CND-XXXXXX
      const candidateCode = await generateCandidateCode(tx);

      const created = await tx.candidate.create({
        data: {
          candidateCode,
          name: candidateName,
          fullName: candidateName,
          email: cleanEmail,
          phone: cleanPhone,
          fatherName: data.fatherName || null,
          dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
          gender: data.gender || null,
          currentLocation: candidateLocation,
          location: candidateLocation,
          preferredLocation: data.preferredLocation || null,
          totalExperience: totalExp,
          relevantExperience: relExp,
          experienceYears: totalExp,
          highestQualification: highestQual,
          education: highestQual,
          currentCompany: data.currentCompany || null,
          currentDesignation: data.currentDesignation || null,
          previousCompany: data.previousCompany || null,
          noticePeriod: notice,
          noticePeriodDays: data.noticePeriodDays || (typeof data.noticePeriod === 'number' ? data.noticePeriod : null),
          currentSalary: currSal,
          expectedSalary: expSal,
          currentCtc: currSal,
          expectedCtc: expSal,
          skills: data.skills,
          languages: data.languages,
          resumeUrl: data.resumeUrl || '',
          source: data.source || (userRole === 'RECRUITER' ? 'Recruiter Added' : 'Direct Entry'),
          tags: data.tags,
          notes: candidateNotes,
          feedback: data.feedback,
          dateOfJoin: data.dateOfJoin,
          walkInStatus: data.walkInStatus,
          walkInResponse: data.walkInResponse,
          walkInDate: data.walkInDate,
          walkInTime: data.walkInTime,
          followUpAt: data.followUpAt,
          followUpCompletedAt: data.followUpCompletedAt,
          status: data.status || 'New',
          nextActionDate: data.nextActionDate || null,
          nextActionType: data.nextActionType || null,
          nextActionRemarks: data.nextActionRemarks || null,
          sourcingRecruiterId,
          teamLeaderId,
          ownerRecruiterId,
          createdById: currentUserId || null,
        },
        include: {
          sourcingRecruiter: { select: { id: true, fullName: true, email: true } },
          teamLeader: { select: { id: true, fullName: true, email: true } },
        },
      });

      // If target job was passed, link Application atomically
      if (targetJob) {
        const appCode = await generateApplicationCode(tx);
        await tx.application.create({
          data: {
            applicationCode: appCode,
            jobId: targetJob.id,
            candidateId: created.id,
            recruiterId: ownerRecruiterId || sourcingRecruiterId || null,
            teamLeaderId: teamLeaderId || null,
            status: 'Submitted',
            stage: 'APPLIED',
            reviewStatus: 'PENDING_TL_REVIEW',
            appliedDate: new Date(),
            timeline: [
              {
                stage: 'Submitted',
                timestamp: new Date().toISOString(),
                action: `Candidate added directly for job ${targetJob.title} (${targetJob.jobCode})`,
              },
            ],
          },
        });
      }

      // 1.D Audit Timeline record
      await logCandidateTimeline({
        candidateId: created.id,
        userId: currentUserId || null,
        userName: req.user?.email,
        userRole: req.user?.role,
        action: 'Candidate Created',
        newStatus: created.status,
        remarks: `Candidate profile created (${created.candidateCode}) by ${req.user?.email || 'User'}`,
        client: tx,
      });

      if (created.walkInDate || created.walkInResponse || created.followUpAt) {
        await tx.candidateActivity.create({
          data: {
            candidateId: created.id,
            userId: currentUserId || null,
            recruiterId: ownerRecruiterId,
            action: 'WALK_IN_SCHEDULED',
            metadata: {
              walkInStatus: created.walkInStatus,
              walkInResponse: created.walkInResponse,
              walkInDate: created.walkInDate?.toISOString() ?? null,
              walkInTime: created.walkInTime,
              followUpAt: created.followUpAt?.toISOString() ?? null,
            },
          },
        });
      }

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
        sourcingRecruiterId: candidate.sourcingRecruiterId,
        teamLeaderId: candidate.teamLeaderId,
        ownerRecruiterId: candidate.ownerRecruiterId,
      },
    });

    const fullCandidate = await prisma.candidate.findUnique({
      where: { id: candidate.id },
      include: {
        sourcingRecruiter: { select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true } },
        teamLeader: { select: { id: true, fullName: true, email: true } },
        ownerRecruiter: { select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true } },
        createdBy: { select: { id: true, fullName: true, role: true, recruiterId: true } },
        applications: {
          include: {
            job: { select: { id: true, title: true, jobCode: true, department: true, location: true, workMode: true, employmentType: true } },
            recruiter: { select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true } },
            teamLeader: { select: { id: true, fullName: true, email: true } },
            interviews: true,
          },
          orderBy: { appliedDate: 'desc' },
        },
      },
    });

    sendSuccess(res, { candidate: fullCandidate || candidate }, 'Candidate created successfully', 201);
  } catch (err) {
    next(err);
  }
};

export const assignCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const schema = z.object({ recruiterId: z.string().uuid().nullable() });
    const { recruiterId } = schema.parse(req.body);

    const existing = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
        ],
      },
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
        where: { id: existing.id },
        data: { ownerRecruiterId: recruiterId },
        include: {
          ownerRecruiter: { select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true } },
        },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: existing.id,
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
          entityId: existing.id,
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
    const identifier = req.params.id;
    const data = activitySchema.parse(req.body);

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
        ],
      },
      select: { id: true, ownerRecruiterId: true },
    });
    if (!candidate || !(await canAccessCandidate(req, identifier))) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    let recruiterId = candidate.ownerRecruiterId || null;
    if (req.user?.role === 'RECRUITER') recruiterId = req.user.userId;

    const activity = await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
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
        where: { id: candidate.id },
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
    const identifier = req.params.id;
    if (!(await canAccessCandidate(req, identifier))) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
        ],
      },
      select: { id: true },
    });
    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const activities = await prisma.candidateActivity.findMany({
      where: { candidateId: candidate.id },
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
    const identifier = req.params.id;
    if (!(await canAccessCandidate(req, identifier))) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
        ],
      },
      include: {
        sourcingRecruiter: {
          select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true },
        },
        teamLeader: {
          select: { id: true, fullName: true, email: true },
        },
        ownerRecruiter: {
          select: { id: true, recruiterId: true, fullName: true, email: true, recruiterType: true },
        },
        createdBy: { select: { id: true, fullName: true, role: true, recruiterId: true } },
        timelines: {
          orderBy: { createdAt: 'desc' },
        },
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
            teamLeader: { select: { id: true, fullName: true, email: true } },
            interviews: true,
          },
          orderBy: { appliedDate: 'desc' },
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
    const identifier = req.params.id;
    const existing = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
        ],
      },
      select: { id: true, candidateCode: true, fullName: true, email: true },
    });
    if (!existing) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    await prisma.candidate.delete({ where: { id: existing.id } });

    await logAudit({
      req,
      action: 'DELETE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: existing.id,
      oldValue: existing,
      newValue: null,
    });

    sendSuccess(res, { candidateId: existing.id, candidateCode: existing.candidateCode }, 'Candidate deleted successfully');
  } catch (err) {
    next(err);
  }
};

export const updateCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const data = updateCandidateSchema.parse(req.body);
    const existing = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
        ],
      },
    });

    if (!existing || !(await canAccessCandidate(req, identifier))) {
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

    const { rescheduleReason, ...candidateData } = data;
    const walkInWasRescheduled =
      existing.walkInDate !== null &&
      ((data.walkInDate != null && data.walkInDate.getTime() !== existing.walkInDate.getTime()) ||
        (data.walkInTime !== undefined && data.walkInTime !== existing.walkInTime));
    if (walkInWasRescheduled && !rescheduleReason?.trim()) {
      sendError(res, 'A reason is required when rescheduling a walk-in.', 400);
      return;
    }
    const updated = await prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id: existing.id },
        data: {
          ...candidateData,
          email: data.email ? data.email.toLowerCase() : undefined,
          ...(walkInWasRescheduled ? { rescheduleCount: { increment: 1 } } : {}),
        } as any,
      });

      if (walkInWasRescheduled) {
        await tx.candidateActivity.create({
          data: {
            candidateId: existing.id,
            userId: req.user?.userId || null,
            recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
            action: 'WALK_IN_RESCHEDULED',
            notes: rescheduleReason,
            metadata: {
              previousDate: existing.walkInDate?.toISOString(),
              newDate: data.walkInDate?.toISOString(),
              newTime: data.walkInTime ?? existing.walkInTime,
            },
          },
        });
      }

      const walkInChanged =
        (data.walkInStatus !== undefined && data.walkInStatus !== existing.walkInStatus) ||
        (data.walkInResponse !== undefined && data.walkInResponse !== existing.walkInResponse) ||
        (data.walkInDate !== undefined && data.walkInDate?.getTime() !== existing.walkInDate?.getTime()) ||
        (data.walkInTime !== undefined && data.walkInTime !== existing.walkInTime);
      if (walkInChanged && !walkInWasRescheduled) {
        await tx.candidateActivity.create({
          data: {
            candidateId: existing.id,
            userId: req.user?.userId || null,
            recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
            action: 'WALK_IN_UPDATED',
            metadata: {
              walkInStatus: data.walkInStatus ?? existing.walkInStatus,
              walkInResponse: data.walkInResponse ?? existing.walkInResponse,
              walkInDate: data.walkInDate?.toISOString() ?? existing.walkInDate?.toISOString() ?? null,
              walkInTime: data.walkInTime ?? existing.walkInTime,
            },
          },
        });
      }

      if (data.followUpAt !== undefined && data.followUpAt?.getTime() !== existing.followUpAt?.getTime()) {
        await tx.candidateActivity.create({
          data: {
            candidateId: existing.id,
            userId: req.user?.userId || null,
            recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
            action: 'FOLLOW_UP_SCHEDULED',
            metadata: { followUpAt: data.followUpAt?.toISOString() ?? null },
          },
        });
      }

      if (data.followUpCompletedAt && !existing.followUpCompletedAt) {
        await tx.candidateActivity.create({
          data: {
            candidateId: existing.id,
            userId: req.user?.userId || null,
            recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
            action: 'FOLLOW_UP_COMPLETED',
            metadata: { followUpAt: existing.followUpAt?.toISOString() ?? null },
          },
        });
      }

      return candidate;
    });

    if (data.status && data.status !== existing.status) {
      await logCandidateTimeline({
        candidateId: existing.id,
        userId: req.user?.userId || null,
        userName: req.user?.email,
        userRole: req.user?.role,
        action: 'Status Changed',
        previousStatus: existing.status,
        newStatus: data.status,
        remarks: `Candidate status updated from ${existing.status} to ${data.status} by ${req.user?.email || 'User'}`,
      });

      await prisma.candidateActivity.create({
        data: {
          candidateId: existing.id,
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
      entityId: existing.id,
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
    const allowedRoles = ['RECRUITER', 'FREELANCE_RECRUITER', 'TEAM_LEADER', 'ADMIN', 'SUPER_ADMIN'];
    if (!userId || !allowedRoles.includes(req.user?.role || '')) {
      sendError(res, 'Recruiter authentication is required.', 403);
      return;
    }

    const recruiter = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        recruiterId: true,
        recruiterType: true,
        teamLeaderId: true,
        isActive: true,
      },
    });

    if (!recruiter || !recruiter.isActive) {
      sendError(res, 'Recruiter account is inactive or unavailable.', 403);
      return;
    }

    const body = req.body || {};
    const fullName = String(body.fullName || body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const location = String(body.currentLocation || body.location || '').trim();
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

    const experienceYears = Number(body.experienceYears || body.totalExperience || 0);
    const relevantExperience = Number(body.relevantExperience || 0);
    const currentCtc = Number(body.currentSalary || body.currentCtc || 0);
    const expectedCtc = Number(body.expectedSalary || body.expectedCtc || 0);
    const noticePeriodDays = Number(body.noticePeriodDays || 0);
    const noticePeriod = body.noticePeriod ? String(body.noticePeriod) : (noticePeriodDays ? `${noticePeriodDays} Days` : null);

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
        sourcingRecruiterId: true,
        teamLeaderId: true,
        resumeUrl: true,
      },
    });

    if (
      existingCandidate?.ownerRecruiterId &&
      existingCandidate.ownerRecruiterId !== recruiter.id &&
      req.user?.role !== 'ADMIN' &&
      req.user?.role !== 'SUPER_ADMIN'
    ) {
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
        select: { id: true, stage: true, status: true },
      });

      if (existingApplication) {
        sendError(res, 'This candidate has already been submitted for the selected job.', 409);
        return;
      }
    }

    const uploaded = req.file ? await uploadResumeFile(req.file, fullName) : null;
    const teamLeaderId = recruiter.teamLeaderId || (req.user?.role === 'TEAM_LEADER' ? recruiter.id : null);

    const result = await prisma.$transaction(async (tx) => {
      let candidate;

      if (existingCandidate) {
        candidate = await tx.candidate.update({
          where: { id: existingCandidate.id },
          data: {
            name: fullName,
            fullName,
            currentLocation: location,
            location,
            education: body.highestQualification || (body.education ? String(body.education) : undefined),
            highestQualification: body.highestQualification || (body.education ? String(body.education) : undefined),
            totalExperience: experienceYears,
            relevantExperience,
            experienceYears: Number.isFinite(experienceYears) ? experienceYears : 0,
            currentCompany: body.currentCompany ? String(body.currentCompany) : undefined,
            currentDesignation: body.currentDesignation ? String(body.currentDesignation) : undefined,
            previousCompany: body.previousCompany ? String(body.previousCompany) : undefined,
            noticePeriod,
            noticePeriodDays: Number.isFinite(noticePeriodDays) ? noticePeriodDays : undefined,
            currentSalary: currentCtc,
            expectedSalary: expectedCtc,
            currentCtc: Number.isFinite(currentCtc) ? currentCtc : undefined,
            expectedCtc: Number.isFinite(expectedCtc) ? expectedCtc : undefined,
            skills,
            languages: languages.length ? languages : ['English', 'Hindi'],
            ...(uploaded ? { resumeUrl: uploaded.fileUrl } : {}),
            source: 'Recruiter Submission',
            tags: { push: 'Recruiter Submission' },
            notes: recruiterRemarks || undefined,
            feedback,
            dateOfJoin,
            status: 'Submitted',
            teamLeaderId: existingCandidate.teamLeaderId || teamLeaderId,
            ownerRecruiterId: recruiter.id,
            sourcingRecruiterId: existingCandidate.sourcingRecruiterId || recruiter.id,
            createdById: existingCandidate.ownerRecruiterId || recruiter.id,
          },
        });
      } else {
        // Auto-generated Candidate Code CND-XXXXXX
        const candidateCode = await generateCandidateCode(tx);

        candidate = await tx.candidate.create({
          data: {
            candidateCode,
            name: fullName,
            fullName,
            email,
            phone,
            currentLocation: location,
            location,
            education: body.highestQualification || (body.education ? String(body.education) : undefined),
            highestQualification: body.highestQualification || (body.education ? String(body.education) : undefined),
            totalExperience: experienceYears,
            relevantExperience,
            experienceYears: Number.isFinite(experienceYears) ? experienceYears : 0,
            currentCompany: body.currentCompany ? String(body.currentCompany) : undefined,
            currentDesignation: body.currentDesignation ? String(body.currentDesignation) : undefined,
            previousCompany: body.previousCompany ? String(body.previousCompany) : undefined,
            noticePeriod,
            noticePeriodDays: Number.isFinite(noticePeriodDays) ? noticePeriodDays : undefined,
            currentSalary: currentCtc,
            expectedSalary: expectedCtc,
            currentCtc: Number.isFinite(currentCtc) ? currentCtc : undefined,
            expectedCtc: Number.isFinite(expectedCtc) ? expectedCtc : undefined,
            skills,
            languages: languages.length ? languages : ['English', 'Hindi'],
            resumeUrl: uploaded?.fileUrl || '',
            source: 'Recruiter Submission',
            tags: ['Recruiter Submission'],
            notes: recruiterRemarks || undefined,
            feedback,
            dateOfJoin,
            status: 'Submitted',
            sourcingRecruiterId: recruiter.id,
            teamLeaderId,
            ownerRecruiterId: recruiter.id,
            createdById: recruiter.id,
          },
        });
      }

      // Auto-generated Application Code APP-XXXXXX
      const applicationCode = await generateApplicationCode(tx);

      const application = await tx.application.create({
        data: {
          applicationCode,
          candidateId: candidate.id,
          jobId,
          recruiterId: recruiter.id,
          teamLeaderId,
          status: 'Submitted',
          stage: 'APPLIED',
          reviewStatus: 'PENDING_TL_REVIEW',
          internalNotes: recruiterRemarks ? { recruiterRemarks } : undefined,
          timeline: [{ stage: 'Submitted', at: new Date().toISOString(), by: recruiter.id }],
        },
      });

      // 1.D Audit Timeline record
      await logCandidateTimeline({
        candidateId: candidate.id,
        applicationId: application.id,
        userId: recruiter.id,
        userName: recruiter.fullName,
        userRole: req.user?.role,
        action: 'Application Submitted',
        previousStatus: candidate.status,
        newStatus: 'Submitted',
        remarks: recruiterRemarks || `Candidate submitted for job ${job.title}`,
        client: tx,
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
            applicationCode: application.applicationCode,
            reviewStatus: 'PENDING_TL_REVIEW',
            ...(uploaded ? { fileUrl: uploaded.fileUrl } : {}),
          },
        },
      });

      return { candidate, application };
    });

    await createNotification({
      userId: recruiter.id,
      title: 'Candidate submitted successfully',
      message: `${result.candidate.fullName} has been submitted for ${job.title}. Awaiting Team Leader review.`,
      type: 'CANDIDATE_ADDED',
      link: '/recruiter/candidates',
    });

    if (teamLeaderId && teamLeaderId !== recruiter.id) {
      await createNotification({
        userId: teamLeaderId,
        title: 'New Candidate Pending Review',
        message: `${recruiter.fullName} submitted ${result.candidate.fullName} for ${job.title}.`,
        type: 'TL_REVIEW_REQUIRED',
        link: '/team-leader/pending-approvals',
      });
    }

    await logAudit({
      req,
      action: existingCandidate ? 'SUBMIT_EXISTING_CANDIDATE' : 'CREATE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: result.candidate.id,
      newValue: {
        candidateCode: result.candidate.candidateCode,
        applicationCode: result.application.applicationCode,
        recruiterId: recruiter.recruiterId,
        teamLeaderId,
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

