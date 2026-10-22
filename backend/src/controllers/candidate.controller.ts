import * as XLSX from 'xlsx';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';
import { createNotification } from '../services/notification.service';
import { uploadResumeFile } from '../services/storage.service';
import { generateCandidateCode, generateCandidateCodesBatch, generateApplicationCode } from '../utils/codeGenerators';
import { logCandidateTimeline } from '../services/timeline.service';
import { sendDynamicEmail } from '../services/email.service';
import { formatCandidateGreetingName, formatCandidateGreeting } from '../utils/nameFormatter';
import { formatWalkInDate } from '../utils/dateFormatter';

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

export const normalizeCandidateStatus = (status?: string | null): string => {
  if (!status) return 'New';
  const trimmed = status.trim();
  const mapping: Record<string, string> = {
    NEW: 'New',
    SCREENING: 'Screening',
    SHORTLISTED: 'Shortlisted',
    INTERVIEW: 'Interview Scheduled',
    SELECTED: 'Selected',
    REJECTED: 'Rejected',
    ON_HOLD: 'On Hold',
    JOINED: 'Joined',
    DROPPED: 'Not Interested',
    new: 'New',
    screening: 'Screening',
    shortlisted: 'Shortlisted',
    interview: 'Interview Scheduled',
    'interview scheduled': 'Interview Scheduled',
    'interview completed': 'Interview Completed',
    selected: 'Selected',
    rejected: 'Rejected',
    'on hold': 'On Hold',
    joined: 'Joined',
    'not interested': 'Not Interested',
    'no response': 'No Response',
    'not eligible': 'Not Eligible',
    withdrawn: 'Withdrawn',
    duplicate: 'Duplicate',
    contacted: 'Contacted',
    interested: 'Interested',
    eligible: 'Eligible',
    submitted: 'Submitted',
    assessment: 'Assessment',
    'joining pending': 'Joining Pending',
  };

  const lookup = mapping[trimmed] || mapping[trimmed.toUpperCase()] || mapping[trimmed.toLowerCase()];
  return lookup || trimmed;
};

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

const walkInStatuses = ['EXPECTED', 'CONFIRMED', 'ARRIVED', 'ATTENDED', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED', 'COMPLETED'] as const;
const walkInResponses = ['COMING_TODAY', 'COMING_TOMORROW', 'SPECIFIC_DATE', 'NOT_COMING', 'NOT_SURE', 'NOT_INTERESTED', 'NO_RESPONSE'] as const;

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
            { ownerRecruiter: { teamLeaderId: user.userId } },
            { sourcingRecruiterId: user.userId },
            { ownerRecruiterId: user.userId },
            { applications: { some: { OR: [{ teamLeaderId: user.userId }, { recruiter: { teamLeaderId: user.userId } }] } } },
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
      walkInOnly,
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

    if (String(walkInOnly).toLowerCase() === 'true') {
      andFilters.push({ walkInStatus: { not: null } });
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
          status: normalizeCandidateStatus(data.status),
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
      include: {
        applications: {
          include: { job: { select: { title: true } } },
          orderBy: { appliedDate: 'desc' },
          take: 1,
        },
      },
    });
    if (!existing) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (recruiterId) {
      const recruiter = await prisma.user.findFirst({
        where: { id: recruiterId, role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] }, isActive: true },
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

      if (recruiterId) {
        const candidateName = existing.fullName || existing.name || 'Candidate';
        const jobTitle = existing.applications?.[0]?.job?.title || existing.currentDesignation || 'Job Opening';
        await tx.notification.create({
          data: {
            userId: recruiterId,
            title: 'Candidate Assigned',
            message: `A new candidate has been assigned to you. ${candidateName} - ${jobTitle}`,
            type: 'CANDIDATE_ASSIGNED',
            link: `/candidates/${existing.id}`,
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

    const statusByAction: Record<string, string> = {
      SELECTED: 'Selected',
      JOINED: 'Joined',
      REJECTED: 'Rejected',
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

    const nextStatus = data.status !== undefined ? normalizeCandidateStatus(data.status) : undefined;
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
          status: nextStatus ?? undefined,
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
            action: (() => {
            const st = String(data.walkInStatus || '').toUpperCase();
            if (st === 'ARRIVED' || st === 'ATTENDED' || st === 'COMPLETED') return 'WALK_IN_ATTENDED';
            if (st === 'NO_SHOW') return 'WALK_IN_NO_SHOW';
            if (st === 'CANCELLED') return 'WALK_IN_CANCELLED';
            if (st === 'EXPECTED' || st === 'CONFIRMED') return 'WALK_IN_SCHEDULED';
            return 'WALK_IN_UPDATED';
          })(),
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

      if (nextStatus && nextStatus !== existing.status) {
        await logCandidateTimeline({
          candidateId: existing.id,
          userId: req.user?.userId || null,
          userName: req.user?.email,
          userRole: req.user?.role,
          action: 'Status Changed',
          previousStatus: existing.status,
          newStatus: nextStatus,
          remarks: `Candidate status updated from ${existing.status} to ${nextStatus} by ${req.user?.email || 'User'}`,
          client: tx,
        });

        await tx.candidateActivity.create({
          data: {
            candidateId: existing.id,
            userId: req.user?.userId || null,
            recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
            action: nextStatus === 'Selected' ? 'SELECTED' : nextStatus === 'Joined' ? 'JOINED' : nextStatus === 'Rejected' ? 'REJECTED' : 'STATUS_UPDATED',
            metadata: { oldStatus: existing.status, newStatus: nextStatus },
          },
        });
      }

      return candidate;
    });

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

/**
 * GET Candidate Timeline / Status History: GET /api/candidates/:id/timeline
 * Returns auditable chronological history of status changes and workflow transitions.
 */
export const getCandidateTimeline = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
      select: { id: true, candidateCode: true, fullName: true, status: true },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const timelines = await prisma.candidateTimeline.findMany({
      where: { candidateId: candidate.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    sendSuccess(res, {
      candidateId: candidate.id,
      candidateCode: candidate.candidateCode,
      currentStatus: candidate.status,
      timelines,
      history: timelines,
      total: timelines.length,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Dedicated Candidate Status Update: PATCH /api/candidates/:id/status
 */
export const updateCandidateStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const { status, remarks } = req.body;

    if (!status || typeof status !== 'string') {
      sendError(res, 'A valid candidate status string is required.', 400);
      return;
    }

    req.body = { status, notes: remarks };
    return updateCandidate(req, res, next);
  } catch (err) {
    next(err);
  }
};



/**
 * Manual Resend of Walk-in Confirmation Email: POST /api/v1/candidates/:id/resend-walk-in-email
 * Re-dispatches personalized walk-in email with secure confirmation link.
 * Handles 404 for missing candidate, 400 for missing walk-in session or invalid email,
 * 502 for email-provider failures, and enforces idempotency cooldown.
 */
export const resendWalkInEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;

    if (!identifier || (identifier.length > 36 && !/^[0-9a-fA-F-]+$/.test(identifier))) {
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
        applications: {
          include: {
            job: {
              include: { client: true },
            },
          },
          orderBy: { appliedDate: 'desc' },
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    // Email validation
    if (!candidate.email || !candidate.email.trim() || !candidate.email.includes('@')) {
      sendError(res, 'Candidate does not have a valid email address configured.', 400);
      return;
    }

    // Match exact application based on body jobId/applicationId or candidate targetJobId
    let application: any = null;
    if (req.body?.applicationId && candidate.applications.length > 0) {
      application = candidate.applications.find((app) => app.id === req.body.applicationId);
    }
    if (!application && req.body?.jobId && candidate.applications.length > 0) {
      const targetJobId = String(req.body.jobId);
      application = candidate.applications.find(
        (app) => app.jobId === targetJobId || app.job?.id === targetJobId || app.job?.jobCode === targetJobId
      );
    }
    if (!application && (candidate as any).targetJobId && candidate.applications.length > 0) {
      application = candidate.applications.find(
        (app) => app.jobId === (candidate as any).targetJobId || app.job?.id === (candidate as any).targetJobId
      );
    }
    if (!application) {
      application = candidate.applications?.[0] || null;
    }

    const job = application?.job;

    // Verify candidate alignment with target job if specified
    if (req.body?.jobId && job) {
      const targetJobId = String(req.body.jobId);
      const isAligned = candidate.applications.some(
        (app) => app.jobId === targetJobId || app.job?.id === targetJobId || app.job?.jobCode === targetJobId
      );
      if (!isAligned && candidate.applications.length > 0) {
        sendError(res, 'Candidate is not aligned with the specified walk-in job opening.', 400);
        return;
      }
    }

    // Resolve saved session details from body or job.hiringProcess.walkInSession
    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};

    // Walk-in session validation
    const rawDate = req.body?.walkInDate || candidate.walkInDate || savedSession.date || savedSession.interviewDate;
    const dateInfo = formatWalkInDate(rawDate);
    if (!dateInfo.dateStr) {
      sendError(res, 'Candidate does not have an active walk-in session or scheduled date. The Admin must save session details before sending invitations.', 400);
      return;
    }

    const reportingTimeStr = (req.body?.reportingTime || candidate.walkInTime || savedSession.reportingTime || '').trim();
    const venueNameStr = (req.body?.venueName || savedSession.venueName || '').trim();
    const venueAddressStr = (req.body?.venueAddress || savedSession.venueAddress || '').trim();
    let googleMapsLinkStr = (req.body?.googleMapsLink || savedSession.googleMapsLink || '').trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }

    const instructionsStr = (req.body?.instructions || savedSession.instructions || '').trim();

    // Enforce required walk-in session details
    if (!reportingTimeStr || !venueNameStr || !venueAddressStr) {
      sendError(res, 'Walk-in session details are incomplete. The Admin must save session details (venue name, complete address, and reporting time) before sending invitations.', 400);
      return;
    }

    // Enforce valid Google Maps link
    if (!googleMapsLinkStr || (!googleMapsLinkStr.startsWith('http://') && !googleMapsLinkStr.startsWith('https://'))) {
      sendError(res, 'A valid Google Maps destination URL is required for the walk-in session directions.', 400);
      return;
    }

    // Idempotency: Prevent accidental duplicate emails within 15 seconds
    const recentActivity = await prisma.candidateActivity.findFirst({
      where: {
        candidateId: candidate.id,
        action: 'WALK_IN_EMAIL_RESENT',
        createdAt: { gte: new Date(Date.now() - 15 * 1000) },
      },
    });

    if (recentActivity) {
      sendSuccess(res, {
        candidateId: candidate.id,
        candidateName: candidate.fullName,
        recipient: candidate.email,
        dispatched: true,
        cooldown: true,
        message: 'Walk-in confirmation email was recently dispatched to ' + candidate.email + '. (Cooldown active)',
      });
      return;
    }

    const jobTitle = req.body?.jobTitle || job?.title || 'Walk-in Interview Candidate';
    const clientName = req.body?.clientName || job?.client?.companyName || 'Orrica Edge Partner';
    const walkInDateStr = dateInfo.dateStr;
    const greetingName = formatCandidateGreetingName(candidate);

    // Encode structured token containing exact candidate, job, application, and session signature
    const tokenPayload = {
      c: candidate.id,
      j: job?.id,
      a: application?.id,
      s: savedSession.id || req.body?.sessionId,
    };
    const token = 'wic_' + Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');

    const frontendBase = (process.env.FRONTEND_URL || 'https://orricaedge.com').replace(/\/+$/, '');
    const confirmationUrl = frontendBase + '/walk-in/confirm/' + encodeURIComponent(token);
    const confirmUrl = confirmationUrl + '?action=confirm';
    const rescheduleUrl = confirmationUrl + '?action=reschedule';
    const notInterestedUrl = confirmationUrl + '?action=not_interested';

    const variables: Record<string, string> = {
      candidate_name: greetingName,
      candidate_greeting: formatCandidateGreeting(candidate),
      candidate_email: candidate.email,
      job_title: jobTitle,
      client_name: clientName,
      walk_in_date: walkInDateStr,
      walkin_date: walkInDateStr,
      walk_in_date_formatted: dateInfo.displayDate,
      interview_date: dateInfo.displayDate,
      reporting_time: reportingTimeStr,
      walk_in_time: reportingTimeStr,
      venue_name: venueNameStr,
      venue_address: venueAddressStr,
      google_maps_link: googleMapsLinkStr,
      instructions: instructionsStr,
      candidate_instructions: instructionsStr,
      confirmation_url: confirmationUrl,
      confirmation_link: confirmationUrl,
      confirm_url: confirmUrl,
      reschedule_url: rescheduleUrl,
      not_interested_url: notInterestedUrl,
    };

    let dispatchResult: { success: boolean; messageId?: string };
    try {
      dispatchResult = await sendDynamicEmail({
        templateKey: 'WALK_IN_INVITATION',
        recipient: candidate.email,
        variables,
      });
    } catch (providerErr: any) {
      console.error('[WALK-IN RESEND EMAIL FAILED] Candidate ' + candidate.id + ':', providerErr);
      sendError(res, 'Email provider failed to dispatch confirmation email: ' + (providerErr.message || 'Provider transmission error'), 502);
      return;
    }

    const recruiterId = req.user?.role === 'RECRUITER' ? req.user.userId : null;
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        userId: req.user?.userId || null,
        recruiterId,
        action: 'WALK_IN_EMAIL_RESENT',
        notes: 'Walk-in confirmation email dispatched to ' + candidate.email + ' for ' + jobTitle + ' (' + walkInDateStr + ').',
        metadata: {
          recipient: candidate.email,
          jobId: job?.id,
          applicationId: application?.id,
          sessionId: savedSession.id || req.body?.sessionId,
          walkInDate: walkInDateStr,
          reportingTime: reportingTimeStr,
          venueName: venueNameStr,
          venueAddress: venueAddressStr,
          googleMapsLink: googleMapsLinkStr,
          messageId: dispatchResult.messageId,
          token,
        },
      },
    });

    await logCandidateTimeline({
      candidateId: candidate.id,
      userId: req.user?.userId || null,
      userName: req.user?.email || 'Recruiter',
      userRole: req.user?.role || 'ADMIN',
      action: 'Walk-in Confirmation Email Resent',
      newStatus: candidate.status,
      remarks: 'Walk-in confirmation email re-dispatched to ' + candidate.email + ' for ' + jobTitle + ' (' + walkInDateStr + ').',
    });

    sendSuccess(res, {
      candidateId: candidate.id,
      candidateName: candidate.fullName,
      recipient: candidate.email,
      dispatched: true,
      messageId: dispatchResult.messageId,
      walkInDate: walkInDateStr,
      reportingTime: reportingTimeStr,
      venueName: venueNameStr,
      venueAddress: venueAddressStr,
      message: 'Walk-in confirmation email sent successfully to ' + candidate.email + '.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Dispatch Initial Walk-in Invitation: POST /api/v1/candidates/:id/send-walk-in-invitation
 */
export const sendWalkInInvitation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
        ],
      },
      include: {
        applications: {
          include: {
            job: {
              include: { client: true },
            },
          },
          orderBy: { appliedDate: 'desc' },
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (!candidate.email || !candidate.email.trim() || !candidate.email.includes('@')) {
      sendError(res, 'Candidate does not have a valid email address configured.', 400);
      return;
    }

    // Match exact application based on body jobId/applicationId or candidate targetJobId
    let application: any = null;
    if (req.body?.applicationId && candidate.applications.length > 0) {
      application = candidate.applications.find((app) => app.id === req.body.applicationId);
    }
    if (!application && req.body?.jobId && candidate.applications.length > 0) {
      const targetJobId = String(req.body.jobId);
      application = candidate.applications.find(
        (app) => app.jobId === targetJobId || app.job?.id === targetJobId || app.job?.jobCode === targetJobId
      );
    }
    if (!application && (candidate as any).targetJobId && candidate.applications.length > 0) {
      application = candidate.applications.find(
        (app) => app.jobId === (candidate as any).targetJobId || app.job?.id === (candidate as any).targetJobId
      );
    }
    if (!application) {
      application = candidate.applications?.[0] || null;
    }

    const job = application?.job;

    // Verify candidate alignment with target job if specified
    if (req.body?.jobId && job) {
      const targetJobId = String(req.body.jobId);
      const isAligned = candidate.applications.some(
        (app) => app.jobId === targetJobId || app.job?.id === targetJobId || app.job?.jobCode === targetJobId
      );
      if (!isAligned && candidate.applications.length > 0) {
        sendError(res, 'Candidate is not aligned with the specified walk-in job opening.', 400);
        return;
      }
    }

    // Resolve saved session details from body or job.hiringProcess.walkInSession
    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};

    const rawDate = req.body?.walkInDate || candidate.walkInDate || savedSession.date || savedSession.interviewDate;
    const dateInfo = formatWalkInDate(rawDate);
    if (!dateInfo.dateStr) {
      sendError(res, 'Candidate does not have an active walk-in session or scheduled date. The Admin must save session details before sending invitations.', 400);
      return;
    }

    const reportingTime = (req.body?.reportingTime || req.body?.walkInTime || candidate.walkInTime || savedSession.reportingTime || '').trim();
    const venueNameStr = (req.body?.venueName || savedSession.venueName || '').trim();
    const venueAddressStr = (req.body?.venueAddress || savedSession.venueAddress || '').trim();
    let googleMapsLinkStr = (req.body?.googleMapsLink || savedSession.googleMapsLink || '').trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }

    const instructionsStr = (req.body?.instructions || savedSession.instructions || '').trim();

    // Enforce required walk-in session details
    if (!reportingTime || !venueNameStr || !venueAddressStr) {
      sendError(res, 'Walk-in session details are incomplete. The Admin must save session details (venue name, complete address, and reporting time) before sending invitations.', 400);
      return;
    }

    // Enforce valid Google Maps link
    if (!googleMapsLinkStr || (!googleMapsLinkStr.startsWith('http://') && !googleMapsLinkStr.startsWith('https://'))) {
      sendError(res, 'A valid Google Maps destination URL is required for walk-in interview directions.', 400);
      return;
    }

    // Persist walk-in schedule if updated
    const targetWalkInDate = new Date(dateInfo.dateStr + 'T12:00:00Z');
    const updatedCandidate = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        walkInDate: targetWalkInDate,
        walkInTime: reportingTime,
        walkInStatus: candidate.walkInStatus || 'EXPECTED',
      },
    });

    const jobTitle = req.body?.jobTitle || job?.title || 'Walk-in Interview Candidate';
    const clientName = req.body?.clientName || job?.client?.companyName || 'Orrica Edge Partner';
    const walkInDateStr = dateInfo.dateStr;
    const greetingName = formatCandidateGreetingName(candidate);

    // Encode structured token containing exact candidate, job, application, and session signature
    const tokenPayload = {
      c: candidate.id,
      j: job?.id,
      a: application?.id,
      s: savedSession.id || req.body?.sessionId,
    };
    const token = 'wic_' + Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');

    const frontendBase = (process.env.FRONTEND_URL || 'https://orricaedge.com').replace(/\/+$/, '');
    const confirmationUrl = frontendBase + '/walk-in/confirm/' + encodeURIComponent(token);
    const confirmUrl = confirmationUrl + '?action=confirm';
    const rescheduleUrl = confirmationUrl + '?action=reschedule';
    const notInterestedUrl = confirmationUrl + '?action=not_interested';

    const variables: Record<string, string> = {
      candidate_name: greetingName,
      candidate_greeting: formatCandidateGreeting(candidate),
      candidate_email: candidate.email,
      job_title: jobTitle,
      client_name: clientName,
      walk_in_date: walkInDateStr,
      walkin_date: walkInDateStr,
      walk_in_date_formatted: dateInfo.displayDate,
      interview_date: dateInfo.displayDate,
      reporting_time: reportingTime,
      walk_in_time: reportingTime,
      venue_name: venueNameStr,
      venue_address: venueAddressStr,
      google_maps_link: googleMapsLinkStr,
      instructions: instructionsStr,
      candidate_instructions: instructionsStr,
      confirmation_url: confirmationUrl,
      confirmation_link: confirmationUrl,
      confirm_url: confirmUrl,
      reschedule_url: rescheduleUrl,
      not_interested_url: notInterestedUrl,
    };

    let dispatchResult: { success: boolean; messageId?: string };
    try {
      dispatchResult = await sendDynamicEmail({
        templateKey: 'WALK_IN_INVITATION',
        recipient: candidate.email,
        variables,
      });
    } catch (providerErr: any) {
      console.error('[WALK-IN INVITATION EMAIL FAILED] Candidate ' + candidate.id + ':', providerErr);
      sendError(res, 'Email provider failed to dispatch invitation email: ' + (providerErr.message || 'Provider transmission error'), 502);
      return;
    }

    const recruiterId = req.user?.role === 'RECRUITER' ? req.user.userId : null;
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        userId: req.user?.userId || null,
        recruiterId,
        action: 'WALK_IN_INVITATION_SENT',
        notes: 'Walk-in invitation sent to ' + candidate.email + ' for ' + jobTitle + ' (' + walkInDateStr + ').',
        metadata: {
          recipient: candidate.email,
          jobId: job?.id,
          applicationId: application?.id,
          sessionId: savedSession.id || req.body?.sessionId,
          walkInDate: walkInDateStr,
          reportingTime,
          venueName: venueNameStr,
          venueAddress: venueAddressStr,
          googleMapsLink: googleMapsLinkStr,
          messageId: dispatchResult.messageId,
          token,
        },
      },
    });

    await logCandidateTimeline({
      candidateId: candidate.id,
      userId: req.user?.userId || null,
      userName: req.user?.email || 'Recruiter',
      userRole: req.user?.role || 'ADMIN',
      action: 'Walk-in Invitation Sent',
      newStatus: updatedCandidate.status,
      remarks: 'Walk-in invitation dispatched to ' + candidate.email + ' for ' + jobTitle + ' (' + walkInDateStr + ').',
    });

    sendSuccess(res, {
      candidateId: candidate.id,
      candidateName: candidate.fullName,
      recipient: candidate.email,
      dispatched: true,
      messageId: dispatchResult.messageId,
      walkInDate: walkInDateStr,
      reportingTime,
      venueName: venueNameStr,
      venueAddress: venueAddressStr,
      message: 'Walk-in invitation sent successfully to ' + candidate.email + '.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Approve Walk-in Reschedule Request: POST /api/v1/candidates/:id/approve-walk-in-reschedule
 */
export const approveWalkInReschedule = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const { approvedDate, approvedTime } = req.body;

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
        ],
      },
      include: {
        applications: {
          include: {
            job: {
              include: { client: true },
            },
          },
          orderBy: { appliedDate: 'desc' },
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const rawDate = approvedDate || candidate.walkInDate || new Date();
    const dateInfo = formatWalkInDate(rawDate);
    const newWalkInDate = new Date(dateInfo.dateStr + 'T12:00:00Z');
    const newWalkInTime = approvedTime || candidate.walkInTime || '10:00 AM';

    const updated = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        walkInDate: newWalkInDate,
        walkInTime: newWalkInTime,
        walkInStatus: 'CONFIRMED',
        walkInResponse: 'COMING_TODAY',
      },
    });

    const application = candidate.applications?.[0];
    const job = application?.job;
    const jobTitle = job?.title || 'Walk-in Interview Candidate';
    const dateStr = dateInfo.dateStr;
    const greetingName = formatCandidateGreetingName(candidate);

    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};
    const venueNameStr = (savedSession.venueName || '').trim();
    const venueAddressStr = (savedSession.venueAddress || '').trim();

    if (candidate.email && candidate.email.includes('@')) {
      try {
        await sendDynamicEmail({
          templateKey: 'WALK_IN_RESCHEDULE_APPROVED',
          recipient: candidate.email,
          variables: {
            candidate_name: greetingName,
            candidate_greeting: formatCandidateGreeting(candidate),
            candidate_email: candidate.email,
            job_title: jobTitle,
            walk_in_date: dateStr,
            walkin_date: dateStr,
            walk_in_date_formatted: dateInfo.displayDate,
            reporting_time: newWalkInTime,
            venue_name: venueNameStr,
            venue_address: venueAddressStr,
          },
        });
      } catch (emailErr: any) {
        console.warn('[RESCHEDULE APPROVAL EMAIL WARNING]:', emailErr.message);
      }
    }

    const recruiterId = req.user?.role === 'RECRUITER' ? req.user.userId : null;
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        userId: req.user?.userId || null,
        recruiterId,
        action: 'WALK_IN_RESCHEDULE_APPROVED',
        notes: 'Walk-in reschedule request approved for ' + dateStr + ' at ' + newWalkInTime + '.',
        metadata: {
          approvedDate: dateStr,
          approvedTime: newWalkInTime,
        },
      },
    });

    await logCandidateTimeline({
      candidateId: candidate.id,
      userId: req.user?.userId || null,
      userName: req.user?.email || 'Recruiter',
      userRole: req.user?.role || 'ADMIN',
      action: 'Walk-in Reschedule Approved',
      newStatus: updated.status,
      remarks: 'Walk-in reschedule approved for ' + dateStr + ' at ' + newWalkInTime + '.',
    });

    sendSuccess(res, {
      candidate: updated,
      message: 'Reschedule approved for ' + dateStr + '.',
    });
  } catch (err) {
    next(err);
  }
};

/* ==========================================================================
   BULK CANDIDATE IMPORT CONTROLLERS
   ========================================================================== */

/**
 * Clean and sanitize string against CSV/Formula injection
 */
const sanitizeCellValue = (val: any): string => {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  if (str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@')) {
    str = "'" + str;
  }
  return str;
};

/**
 * Normalizes 10-digit Indian phone number
 */
const normalizePhoneNumber = (raw: any): { phone: string; isValid: boolean } => {
  if (!raw) return { phone: '', isValid: false };
  let cleaned = String(raw).replace(/\D/g, '');
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1);
  }
  const isValid = /^[6-9]\d{9}$/.test(cleaned);
  return { phone: cleaned, isValid };
};

/**
 * Download standard Excel import template
 * GET /api/v1/candidates/template/download
 */
export const downloadCandidateImportTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const headers = [
      'Full Name',
      'Phone',
      'Email',
      'Father Name',
      'Date of Birth (YYYY-MM-DD)',
      'Gender (Male/Female/Other)',
      'Current Location',
      'Preferred Location',
      'Total Experience (Years)',
      'Relevant Experience (Years)',
      'Highest Qualification',
      'Education',
      'Current Company',
      'Current Designation',
      'Previous Company',
      'Notice Period',
      'Notice Period Days',
      'Current Monthly Salary',
      'Expected Monthly Salary',
      'Current CTC',
      'Expected CTC',
      'Skills (comma-separated)',
      'Languages (comma-separated)',
      'Resume URL',
      'Source',
      'Tags (comma-separated)',
      'Notes'
    ];

    const sampleRow = [
      'Aarav Sharma',
      '9876543210',
      'aarav.sharma@example.com',
      'Rajesh Sharma',
      '1996-05-15',
      'Male',
      'Bengaluru, Karnataka',
      'Bengaluru, Hyderabad',
      '3.5',
      '3.0',
      'B.Tech in Computer Science',
      'B.Tech',
      'Infosys Ltd',
      'Software Engineer',
      'TCS',
      '30 Days',
      '30',
      '65000',
      '85000',
      '780000',
      '1020000',
      'React, TypeScript, Node.js',
      'English, Hindi',
      'https://example.com/resumes/aarav.pdf',
      'Excel Bulk Import',
      'Frontend, Verified',
      'Immediate joiner with hands-on enterprise experience.'
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow]);
    
    // Set column widths for comfortable reading
    ws['!cols'] = headers.map(() => ({ wch: 22 }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Candidate Import Template');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Orrica_Edge_Candidate_Import_Template.xlsx"');
    res.setHeader('Content-Length', buffer.length.toString());
    res.end(buffer);
  } catch (err) {
    next(err);
  }
};

/**
 * Bulk Candidate Import from Excel/CSV
 * POST /api/v1/candidates/bulk-import
 */
export const bulkImportCandidates = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const file = req.file;
    if (!file || !file.buffer) {
      sendError(res, 'Spreadsheet file is required. Upload a valid .xlsx, .xls, or .csv file.', 400);
      return;
    }

    const isDryRun = req.body?.dryRun === true || req.body?.dryRun === 'true' || req.query?.dryRun === 'true';
    const defaultSource = sanitizeCellValue(req.body?.source || 'Bulk Excel Import');
    const assignedRecruiterId = req.body?.assignedRecruiterId ? String(req.body.assignedRecruiterId).trim() : null;
    const currentUserId = (req.user as any)?.id || null;

    // 1. Parse spreadsheet safely (disable formula execution)
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, {
        type: 'buffer',
        cellFormula: false,
        cellHTML: false,
        cellText: true,
      });
    } catch (parseErr: any) {
      sendError(res, `Failed to parse spreadsheet: ${parseErr?.message || 'Invalid or corrupted file.'}`, 400);
      return;
    }

    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      sendError(res, 'Uploaded spreadsheet contains no worksheets.', 400);
      return;
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet, {
      defval: '',
      raw: false,
    });

    if (!rawRows || rawRows.length === 0) {
      sendError(res, 'Uploaded spreadsheet contains no data rows.', 400);
      return;
    }

    const MAX_ROW_LIMIT = 5000;
    if (rawRows.length > MAX_ROW_LIMIT) {
      sendError(res, `Spreadsheet exceeds maximum allowed limit of ${MAX_ROW_LIMIT} rows per import batch.`, 400);
      return;
    }

    // 2. Normalization map for headers
    const normalizeKey = (key: string): string => {
      const lower = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (['fullname', 'name', 'candidatename'].includes(lower)) return 'fullName';
      if (['phone', 'mobile', 'phonenumber', 'contact', 'mobilenumber', 'contactnumber'].includes(lower)) return 'phone';
      if (['email', 'emailaddress', 'emailid'].includes(lower)) return 'email';
      if (['fathername', 'fathersname'].includes(lower)) return 'fatherName';
      if (['dateofbirth', 'dob', 'birthdate'].includes(lower)) return 'dateOfBirth';
      if (['gender', 'sex'].includes(lower)) return 'gender';
      if (['currentlocation', 'location', 'city', 'address', 'fulladdress'].includes(lower)) return 'location';
      if (['preferredlocation', 'preferredcity'].includes(lower)) return 'preferredLocation';
      if (['totalexperience', 'experience', 'exp', 'totalexp', 'experienceyears'].includes(lower)) return 'totalExperience';
      if (['relevantexperience', 'relexp'].includes(lower)) return 'relevantExperience';
      if (['highestqualification', 'qualification', 'degree', 'highestdegree'].includes(lower)) return 'highestQualification';
      if (['education', 'academics'].includes(lower)) return 'education';
      if (['currentcompany', 'company', 'employer'].includes(lower)) return 'currentCompany';
      if (['currentdesignation', 'designation', 'role', 'jobtitle', 'currentrole'].includes(lower)) return 'currentDesignation';
      if (['previouscompany', 'pastcompany'].includes(lower)) return 'previousCompany';
      if (['noticeperiod', 'notice'].includes(lower)) return 'noticePeriod';
      if (['noticeperioddays', 'noticedays'].includes(lower)) return 'noticePeriodDays';
      if (['currentsalary', 'currentmonthlysalary', 'salary'].includes(lower)) return 'currentSalary';
      if (['expectedsalary', 'expectedmonthlysalary'].includes(lower)) return 'expectedSalary';
      if (['currentctc'].includes(lower)) return 'currentCtc';
      if (['expectedctc'].includes(lower)) return 'expectedCtc';
      if (['skills', 'skillset', 'keyskills'].includes(lower)) return 'skills';
      if (['languages', 'languagesknown'].includes(lower)) return 'languages';
      if (['resumeurl', 'resumelink', 'cvlink'].includes(lower)) return 'resumeUrl';
      if (['source', 'sourcingchannel'].includes(lower)) return 'source';
      if (['tags', 'tag'].includes(lower)) return 'tags';
      if (['notes', 'remarks', 'feedback', 'comments'].includes(lower)) return 'notes';
      return lower;
    };

    // 3. First pass: Parse & Validate fields, detect duplicate phones/emails inside sheet
    type ProcessedRow = {
      rowNumber: number;
      data: any;
      isValid: boolean;
      isDuplicateInSheet: boolean;
      errors: string[];
    };

    const processedRows: ProcessedRow[] = [];
    const seenPhonesInSheet = new Map<string, number>();
    const seenEmailsInSheet = new Map<string, number>();

    const candidatePhonesForDbCheck = new Set<string>();
    const candidateEmailsForDbCheck = new Set<string>();

    for (let index = 0; index < rawRows.length; index++) {
      const raw = rawRows[index];
      const rowNumber = index + 2; // +1 for 0-index, +1 for header row
      const errors: string[] = [];

      // Extract normalized fields
      const rowNormalized: Record<string, any> = {};
      for (const [key, val] of Object.entries(raw)) {
        const canonicalKey = normalizeKey(key);
        rowNormalized[canonicalKey] = sanitizeCellValue(val);
      }

      const fullName = rowNormalized.fullName || '';
      const rawPhone = rowNormalized.phone || '';
      const rawEmail = (rowNormalized.email || '').toLowerCase().trim();

      if (!fullName) {
        errors.push('Full Name is required.');
      }

      const { phone: normalizedPhone, isValid: isPhoneValid } = normalizePhoneNumber(rawPhone);
      if (!isPhoneValid) {
        errors.push(`Invalid phone number '${rawPhone}'. Must be a valid 10-digit Indian mobile number.`);
      }

      const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
      if (!rawEmail || !emailRegex.test(rawEmail)) {
        errors.push(`Invalid or missing email address '${rawEmail}'.`);
      }

      // Check within-sheet duplicates
      let isDuplicateInSheet = false;
      if (isPhoneValid) {
        if (seenPhonesInSheet.has(normalizedPhone)) {
          isDuplicateInSheet = true;
          errors.push(`Duplicate phone number in spreadsheet. Already appeared in Row ${seenPhonesInSheet.get(normalizedPhone)}.`);
        } else {
          seenPhonesInSheet.set(normalizedPhone, rowNumber);
          candidatePhonesForDbCheck.add(normalizedPhone);
        }
      }

      if (rawEmail && emailRegex.test(rawEmail)) {
        if (seenEmailsInSheet.has(rawEmail)) {
          isDuplicateInSheet = true;
          errors.push(`Duplicate email address in spreadsheet. Already appeared in Row ${seenEmailsInSheet.get(rawEmail)}.`);
        } else {
          seenEmailsInSheet.set(rawEmail, rowNumber);
          candidateEmailsForDbCheck.add(rawEmail);
        }
      }

      // Parse experience and numbers safely
      const parseDecimal = (val: any, fallback = 0) => {
        if (!val) return fallback;
        const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
        return isNaN(num) ? fallback : Math.max(0, num);
      };

      const totalExp = parseDecimal(rowNormalized.totalExperience, 0);
      const relExp = parseDecimal(rowNormalized.relevantExperience, 0);
      const currSal = rowNormalized.currentSalary ? parseDecimal(rowNormalized.currentSalary) : null;
      const expSal = rowNormalized.expectedSalary ? parseDecimal(rowNormalized.expectedSalary) : null;
      const currCtc = rowNormalized.currentCtc ? parseDecimal(rowNormalized.currentCtc) : (currSal ? currSal * 12 : null);
      const expCtc = rowNormalized.expectedCtc ? parseDecimal(rowNormalized.expectedCtc) : (expSal ? expSal * 12 : null);

      // Gender normalization
      let genderVal: 'MALE' | 'FEMALE' | 'OTHER' | null = null;
      const rawGender = String(rowNormalized.gender || '').toUpperCase();
      if (['MALE', 'M'].includes(rawGender)) genderVal = 'MALE';
      else if (['FEMALE', 'F'].includes(rawGender)) genderVal = 'FEMALE';
      else if (['OTHER', 'O'].includes(rawGender)) genderVal = 'OTHER';

      // Parse arrays (comma-separated)
      const parseArray = (str: string) => {
        if (!str) return [];
        return str.split(',').map((s) => s.trim()).filter(Boolean);
      };

      const skillsArr = parseArray(rowNormalized.skills);
      const languagesArr = parseArray(rowNormalized.languages);
      const tagsArr = parseArray(rowNormalized.tags);

      // Date of birth
      let dobDate: Date | null = null;
      if (rowNormalized.dateOfBirth) {
        const parsedDob = new Date(rowNormalized.dateOfBirth);
        if (!isNaN(parsedDob.getTime())) {
          dobDate = parsedDob;
        }
      }

      const candidateData = {
        fullName,
        name: fullName,
        phone: normalizedPhone,
        email: rawEmail,
        fatherName: rowNormalized.fatherName || null,
        dateOfBirth: dobDate,
        gender: genderVal,
        currentLocation: rowNormalized.location || '',
        location: rowNormalized.location || '',
        preferredLocation: rowNormalized.preferredLocation || null,
        totalExperience: totalExp,
        relevantExperience: relExp,
        experienceYears: totalExp,
        highestQualification: rowNormalized.highestQualification || rowNormalized.education || null,
        education: rowNormalized.education || rowNormalized.highestQualification || null,
        currentCompany: rowNormalized.currentCompany || null,
        currentDesignation: rowNormalized.currentDesignation || null,
        previousCompany: rowNormalized.previousCompany || null,
        noticePeriod: rowNormalized.noticePeriod || (rowNormalized.noticePeriodDays ? `${rowNormalized.noticePeriodDays} Days` : null),
        noticePeriodDays: rowNormalized.noticePeriodDays ? parseInt(rowNormalized.noticePeriodDays, 10) || null : null,
        currentSalary: currSal,
        expectedSalary: expSal,
        currentCtc: currCtc,
        expectedCtc: expCtc,
        skills: skillsArr.length > 0 ? skillsArr : [],
        languages: languagesArr.length > 0 ? languagesArr : ['English', 'Hindi'],
        resumeUrl: rowNormalized.resumeUrl || '',
        source: rowNormalized.source || defaultSource,
        tags: tagsArr,
        notes: rowNormalized.notes || null,
        status: 'New',
        ownerRecruiterId: assignedRecruiterId,
        createdById: currentUserId,
      };

      processedRows.push({
        rowNumber,
        data: candidateData,
        isValid: errors.length === 0,
        isDuplicateInSheet,
        errors,
      });
    }

    // 4. Second pass: Check existing duplicates against the PostgreSQL database
    const existingDbCandidates = await prisma.candidate.findMany({
      where: {
        OR: [
          { phone: { in: Array.from(candidatePhonesForDbCheck) } },
          { email: { in: Array.from(candidateEmailsForDbCheck) } },
        ],
      },
      select: {
        id: true,
        candidateCode: true,
        phone: true,
        email: true,
      },
    });

    const existingDbPhoneMap = new Map<string, string>();
    const existingDbEmailMap = new Map<string, string>();
    for (const ec of existingDbCandidates) {
      if (ec.phone) existingDbPhoneMap.set(ec.phone, ec.candidateCode);
      if (ec.email) existingDbEmailMap.set(ec.email.toLowerCase(), ec.candidateCode);
    }

    const errorReport: { row: number; candidateName: string; phone: string; email: string; reason: string }[] = [];
    const validRowsToInsert: ProcessedRow[] = [];
    let duplicateDbCount = 0;
    let duplicateSheetCount = 0;
    let invalidFieldCount = 0;

    for (const row of processedRows) {
      if (!row.isValid) {
        if (row.isDuplicateInSheet) {
          duplicateSheetCount++;
        } else {
          invalidFieldCount++;
        }
        errorReport.push({
          row: row.rowNumber,
          candidateName: row.data.fullName || 'Unknown',
          phone: row.data.phone || '',
          email: row.data.email || '',
          reason: row.errors.join('; '),
        });
        continue;
      }

      const existingPhoneCode = existingDbPhoneMap.get(row.data.phone);
      const existingEmailCode = existingDbEmailMap.get(row.data.email);

      if (existingPhoneCode || existingEmailCode) {
        duplicateDbCount++;
        const conflictReason = existingPhoneCode
          ? `Phone number already registered in database under Candidate ID ${existingPhoneCode}.`
          : `Email already registered in database under Candidate ID ${existingEmailCode}.`;
        errorReport.push({
          row: row.rowNumber,
          candidateName: row.data.fullName,
          phone: row.data.phone,
          email: row.data.email,
          reason: conflictReason,
        });
        continue;
      }

      validRowsToInsert.push(row);
    }

    const totalDuplicates = duplicateDbCount + duplicateSheetCount;

    // 5. If dryRun is requested, return preview analysis without writing to DB
    if (isDryRun) {
      sendSuccess(res, {
        isDryRun: true,
        totalRows: rawRows.length,
        validCount: validRowsToInsert.length,
        duplicateCount: totalDuplicates,
        duplicateDbCount,
        duplicateSheetCount,
        invalidCount: invalidFieldCount,
        previewRows: validRowsToInsert.slice(0, 10).map((r) => ({
          row: r.rowNumber,
          name: r.data.fullName,
          phone: r.data.phone,
          email: r.data.email,
          location: r.data.location,
          totalExperience: r.data.totalExperience,
          currentCompany: r.data.currentCompany,
        })),
        errors: errorReport.slice(0, 100), // First 100 errors for preview
      }, 'Spreadsheet validation completed successfully.');
      return;
    }

    // 6. Execute atomic batch insertion in transactions
    if (validRowsToInsert.length === 0) {
      sendSuccess(res, {
        totalProcessed: rawRows.length,
        importedCount: 0,
        skippedCount: totalDuplicates,
        failedCount: invalidFieldCount,
        generatedCodes: [],
        errors: errorReport,
        message: 'No new valid candidates were imported. All rows were either duplicates or contained validation errors.',
      }, 'Import completed with 0 records inserted.');
      return;
    }

    // Reserve candidate codes in a single atomic sequence call
    const candidateCodes = await generateCandidateCodesBatch(validRowsToInsert.length);

    const insertedCodes: string[] = [];
    const CHUNK_SIZE = 50;

    for (let i = 0; i < validRowsToInsert.length; i += CHUNK_SIZE) {
      const chunk = validRowsToInsert.slice(i, i + CHUNK_SIZE);
      const codesChunk = candidateCodes.slice(i, i + CHUNK_SIZE);

      await prisma.$transaction(async (tx) => {
        for (let j = 0; j < chunk.length; j++) {
          const rowItem = chunk[j];
          const code = codesChunk[j];

          const created = await tx.candidate.create({
            data: {
              ...rowItem.data,
              candidateCode: code,
            },
            select: { id: true, candidateCode: true },
          });

          insertedCodes.push(created.candidateCode);

          // Timeline entry
          try {
            await logCandidateTimeline({
              candidateId: created.id,
              userId: currentUserId || null,
              userName: (req.user as any)?.email,
              userRole: (req.user as any)?.role,
              action: 'Candidate Imported',
              newStatus: 'New',
              remarks: `Candidate profile created (${created.candidateCode}) via Bulk Excel Import by ${(req.user as any)?.email || 'Admin'}`,
              client: tx,
            });
          } catch {}
        }
      });
    }

    // Audit log for the import batch
    try {
      await logAudit({
        userId: currentUserId,
        action: 'BULK_CANDIDATE_IMPORT',
        module: 'CANDIDATES',
        entity: 'Candidate',
        entityId: `batch-${Date.now()}`,
        newValue: {
          importedCount: insertedCodes.length,
          skippedDuplicates: totalDuplicates,
          invalidRows: invalidFieldCount,
          fileName: file.originalname,
        },
      });
    } catch {}

    sendSuccess(res, {
      totalProcessed: rawRows.length,
      importedCount: insertedCodes.length,
      skippedCount: totalDuplicates,
      failedCount: invalidFieldCount,
      generatedCodes: insertedCodes,
      errors: errorReport,
      message: `Successfully imported ${insertedCodes.length} candidates into the database. ${totalDuplicates} duplicate records skipped. ${invalidFieldCount} invalid rows skipped.`,
    }, 'Bulk candidate import processed successfully.');
  } catch (err) {
    next(err);
  }
};
