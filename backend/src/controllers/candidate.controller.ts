import { computeWorkingDays, normalizeClientName, validateSelectionDates } from '../utils/workingDays';
import ExcelJS from 'exceljs';
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
import { formatWalkInDate, formatReadableInterviewDate } from '../utils/dateFormatter';
import { findWalkInLocationById } from './walk-in.controller';

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
  email: z.string().trim().email().max(180).optional().or(z.literal('')),
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
  clientName: z.string().trim().max(160).optional(),
  clientId: z.string().optional().nullable(),
  selectionDate: safeDate,
  selectedAt: safeDate,
  actualJoiningStatus: z.string().trim().max(64).optional(),
  lastWorkingDate: safeDate,
  totalWorkingDays: z.coerce.number().nullable().optional(),
  remarks: z.string().max(10000).optional(),
  assignedRecruiters: z.any().optional(),
  assignedRecruiterIds: z.array(z.string()).optional(),
  assignedRecruiterName: z.string().optional(),
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
            { assignedRecruiterIds: { has: user.userId } },
            { tags: { has: `assignedRecruiter:${user.userId}` } },
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
      archived,
      archivedFrom,
      archivedTo,
      previousStatus,
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
    const SELECTED_STATUSES = ['Selected', 'Joined', 'SELECTED', 'JOINED', 'selected', 'joined'];

    const isArchivedRequested = String(archived).toLowerCase() === 'true' || String(archived) === '1';
    const isSelectedBucketRequested = String(req.query.selectedBucket).toLowerCase() === 'true';

    if (isArchivedRequested) {
      // 1. ARCHIVE: Archive wins! Shows all candidates with isArchived = true
      andFilters.push({ isArchived: true });
      const archivedAt = buildDateFilter(parseDate(archivedFrom), parseDate(archivedTo));
      if (archivedAt) andFilters.push({ archivedAt });
      if (previousStatus) andFilters.push({ previousStatus: String(previousStatus) });
    } else if (isSelectedBucketRequested) {
      // 2. SELECTED BUCKET: isArchived is false (or null) AND status in Selected/Joined
      andFilters.push({
        OR: [
          { isArchived: false },
          { isArchived: null },
        ],
      });
      andFilters.push({
        status: { in: SELECTED_STATUSES },
      });
    } else {
      // 3. CANDIDATE MASTER DIRECTORY: Single source of truth
      // MUST show every candidate that is NOT Archived AND NOT Selected!
      andFilters.push({
        OR: [
          { isArchived: false },
          { isArchived: null },
        ],
      });

      if (status && status !== 'ALL') {
        const statusStr = String(status).trim();
        if (statusStr.includes(',')) {
          const statuses = statusStr.split(',').map((s) => s.trim()).filter(Boolean);
          andFilters.push({ status: { in: statuses } });
        } else {
          andFilters.push({ status: statusStr });
        }
      } else {
        // Explicit exclusion of Selected/Joined so unknown, legacy, null, and empty statuses NEVER disappear!
        andFilters.push({
          OR: [
            { status: null },
            { status: { notIn: SELECTED_STATUSES } },
          ],
        });
      }
    }
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
          { assignedRecruiterIds: { has: currentUserId } },
          { tags: { has: `assignedRecruiter:${currentUserId}` } },
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
    if (recruiterId) {
      const recIdStr = String(recruiterId);
      andFilters.push({
        OR: [
          { ownerRecruiterId: recIdStr },
          { sourcingRecruiterId: recIdStr },
          { createdById: recIdStr },
          { applications: { some: { recruiterId: recIdStr } } },
          { assignedRecruiterIds: { has: recIdStr } },
          { tags: { has: `assignedRecruiter:${recIdStr}` } },
        ],
      });
    }
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
      const phoneDigits = q.replace(/\D/g, '');
      const searchConditions: any[] = [
        { candidateCode: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { currentCompany: { contains: q, mode: 'insensitive' } },
        { currentDesignation: { contains: q, mode: 'insensitive' } },
      ];

      // If search query contains digits, normalize phone number for partial match
      if (phoneDigits.length >= 4) {
        searchConditions.push({ phone: { contains: phoneDigits } });
        if (phoneDigits.length >= 10) {
          searchConditions.push({ phone: { contains: phoneDigits.slice(-10) } });
        }
      }

      andFilters.push({
        OR: searchConditions,
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
          archivedBy: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
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
    const cleanEmail = (data.email && data.email.trim()) ? data.email.trim().toLowerCase() : ('bulk.' + cleanPhone.replace(/\D/g, '') + '@orricaedge.internal');

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
          source: data.source || (userRole === 'RECRUITER' ? 'Recruiter Added' : 'Admin Created'),
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

    let assignedName = 'Unassigned';
    if (candidate.ownerRecruiterId) {
      const rec = await prisma.user.findUnique({
        where: { id: candidate.ownerRecruiterId },
        select: { fullName: true, email: true },
      });
      if (rec) assignedName = rec.fullName || rec.email;
    }

    await logAudit({
      req,
      action: 'CREATE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: candidate.id,
      newValue: {
        candidateName: candidate.fullName || candidate.name,
        candidateCode: candidate.candidateCode,
        candidateId: candidate.id,
        sourcingRecruiterId: candidate.sourcingRecruiterId,
        teamLeaderId: candidate.teamLeaderId,
        ownerRecruiterId: candidate.ownerRecruiterId,
        assignedRecruiterName: assignedName,
        details: `Candidate "${candidate.fullName || candidate.name}" (${candidate.candidateCode}) profile created`,
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

    let recruiter: any = null;
    if (recruiterId) {
      recruiter = await prisma.user.findFirst({
        where: { id: recruiterId, role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] }, isActive: true },
        select: { id: true, fullName: true, email: true },
      });
      if (!recruiter) {
        sendError(res, 'Recruiter not found or inactive', 400);
        return;
      }
    }

    const previousRecruiter = existing.ownerRecruiterId
      ? await prisma.user.findUnique({
          where: { id: existing.ownerRecruiterId },
          select: { id: true, fullName: true, email: true },
        })
      : null;

    const isReassign = Boolean(existing.ownerRecruiterId && existing.ownerRecruiterId !== recruiterId);
    const candidateName = existing.fullName || existing.name || 'Candidate';
    const candidateCode = existing.candidateCode || existing.id;
    const assignedRecruiterName = recruiter ? (recruiter.fullName || recruiter.email) : 'Unassigned';
    const previousRecruiterName = previousRecruiter ? (previousRecruiter.fullName || previousRecruiter.email) : 'Unassigned';
    const actionType = isReassign ? 'REASSIGN_CANDIDATE_RECRUITER' : 'ASSIGN_CANDIDATE_RECRUITER';
    const detailsDescription = isReassign
      ? `Candidate "${candidateName}" (${candidateCode}) reassigned from ${previousRecruiterName} to ${assignedRecruiterName}`
      : `Candidate "${candidateName}" (${candidateCode}) assigned to recruiter ${assignedRecruiterName}`;

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
            candidateName,
            candidateCode,
            previousOwnerRecruiterId: existing.ownerRecruiterId,
            previousOwnerRecruiterName: previousRecruiterName,
            newOwnerRecruiterId: recruiterId,
            newOwnerRecruiterName: assignedRecruiterName,
            isReassign,
            description: detailsDescription,
          },
        },
      });

      if (recruiterId) {
        const jobTitle = existing.applications?.[0]?.job?.title || existing.currentDesignation || 'Job Opening';
        await tx.notification.create({
          data: {
            userId: recruiterId,
            title: isReassign ? 'Candidate Reassigned' : 'Candidate Assigned',
            message: `A candidate has been ${isReassign ? 'reassigned' : 'assigned'} to you. ${candidateName} - ${jobTitle}`,
            type: 'CANDIDATE_ASSIGNED',
            link: `/candidates/${existing.id}`,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: req.user?.userId || null,
          action: actionType,
          module: 'CANDIDATES',
          entity: 'Candidate',
          entityId: existing.id,
          oldValue: {
            ownerRecruiterId: existing.ownerRecruiterId,
            assignedRecruiterName: previousRecruiterName,
            candidateName,
            candidateCode,
            candidateId: existing.id,
            isReassign,
          },
          newValue: {
            ownerRecruiterId: recruiterId,
            assignedRecruiterName,
            candidateName,
            candidateCode,
            candidateId: existing.id,
            isReassign,
            details: detailsDescription,
          },
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
    const {
      rescheduleReason,
      recruiterRemarks,
      assignedRecruiterId,
      jobId,
      targetJobId,
      clientName,
      clientId,
      selectionDate,
      selectedAt,
      actualJoiningStatus,
      lastWorkingDate,
      totalWorkingDays,
      assignedRecruiters,
      assignedRecruiterIds,
      assignedRecruiterName,
      remarks,
      ...rawCandidateData
    } = data as any;

    // Whitelist valid Prisma columns on model Candidate to prevent PrismaClientValidationError (HTTP 500)
    const allowedCandidateFields = new Set([
      'name',
      'fullName',
      'email',
      'phone',
      'fatherName',
      'dateOfBirth',
      'gender',
      'currentLocation',
      'location',
      'preferredLocation',
      'totalExperience',
      'relevantExperience',
      'experienceYears',
      'highestQualification',
      'education',
      'currentCompany',
      'currentDesignation',
      'previousCompany',
      'noticePeriod',
      'noticePeriodDays',
      'currentSalary',
      'expectedSalary',
      'currentCtc',
      'expectedCtc',
      'skills',
      'languages',
      'resumeUrl',
      'resumeText',
      'source',
      'tags',
      'notes',
      'feedback',
      'dateOfJoin',
      'walkInStatus',
      'walkInResponse',
      'walkInDate',
      'walkInTime',
      'followUpAt',
      'followUpCompletedAt',
      'rescheduleCount',
      'status',
      'nextActionDate',
      'nextActionType',
      'nextActionRemarks',
      'sourcingRecruiterId',
      'teamLeaderId',
      'ownerRecruiterId',
      'createdById',
      'isArchived',
      'archivedAt',
      'archivedById',
      'archiveReason',
      'previousStatus',
      'clientId',
      'clientName',
      'selectionDate',
      'actualJoiningStatus',
      'totalWorkingDays',
      'lastWorkingDate',
      'assignedRecruiterIds',
    ]);

    const candidateData: Record<string, any> = {};
    for (const [key, val] of Object.entries(rawCandidateData)) {
      if (allowedCandidateFields.has(key) && val !== undefined) {
        candidateData[key] = val;
      }
    }

    // Safely map recruiter remarks to feedback and notes columns
    const finalRemarks = String(recruiterRemarks || remarks || '').trim();
    if (finalRemarks) {
      if (!candidateData.feedback) candidateData.feedback = finalRemarks;
      if (!candidateData.notes) candidateData.notes = finalRemarks;
    }

    // Safely map recruiter assignment
    const targetRecruiterId = candidateData.ownerRecruiterId || assignedRecruiterId;
    if (targetRecruiterId && typeof targetRecruiterId === 'string') {
      const recUser = await prisma.user.findFirst({
        where: { id: targetRecruiterId },
        select: { id: true },
      });
      if (recUser) {
        candidateData.ownerRecruiterId = recUser.id;
      }
    }

    // Selection Workflow Validation & Preparation
    const isExplicitSelectionWorkflow =
      selectionDate !== undefined ||
      selectedAt !== undefined ||
      actualJoiningStatus !== undefined ||
      clientName !== undefined ||
      clientId !== undefined ||
      (Array.isArray(assignedRecruiterIds) && assignedRecruiterIds.length > 0) ||
      lastWorkingDate !== undefined;

    const isMovingToSelected = nextStatus === 'Selected' || nextStatus === 'Joined';
    const isSelectionWorkflow = isExplicitSelectionWorkflow || isMovingToSelected;

    let computedTotalWorkingDays: number | null | undefined = undefined;
    let resolvedCanonicalClientName: string | null | undefined = undefined;
    let finalAssignedRecruiterIds: string[] = [];
    let effectiveSelDate: string | undefined = undefined;
    let effectiveJoiningStatus: string = 'Selected (Not Joined Yet)';

    if (isSelectionWorkflow) {
      // 1. Client check & resolution (Keep existing client; default to application client or canonical client if missing)
      let effectiveClientName = String(clientName || existing.clientName || '').trim();
      let effectiveClientId = clientId || existing.clientId;
      if (!effectiveClientName && !effectiveClientId) {
        if (isMovingToSelected) {
          const appClient = (existing as any).applications?.[0]?.job?.client?.companyName;
          effectiveClientName = appClient ? String(appClient).trim() : 'Digitide Solutions';
        } else {
          sendError(res, 'Client organization is required.', 400);
          return;
        }
      }

      // 2. Recruiter assignment check & resolution (Keep existing recruiters; default to owner/creator if missing)
      let effectiveRecruiterIds = Array.isArray(assignedRecruiterIds) && assignedRecruiterIds.length > 0
        ? assignedRecruiterIds
        : (existing.assignedRecruiterIds && existing.assignedRecruiterIds.length > 0)
        ? existing.assignedRecruiterIds
        : (existing.ownerRecruiterId ? [existing.ownerRecruiterId] : []);
      if (!effectiveRecruiterIds || effectiveRecruiterIds.length === 0) {
        if (isMovingToSelected) {
          const defaultRecruiterId = existing.sourcingRecruiterId || (req.user?.role === 'RECRUITER' || req.user?.role === 'FREELANCE_RECRUITER' ? req.user.userId : null) || existing.id;
          effectiveRecruiterIds = [defaultRecruiterId];
        } else {
          sendError(res, 'At least one assigned recruiter is required.', 400);
          return;
        }
      }

      // 3. Status and Last Working Date check
      effectiveJoiningStatus = actualJoiningStatus || existing.actualJoiningStatus || (nextStatus === 'Joined' ? 'Joined' : 'Selected (Not Joined Yet)');
      const effectiveDoj = data.dateOfJoin !== undefined ? data.dateOfJoin : existing.dateOfJoin;
      const effectiveLwd = lastWorkingDate !== undefined ? lastWorkingDate : existing.lastWorkingDate;
      const todayIso = new Date().toISOString().split('T')[0];
      effectiveSelDate = selectionDate || selectedAt || (existing.selectionDate ? String(existing.selectionDate).split('T')[0] : (isMovingToSelected ? todayIso : undefined));

      if (effectiveJoiningStatus === 'Exited' && !effectiveLwd) {
        sendError(res, 'Last Working Date is required when status is marked as Exited.', 400);
        return;
      }

      // 4. Date chronology validation (Requirement D: LWD earlier than DOJ rejected)
      if (effectiveSelDate || effectiveDoj || effectiveLwd) {
        const dateValidation = validateSelectionDates({
          selectionDate: effectiveSelDate,
          dateOfJoin: effectiveDoj,
          lastWorkingDate: effectiveLwd,
        });

        if (!dateValidation.isValid) {
          sendError(res, dateValidation.error || 'Invalid date selection.', 400);
          return;
        }
      }

      // 5. Compute backend working days (Source of Truth)
      if (effectiveDoj) {
        const wdResult = computeWorkingDays(
          effectiveJoiningStatus,
          effectiveDoj,
          effectiveLwd,
          new Date()
        );
        computedTotalWorkingDays = wdResult.totalWorkingDays;
      } else if (existing.totalWorkingDays !== null && existing.totalWorkingDays !== undefined && !data.dateOfJoin && !lastWorkingDate) {
        computedTotalWorkingDays = existing.totalWorkingDays;
      } else {
        computedTotalWorkingDays = 0;
      }

      // 6. Normalize Client Name
      resolvedCanonicalClientName = normalizeClientName(effectiveClientName);

      // 7. De-duplicate recruiter IDs
      finalAssignedRecruiterIds = Array.from(new Set(effectiveRecruiterIds.filter(Boolean)));
    }

    const walkInWasRescheduled =
      existing.walkInDate !== null &&
      ((data.walkInDate != null && data.walkInDate.getTime() !== existing.walkInDate.getTime()) ||
        (data.walkInTime !== undefined && data.walkInTime !== existing.walkInTime));
    if (walkInWasRescheduled && !rescheduleReason?.trim()) {
      sendError(res, 'A reason is required when rescheduling a walk-in.', 400);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (isSelectionWorkflow && resolvedCanonicalClientName) {
        let dbClient = await tx.client.findFirst({
          where: {
            OR: [
              { companyName: { equals: resolvedCanonicalClientName, mode: 'insensitive' } },
              ...(clientId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId) ? [{ id: clientId }] : []),
            ],
          },
        });

        if (!dbClient) {
          const clientDefaults: Record<string, any> = {
            'Digitide Solutions': {
              industry: 'IT Services & Consulting',
              contactPerson: 'Operations Lead',
              contactEmail: 'contact@digitidesolutions.com',
              contactPhone: '+91 98765 43210',
              location: 'Patna, Bihar, India',
            },
            'Radical Minds': {
              industry: 'BPO / IT Enabled Services',
              contactPerson: 'Talent Acquisition Lead',
              contactEmail: 'careers@radicalminds.net',
              contactPhone: '+91 98765 43211',
              location: 'Gurugram / Patna, India',
            },
          };

          const defaults = clientDefaults[resolvedCanonicalClientName] || {
            industry: 'Enterprise Technology & Services',
            contactPerson: 'Corporate Account Manager',
            contactEmail: `contact@${resolvedCanonicalClientName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
            contactPhone: '+91 98765 43210',
            location: 'Corporate HQ',
          };

          dbClient = await tx.client.create({
            data: {
              companyName: resolvedCanonicalClientName,
              industry: defaults.industry,
              contactPerson: defaults.contactPerson,
              contactEmail: defaults.contactEmail,
              contactPhone: defaults.contactPhone,
              status: 'ACTIVE',
              address: defaults.location,
            },
          });
        }

        candidateData.clientId = dbClient.id;
        candidateData.clientName = resolvedCanonicalClientName;
      }

      if (isSelectionWorkflow) {
        if (effectiveSelDate) {
          candidateData.selectionDate = effectiveSelDate;
        }
        candidateData.actualJoiningStatus = effectiveJoiningStatus;
        if (lastWorkingDate !== undefined || existing.lastWorkingDate) {
          candidateData.lastWorkingDate = lastWorkingDate !== undefined ? lastWorkingDate : existing.lastWorkingDate;
        }
        candidateData.totalWorkingDays = computedTotalWorkingDays !== undefined ? computedTotalWorkingDays : (existing.totalWorkingDays ?? 0);
        if (finalAssignedRecruiterIds.length > 0) {
          candidateData.assignedRecruiterIds = finalAssignedRecruiterIds;
          candidateData.ownerRecruiterId = finalAssignedRecruiterIds[0];
        }

        // Build clean tags
        let updatedTags = Array.isArray(candidateData.tags)
          ? [...candidateData.tags]
          : Array.isArray(existing.tags)
          ? [...existing.tags]
          : [];

        updatedTags = updatedTags.filter((t: string) =>
          !t.startsWith('client:') &&
          !t.startsWith('clientId:') &&
          !t.startsWith('selectionDate:') &&
          !t.startsWith('actualJoiningStatus:') &&
          !t.startsWith('lastWorkingDate:') &&
          !t.startsWith('totalWorkingDays:') &&
          !t.startsWith('assignedRecruiters:') &&
          !t.startsWith('assignedRecruiter:')
        );

        if (resolvedCanonicalClientName) updatedTags.push(`client:${resolvedCanonicalClientName}`);
        if (candidateData.clientId) updatedTags.push(`clientId:${candidateData.clientId}`);
        const effectiveSel = candidateData.selectionDate || existing.selectionDate;
        if (effectiveSel) {
          const sDateStr = effectiveSel instanceof Date ? effectiveSel.toISOString().split('T')[0] : String(effectiveSel).split('T')[0];
          updatedTags.push(`selectionDate:${sDateStr}`);
        }
        if (candidateData.actualJoiningStatus) {
          updatedTags.push(`actualJoiningStatus:${candidateData.actualJoiningStatus}`);
        }
        if (candidateData.lastWorkingDate) {
          const lDateStr = candidateData.lastWorkingDate instanceof Date ? candidateData.lastWorkingDate.toISOString().split('T')[0] : String(candidateData.lastWorkingDate).split('T')[0];
          updatedTags.push(`lastWorkingDate:${lDateStr}`);
        }
        if (computedTotalWorkingDays !== null && computedTotalWorkingDays !== undefined) {
          updatedTags.push(`totalWorkingDays:${computedTotalWorkingDays}`);
        }
        if (finalAssignedRecruiterIds.length > 0) {
          updatedTags.push(`assignedRecruiters:${finalAssignedRecruiterIds.join(',')}`);
          for (const recId of finalAssignedRecruiterIds) {
            updatedTags.push(`assignedRecruiter:${recId}`);
          }
        }
        candidateData.tags = updatedTags;
      }

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

    const isOwnerChanged = existing.ownerRecruiterId !== updated.ownerRecruiterId;
    let prevRecName = 'Unassigned';
    let nextRecName = 'Unassigned';
    if (isOwnerChanged) {
      if (existing.ownerRecruiterId) {
        const p = await prisma.user.findUnique({ where: { id: existing.ownerRecruiterId }, select: { fullName: true, email: true } });
        prevRecName = p?.fullName || p?.email || 'Unassigned';
      }
      if (updated.ownerRecruiterId) {
        const n = await prisma.user.findUnique({ where: { id: updated.ownerRecruiterId }, select: { fullName: true, email: true } });
        nextRecName = n?.fullName || n?.email || 'Unassigned';
      }
    }

    const cName = updated.fullName || updated.name || existing.fullName || existing.name || 'Candidate';
    const cCode = updated.candidateCode || existing.candidateCode || existing.id;
    const auditAction = isOwnerChanged
      ? (existing.ownerRecruiterId ? 'REASSIGN_CANDIDATE_RECRUITER' : 'ASSIGN_CANDIDATE_RECRUITER')
      : 'UPDATE_CANDIDATE';
    const auditDetails = isOwnerChanged
      ? (existing.ownerRecruiterId
          ? `Candidate "${cName}" (${cCode}) reassigned from ${prevRecName} to ${nextRecName}`
          : `Candidate "${cName}" (${cCode}) assigned to recruiter ${nextRecName}`)
      : `Candidate "${cName}" (${cCode}) updated (Status: ${updated.status})`;

    await logAudit({
      req,
      action: auditAction,
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: existing.id,
      oldValue: {
        status: existing.status,
        ownerRecruiterId: existing.ownerRecruiterId,
        assignedRecruiterName: prevRecName,
        candidateName: cName,
        candidateCode: cCode,
        candidateId: existing.id,
      },
      newValue: {
        status: updated.status,
        ownerRecruiterId: updated.ownerRecruiterId,
        assignedRecruiterName: nextRecName,
        candidateName: cName,
        candidateCode: cCode,
        candidateId: existing.id,
        details: auditDetails,
      },
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
    const rawClientName = (req.body?.clientName || req.body?.companyName || job?.client?.companyName || '').trim();
    const clientName = (rawClientName && !['orrica edge', 'orrica edge partner', 'orrica edge llp', 'orrica'].includes(rawClientName.toLowerCase())) ? rawClientName : '';
    const walkInDateStr = dateInfo.dateStr;
    const greetingName = formatCandidateGreetingName(candidate);
    const selectedSessionId = (req.body?.sessionId || req.body?.locationId || (candidate as any).walkInSessionId || savedSession.id || '').trim();

    // Encode structured token containing exact candidate, job, application, and session signature
    const tokenPayload = {
      c: candidate.id,
      j: job?.id,
      a: application?.id,
      s: selectedSessionId || savedSession.id,
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
          sessionId: selectedSessionId || savedSession.id,
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

    // Role-based candidate access verification
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;
    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      const isAuthorized =
        candidate.sourcingRecruiterId === currentUserId ||
        candidate.ownerRecruiterId === currentUserId ||
        candidate.createdById === currentUserId ||
        candidate.applications.some((app: any) => app.recruiterId === currentUserId);
      if (!isAuthorized) {
        sendError(res, 'You are not authorized to send walk-in invitations to this candidate.', 403);
        return;
      }
    }

    // Match application if available
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

    // Resolve saved session details from body or job.hiringProcess.walkInSession
    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};

    const rawDate = req.body?.walkInDate || candidate.walkInDate || savedSession.date || savedSession.interviewDate;
    const dateInfo = formatWalkInDate(rawDate);
    if (!dateInfo.dateStr) {
      sendError(res, 'A valid walk-in interview date is required.', 400);
      return;
    }

    const readableInterviewDate = formatReadableInterviewDate(rawDate) || dateInfo.displayDate;

    const selectedSessionId = (req.body?.sessionId || req.body?.locationId || '').trim();
    const targetSessionId = selectedSessionId || savedSession.id || '';
    let locationVenue: any = null;
    if (selectedSessionId) {
      locationVenue = await findWalkInLocationById(selectedSessionId);
    }

    const reportingTime = (
      req.body?.reportingTime ||
      req.body?.walkInTime ||
      candidate.walkInTime ||
      locationVenue?.defaultReportingTime ||
      savedSession.reportingTime ||
      '09:30 AM'
    ).trim();

    const venueNameStr = (
      req.body?.venueName ||
      locationVenue?.venueName ||
      locationVenue?.locationName ||
      savedSession.venueName ||
      ''
    ).trim();

    const venueAddressStr = (
      req.body?.venueAddress ||
      locationVenue?.venueAddress ||
      savedSession.venueAddress ||
      ''
    ).trim();

    let googleMapsLinkStr = (
      req.body?.googleMapsLink ||
      locationVenue?.googleMapsLink ||
      savedSession.googleMapsLink ||
      ''
    ).trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }

    const instructionsStr = (req.body?.instructions || savedSession.instructions || '').trim();

    // Enforce required walk-in session details
    if (!reportingTime || !venueNameStr || !venueAddressStr) {
      sendError(res, 'Walk-in session details are incomplete. Please provide a valid venue name, complete address, and reporting time.', 400);
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
    const rawClientName = (req.body?.clientName || req.body?.companyName || job?.client?.companyName || '').trim();
    const clientName = (rawClientName && !['orrica edge', 'orrica edge partner', 'orrica edge llp', 'orrica'].includes(rawClientName.toLowerCase())) ? rawClientName : '';
    const walkInDateStr = dateInfo.dateStr;
    const greetingName = formatCandidateGreetingName(candidate);

    // Encode structured token containing exact candidate, job, application, and session signature
    const tokenPayload = {
      c: candidate.id,
      j: job?.id,
      a: application?.id,
      s: targetSessionId || savedSession.id,
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
      company_name: clientName,
      walk_in_date: readableInterviewDate,
      walkin_date: readableInterviewDate,
      walk_in_date_formatted: readableInterviewDate,
      interview_date: readableInterviewDate,
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

      // Audit Log for Failed Attempt
      try {
        await logAudit({
          req,
          action: 'WALK_IN_INVITATION_FAILED',
          module: 'WALK_IN_INVITATIONS',
          entity: 'Candidate',
          entityId: candidate.id,
          newValue: {
            candidateId: candidate.id,
            candidateCode: candidate.candidateCode,
            candidateName: candidate.fullName,
            candidateEmail: candidate.email,
            interviewDate: readableInterviewDate,
            walkInDate: walkInDateStr,
            venueName: venueNameStr,
            venueAddress: venueAddressStr,
            reportingTime,
            instructions: instructionsStr || null,
            sentBy: req.user?.role === 'RECRUITER' || req.user?.role === 'FREELANCE_RECRUITER' ? 'Recruiter' : 'Admin',
            senderRole: req.user?.role || 'ADMIN',
            senderUserId: req.user?.userId || null,
            senderName: req.user?.email || 'User',
            deliveryStatus: 'FAILED',
            errorDetails: providerErr.message || 'Email dispatch failed',
            timestamp: new Date().toISOString(),
          },
        });
      } catch (auditErr: any) {
        console.warn('[AUDIT LOG FAILED ATTEMPT ERROR]:', auditErr.message);
      }

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
        notes: 'Walk-in invitation sent to ' + candidate.email + ' for ' + jobTitle + ' (' + readableInterviewDate + ').',
        metadata: {
          recipient: candidate.email,
          jobId: job?.id,
          applicationId: application?.id,
          sessionId: targetSessionId || savedSession.id,
          walkInDate: walkInDateStr,
          interviewDate: readableInterviewDate,
          reportingTime,
          venueName: venueNameStr,
          venueAddress: venueAddressStr,
          googleMapsLink: googleMapsLinkStr,
          instructions: instructionsStr,
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
      remarks: 'Walk-in invitation dispatched to ' + candidate.email + ' for ' + jobTitle + ' (' + readableInterviewDate + ').',
    });

    // Audit Log for Successful Invitation
    try {
      await logAudit({
        req,
        action: 'WALK_IN_INVITATION_SENT',
        module: 'WALK_IN_INVITATIONS',
        entity: 'Candidate',
        entityId: candidate.id,
        newValue: {
          candidateId: candidate.id,
          candidateCode: candidate.candidateCode,
          candidateName: candidate.fullName,
          candidateEmail: candidate.email,
          interviewDate: readableInterviewDate,
          walkInDate: walkInDateStr,
          venueName: venueNameStr,
          venueAddress: venueAddressStr,
          reportingTime,
          instructions: instructionsStr || null,
          sentBy: req.user?.role === 'RECRUITER' || req.user?.role === 'FREELANCE_RECRUITER' ? 'Recruiter' : 'Admin',
          senderRole: req.user?.role || 'ADMIN',
          senderUserId: req.user?.userId || null,
          senderName: req.user?.email || 'User',
          deliveryStatus: 'SENT',
          messageId: dispatchResult.messageId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (auditErr: any) {
      console.warn('[AUDIT LOG SUCCESSFUL INVITATION ERROR]:', auditErr.message);
    }

    sendSuccess(res, {
      candidateId: candidate.id,
      candidateName: candidate.fullName,
      recipient: candidate.email,
      dispatched: true,
      messageId: dispatchResult.messageId,
      walkInDate: walkInDateStr,
      interviewDate: readableInterviewDate,
      reportingTime,
      venueName: venueNameStr,
      venueAddress: venueAddressStr,
      message: 'Walk-in invitation sent successfully to ' + candidate.email + '.',
    });
  } catch (err) {
    next(err);
  }
};

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
 * Canonical 27 Universal Headers for Candidate Bulk Import
 */
export const CANONICAL_BULK_IMPORT_HEADERS = [
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
  'Notes',
] as const;

/**
 * Normalizes 10-digit Indian phone number and guards against scientific notation corruption
 */
export const normalizePhoneNumber = (raw: any): { phone: string; isValid: boolean; error?: string } => {
  if (!raw) return { phone: '', isValid: false, error: 'Phone number is required.' };
  const rawStr = String(raw).trim();

  // Guard against scientific notation (e.g. 7.86E+09 or 9.87e+09)
  if (/[eE]\+?[0-9]/.test(rawStr)) {
    return {
      phone: rawStr,
      isValid: false,
      error: `Invalid phone number format: scientific notation detected ('${rawStr}'). Ensure Phone column is formatted as Text in Excel.`,
    };
  }

  let cleaned = rawStr.replace(/\D/g, '');
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1);
  }

  const isValid = /^[6-9]\d{9}$/.test(cleaned);
  return {
    phone: cleaned,
    isValid,
    error: isValid ? undefined : `Invalid phone number '${rawStr}'. Must be a valid 10-digit Indian mobile number.`,
  };
};

/**
 * Parses and validates Date of Birth (YYYY-MM-DD or Excel serial, past date, age 18+)
 */
export const parseDateOfBirth = (val: any): { date: Date | null; error?: string } => {
  if (!val) return { date: null };
  const str = String(val).trim();
  if (!str) return { date: null };

  let date: Date | null = null;

  // Check for Excel serial number (typically 10000 - 60000)
  const numVal = Number(str);
  if (!isNaN(numVal) && numVal > 1000 && numVal < 100000) {
    const utcDays = numVal - 25569;
    const utcValue = utcDays * 86400 * 1000;
    date = new Date(utcValue);
  } else if (/^\d{2}[-/.]\d{2}[-/.]\d{4}$/.test(str)) {
    // DD-MM-YYYY format
    const parts = str.split(/[-/.]/);
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    date = new Date(Date.UTC(year, month, day));
  } else if (/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(str)) {
    // YYYY-MM-DD format
    const parts = str.split(/[-/.]/);
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    date = new Date(Date.UTC(year, month, day));
  } else {
    date = new Date(str);
  }

  if (!date || isNaN(date.getTime())) {
    return { date: null, error: `Invalid Date of Birth format '${str}'. Use YYYY-MM-DD.` };
  }

  const now = new Date();
  if (date > now) {
    return { date: null, error: 'Date of Birth cannot be in the future.' };
  }

  // Age 18+ verification
  const ageYears = (now.getTime() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears < 18) {
    return { date: null, error: 'Candidate must be at least 18 years old.' };
  }

  return { date };
};

/**
 * Normalizes Gender (case-insensitive Male/Female/Other, accepts M/F/O variants)
 */
export const parseGender = (val: any): { gender: 'MALE' | 'FEMALE' | 'OTHER' | null; error?: string } => {
  if (!val) return { gender: null };
  const raw = String(val).trim().toUpperCase();
  if (!raw) return { gender: null };

  if (['MALE', 'M', 'MAN'].includes(raw)) return { gender: 'MALE' };
  if (['FEMALE', 'F', 'WOMAN'].includes(raw)) return { gender: 'FEMALE' };
  if (['OTHER', 'O', 'NON-BINARY'].includes(raw)) return { gender: 'OTHER' };

  return {
    gender: null,
    error: `Invalid Gender '${val}'. Allowed values: Male, Female, Other.`,
  };
};

/**
 * Download standard Excel (.xlsx) or CSV import template with true Excel data validation dropdown
 * GET /api/v1/candidates/template/download
 */
export const downloadCandidateImportTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const isCsv = req.query.format === 'csv';

    const sampleRowData = {
      'Full Name': 'Aarav Sharma (Example Row - DO NOT EDIT)',
      'Phone': '9876543210',
      'Email': 'aarav.sharma@example.com',
      'Father Name': 'Rajesh Sharma',
      'Date of Birth (YYYY-MM-DD)': '1996-05-15',
      'Gender (Male/Female/Other)': 'Male',
      'Current Location': 'Bengaluru, Karnataka',
      'Preferred Location': 'Bengaluru, Hyderabad',
      'Total Experience (Years)': '4.5',
      'Relevant Experience (Years)': '3.5',
      'Highest Qualification': 'B.Tech in Computer Science',
      'Education': 'B.Tech',
      'Current Company': 'Infosys Ltd',
      'Current Designation': 'Senior Software Engineer',
      'Previous Company': 'TCS',
      'Notice Period': '30 Days',
      'Notice Period Days': '30',
      'Current Monthly Salary': '65000',
      'Expected Monthly Salary': '85000',
      'Current CTC': '780000',
      'Expected CTC': '1020000',
      'Skills (comma-separated)': 'React, TypeScript, Node.js',
      'Languages (comma-separated)': 'English, Hindi',
      'Resume URL': 'https://example.com/resumes/aarav.pdf',
      'Source': 'Bulk Import',
      'Tags (comma-separated)': 'Frontend, Immediate Joiner',
      'Notes': 'Cleared technical round with strong coding assessment.',
    };

    if (isCsv) {
      const headers = [...CANONICAL_BULK_IMPORT_HEADERS];
      const row = headers.map(h => `"${(sampleRowData as any)[h] || ''}"`);
      const csvContent = [headers.join(','), row.join(',')].join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Orrica_Edge_Candidate_Import_Template.csv"');
      res.send(csvContent);
      return;
    }

    // Build real Excel (.xlsx) using ExcelJS
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Orrica Edge LLP ATS';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Sheet 1: Candidates
    const candidatesSheet = workbook.addWorksheet('Candidates', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    candidatesSheet.columns = [
      { header: 'Full Name', key: 'fullName', width: 26 },
      { header: 'Phone', key: 'phone', width: 18, style: { numFmt: '@' } }, // Phone column as Text
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Father Name', key: 'fatherName', width: 22 },
      { header: 'Date of Birth (YYYY-MM-DD)', key: 'dateOfBirth', width: 26 },
      { header: 'Gender (Male/Female/Other)', key: 'gender', width: 26 },
      { header: 'Current Location', key: 'currentLocation', width: 24 },
      { header: 'Preferred Location', key: 'preferredLocation', width: 24 },
      { header: 'Total Experience (Years)', key: 'totalExperience', width: 24 },
      { header: 'Relevant Experience (Years)', key: 'relevantExperience', width: 24 },
      { header: 'Highest Qualification', key: 'highestQualification', width: 24 },
      { header: 'Education', key: 'education', width: 22 },
      { header: 'Current Company', key: 'currentCompany', width: 24 },
      { header: 'Current Designation', key: 'currentDesignation', width: 24 },
      { header: 'Previous Company', key: 'previousCompany', width: 24 },
      { header: 'Notice Period', key: 'noticePeriod', width: 20 },
      { header: 'Notice Period Days', key: 'noticePeriodDays', width: 20 },
      { header: 'Current Monthly Salary', key: 'currentSalary', width: 22 },
      { header: 'Expected Monthly Salary', key: 'expectedSalary', width: 22 },
      { header: 'Current CTC', key: 'currentCtc', width: 20 },
      { header: 'Expected CTC', key: 'expectedCtc', width: 20 },
      { header: 'Skills (comma-separated)', key: 'skills', width: 32 },
      { header: 'Languages (comma-separated)', key: 'languages', width: 26 },
      { header: 'Resume URL', key: 'resumeUrl', width: 34 },
      { header: 'Source', key: 'source', width: 20 },
      { header: 'Tags (comma-separated)', key: 'tags', width: 26 },
      { header: 'Notes', key: 'notes', width: 38 },
    ];

    // Style Header Row (Bold, Slate Background, White Text)
    const headerRow = candidatesSheet.getRow(1);
    headerRow.height = 28;
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Add Clearly Marked Example Row (Row 2)
    const exampleRow = candidatesSheet.addRow({
      fullName: 'Aarav Sharma (Example Row - DO NOT EDIT)',
      phone: '9876543210',
      email: 'aarav.sharma@example.com',
      fatherName: 'Rajesh Sharma',
      dateOfBirth: '1996-05-15',
      gender: 'Male',
      currentLocation: 'Bengaluru, Karnataka',
      preferredLocation: 'Bengaluru, Hyderabad',
      totalExperience: '4.5',
      relevantExperience: '3.5',
      highestQualification: 'B.Tech in Computer Science',
      education: 'B.Tech',
      currentCompany: 'Infosys Ltd',
      currentDesignation: 'Senior Software Engineer',
      previousCompany: 'TCS',
      noticePeriod: '30 Days',
      noticePeriodDays: '30',
      currentSalary: '65000',
      expectedSalary: '85000',
      currentCtc: '780000',
      expectedCtc: '1020000',
      skills: 'React, TypeScript, Node.js',
      languages: 'English, Hindi',
      resumeUrl: 'https://example.com/resumes/aarav.pdf',
      source: 'Bulk Import',
      tags: 'Frontend, Immediate Joiner',
      notes: 'Cleared technical round with strong coding assessment.',
    });
    exampleRow.font = { italic: true, color: { argb: 'FF475569' } };

    // Gender column Data Validation Dropdown for rows 2 to 5000 (Column F is index 6)
    (candidatesSheet as any).dataValidations.add('F2:F5000', {
      type: 'list',
      allowBlank: true,
      formulae: ['"Male,Female,Other"'],
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: 'Invalid Gender',
      error: 'Please select Male, Female, or Other from the dropdown list.',
      showInputMessage: true,
      promptTitle: 'Gender Dropdown',
      prompt: 'Select Gender: Male, Female, or Other',
    });

    // DOB column input message hint (Column E is index 5)
    (candidatesSheet as any).dataValidations.add('E2:E5000', {
      type: 'custom',
      allowBlank: true,
      formulae: ['ISNUMBER(E2)'],
      showInputMessage: true,
      promptTitle: 'DOB Format (YYYY-MM-DD)',
      prompt: 'Enter date in ISO format YYYY-MM-DD (e.g. 1996-05-15). Age must be 18+.',
    });

    // Sheet 2: Instructions
    const instructionsSheet = workbook.addWorksheet('Instructions');
    instructionsSheet.columns = [
      { header: 'Column Name', key: 'column', width: 28 },
      { header: 'Mandatory?', key: 'required', width: 16 },
      { header: 'Allowed Format / Values', key: 'format', width: 40 },
      { header: 'Example', key: 'example', width: 35 },
      { header: 'Important Instructions', key: 'notes', width: 50 },
    ];

    const instHeaderRow = instructionsSheet.getRow(1);
    instHeaderRow.height = 26;
    instHeaderRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    instHeaderRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2563EB' },
    };

    const instructionsData = [
      { column: 'Full Name', required: 'YES', format: 'Text (up to 150 chars)', example: 'Aarav Sharma', notes: 'Required field. Candidate legal name.' },
      { column: 'Phone', required: 'YES', format: '10-digit Indian Mobile', example: '9876543210', notes: 'Must start with 6, 7, 8, or 9. Formatted as Text.' },
      { column: 'Email', required: 'Optional', format: 'Valid Email address', example: 'aarav@example.com', notes: 'Lowercased automatically. Deduplicated if present.' },
      { column: 'Father Name', required: 'Optional', format: 'Text', example: 'Rajesh Sharma', notes: 'Father or Guardian name.' },
      { column: 'Date of Birth (YYYY-MM-DD)', required: 'Optional', format: 'ISO YYYY-MM-DD', example: '1996-05-15', notes: 'Must be a past date. Age must be at least 18.' },
      { column: 'Gender (Male/Female/Other)', required: 'Optional', format: 'Male, Female, or Other', example: 'Male', notes: 'Select from dropdown in Column F.' },
      { column: 'Current Location', required: 'Optional', format: 'City, State', example: 'Bengaluru, Karnataka', notes: 'Current residential location.' },
      { column: 'Preferred Location', required: 'Optional', format: 'City or Region', example: 'Hyderabad, Bengaluru', notes: 'Preferred work city.' },
      { column: 'Total Experience (Years)', required: 'Optional', format: 'Decimal number (e.g. 4.5)', example: '4.5', notes: 'Total professional experience in years.' },
      { column: 'Relevant Experience (Years)', required: 'Optional', format: 'Decimal number (e.g. 3.0)', example: '3.0', notes: 'Cannot exceed Total Experience.' },
      { column: 'Highest Qualification', required: 'Optional', format: 'Degree / Diploma', example: 'B.Tech in Computer Science', notes: 'Highest completed degree.' },
      { column: 'Education', required: 'Optional', format: 'Level (B.Tech, MBA, etc.)', example: 'B.Tech', notes: 'Educational level.' },
      { column: 'Current Company', required: 'Optional', format: 'Company Name', example: 'Infosys Ltd', notes: 'Present employer.' },
      { column: 'Current Designation', required: 'Optional', format: 'Job Title', example: 'Senior Software Engineer', notes: 'Present designation.' },
      { column: 'Previous Company', required: 'Optional', format: 'Company Name', example: 'TCS', notes: 'Prior employer.' },
      { column: 'Notice Period', required: 'Optional', format: 'Text (e.g. 30 Days)', example: '30 Days', notes: 'Notice period description.' },
      { column: 'Notice Period Days', required: 'Optional', format: 'Integer (0 to 180)', example: '30', notes: 'Days between 0 and 180.' },
      { column: 'Current Monthly Salary', required: 'Optional', format: 'INR Monthly', example: '65000', notes: 'Monthly in-hand salary.' },
      { column: 'Expected Monthly Salary', required: 'Optional', format: 'INR Monthly', example: '85000', notes: 'Expected monthly compensation.' },
      { column: 'Current CTC', required: 'Optional', format: 'INR Annual', example: '780000', notes: 'Annual cost to company.' },
      { column: 'Expected CTC', required: 'Optional', format: 'INR Annual', example: '1020000', notes: 'Expected annual CTC.' },
      { column: 'Skills (comma-separated)', required: 'Optional', format: 'Comma-separated skills', example: 'React, TypeScript, Node.js', notes: 'Cleaned and deduplicated.' },
      { column: 'Languages (comma-separated)', required: 'Optional', format: 'Comma-separated languages', example: 'English, Hindi', notes: 'Languages spoken.' },
      { column: 'Resume URL', required: 'Optional', format: 'Valid URL (http/https)', example: 'https://example.com/cv.pdf', notes: 'Direct link to resume document.' },
      { column: 'Source', required: 'Optional', format: 'Sourcing Channel', example: 'Bulk Import', notes: 'Defaults to Bulk Import.' },
      { column: 'Tags (comma-separated)', required: 'Optional', format: 'Comma-separated tags', example: 'Frontend, Verified', notes: 'Categorization tags.' },
      { column: 'Notes', required: 'Optional', format: 'Free text notes', example: 'Candidate ready for immediate onboarding.', notes: 'Screening or interview notes.' },
    ];

    instructionsData.forEach(row => instructionsSheet.addRow(row));

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Orrica_Edge_Candidate_Import_Template.xlsx"');
    res.setHeader('Content-Length', buffer.byteLength.toString());
    res.end(buffer);
  } catch (err) {
    next(err);
  }
};

/**
 * Bulk Candidate Import from Excel/CSV
 * POST /api/v1/candidates/bulk-import
 * POST /api/v1/candidates/bulk-import-validate
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

    // 5MB file size limit enforcement
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      sendError(res, 'File size exceeds the 5MB limit. Please upload a smaller file.', 400);
      return;
    }

    const isDryRun = req.body?.dryRun === true || req.body?.dryRun === 'true' || req.query?.dryRun === 'true';
    const defaultSource = sanitizeCellValue(req.body?.source || 'Bulk Import');
    const userRole = (req.user as any)?.role;
    const isRecruiter = userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER';
    const currentUserId = (req.user as any)?.id || null;

    // Recruiter role ownership backend enforcement:
    // If recruiter imports, every candidate is strictly owned by the logged-in recruiter
    let targetRecruiterId: string | null = null;
    if (isRecruiter) {
      targetRecruiterId = currentUserId;
    } else if (req.body?.assignedRecruiterId) {
      targetRecruiterId = String(req.body.assignedRecruiterId).trim() || null;
    }

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

    // Maximum 2,000 rows limit enforcement
    const MAX_ROW_LIMIT = 2000;
    if (rawRows.length > MAX_ROW_LIMIT) {
      sendError(res, `Spreadsheet exceeds maximum allowed limit of ${MAX_ROW_LIMIT} rows per import batch.`, 400);
      return;
    }

    // 2. Validate sheet headers against canonical format
    const firstRowKeys = Object.keys(rawRows[0] || {});
    const normalizedSheetHeaders = firstRowKeys.map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));

    const hasFullName = normalizedSheetHeaders.some(h => ['fullname', 'name', 'candidatename'].includes(h));
    const hasPhone = normalizedSheetHeaders.some(h => ['phone', 'mobile', 'phonenumber', 'contact', 'mobilenumber', 'contactnumber'].includes(h));

    if (!hasFullName || !hasPhone) {
      sendError(
        res,
        "Spreadsheet headers do not match template: Required columns 'Full Name' and 'Phone' were not found. Please use the standard template.",
        400
      );
      return;
    }

    // Normalization map for headers
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

      const fullName = (rowNormalized.fullName || '').trim();
      const rawPhone = rowNormalized.phone || '';
      const rawEmail = (rowNormalized.email || '').toLowerCase().trim();

      // Skip template example row if user uploaded template without removing row 2
      if (fullName.includes('(Example Row') || fullName.includes('(EXAMPLE')) {
        continue;
      }

      // Required: Full Name
      if (!fullName) {
        errors.push('Full Name is required.');
      }

      // Required: Phone (normalized 10-digit Indian mobile, scientific notation protected)
      const { phone: normalizedPhone, isValid: isPhoneValid, error: phoneError } = normalizePhoneNumber(rawPhone);
      if (!isPhoneValid) {
        errors.push(phoneError || `Invalid phone number '${rawPhone}'. Must be a valid 10-digit Indian mobile number.`);
      }

      // Email validation (optional; if present, validate format)
      const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
      let finalEmail = rawEmail;
      if (rawEmail) {
        if (!emailRegex.test(rawEmail)) {
          errors.push(`Invalid email address '${rawEmail}'.`);
        }
      } else if (isPhoneValid) {
        // Fallback unique email for candidates imported without email
        finalEmail = `bulk.${normalizedPhone}@orricaedge.internal`;
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

      // Gender validation (case-insensitive Male/Female/Other)
      const { gender: parsedGender, error: genderError } = parseGender(rowNormalized.gender);
      if (genderError) {
        errors.push(genderError);
      }

      // Date of Birth validation (ISO, past date, age 18+)
      const { date: dobDate, error: dobError } = parseDateOfBirth(rowNormalized.dateOfBirth);
      if (dobError) {
        errors.push(dobError);
      }

      // Parse experience and numbers safely
      const parseDecimal = (val: any): number | null => {
        if (val === undefined || val === null || val === '') return null;
        const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
        return isNaN(num) ? null : Math.max(0, num);
      };

      const totalExp = parseDecimal(rowNormalized.totalExperience) ?? 0;
      const relExp = parseDecimal(rowNormalized.relevantExperience) ?? 0;

      if (relExp > totalExp) {
        errors.push(`Relevant Experience (${relExp} yrs) cannot exceed Total Experience (${totalExp} yrs).`);
      }

      // Notice period days (integer 0 to 180)
      let parsedNoticeDays: number | null = null;
      if (rowNormalized.noticePeriodDays !== undefined && rowNormalized.noticePeriodDays !== '') {
        const nd = parseInt(String(rowNormalized.noticePeriodDays).trim(), 10);
        if (isNaN(nd) || nd < 0 || nd > 180) {
          errors.push(`Notice Period Days must be an integer between 0 and 180.`);
        } else {
          parsedNoticeDays = nd;
        }
      }

      const currSal = parseDecimal(rowNormalized.currentSalary);
      const expSal = parseDecimal(rowNormalized.expectedSalary);
      const currCtc = parseDecimal(rowNormalized.currentCtc) ?? (currSal ? currSal * 12 : null);
      const expCtc = parseDecimal(rowNormalized.expectedCtc) ?? (expSal ? expSal * 12 : null);

      // Parse arrays (comma-separated, trimmed, deduplicated)
      const parseArray = (str: string): string[] => {
        if (!str) return [];
        const items = str.split(',').map(s => s.trim()).filter(Boolean);
        return Array.from(new Set(items));
      };

      const skillsArr = parseArray(rowNormalized.skills);
      const languagesArr = parseArray(rowNormalized.languages);
      const tagsArr = parseArray(rowNormalized.tags);

      // Validate Resume URL
      let validResumeUrl = '';
      if (rowNormalized.resumeUrl) {
        const urlStr = String(rowNormalized.resumeUrl).trim();
        if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(urlStr)) {
          validResumeUrl = urlStr;
        } else {
          errors.push(`Invalid Resume URL '${urlStr}'. Must start with http:// or https://.`);
        }
      }

      const candidateData = {
        fullName,
        name: fullName,
        phone: normalizedPhone,
        email: finalEmail,
        fatherName: rowNormalized.fatherName ? String(rowNormalized.fatherName).trim() : null,
        dateOfBirth: dobDate,
        gender: parsedGender,
        currentLocation: rowNormalized.location ? String(rowNormalized.location).trim() : '',
        location: rowNormalized.location ? String(rowNormalized.location).trim() : '',
        preferredLocation: rowNormalized.preferredLocation ? String(rowNormalized.preferredLocation).trim() : null,
        totalExperience: totalExp,
        relevantExperience: relExp,
        experienceYears: totalExp,
        highestQualification: rowNormalized.highestQualification || rowNormalized.education || null,
        education: rowNormalized.education || rowNormalized.highestQualification || null,
        currentCompany: rowNormalized.currentCompany ? String(rowNormalized.currentCompany).trim() : null,
        currentDesignation: rowNormalized.currentDesignation ? String(rowNormalized.currentDesignation).trim() : null,
        previousCompany: rowNormalized.previousCompany ? String(rowNormalized.previousCompany).trim() : null,
        noticePeriod: rowNormalized.noticePeriod || (parsedNoticeDays !== null ? `${parsedNoticeDays} Days` : null),
        noticePeriodDays: parsedNoticeDays,
        currentSalary: currSal,
        expectedSalary: expSal,
        currentCtc: currCtc,
        expectedCtc: expCtc,
        skills: skillsArr,
        languages: languagesArr.length > 0 ? languagesArr : ['English', 'Hindi'],
        resumeUrl: validResumeUrl,
        source: rowNormalized.source || defaultSource,
        tags: tagsArr,
        notes: rowNormalized.notes ? String(rowNormalized.notes).trim() : null,
        status: 'New',
        ownerRecruiterId: targetRecruiterId || undefined,
        assignedRecruiterId: targetRecruiterId || undefined,
        assignedRecruiterIds: targetRecruiterId ? [targetRecruiterId] : [],
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

    // 4. Second pass: Query existing candidates to detect duplicates in DB
    const existingDbCandidates = await prisma.candidate.findMany({
      where: {
        OR: [
          { phone: { in: Array.from(candidatePhonesForDbCheck) } },
          ...(candidateEmailsForDbCheck.size > 0
            ? [{ email: { in: Array.from(candidateEmailsForDbCheck) } }]
            : []),
        ],
      },
      select: {
        id: true,
        candidateCode: true,
        phone: true,
        email: true,
        fullName: true,
        name: true,
      },
    });

    const phoneToCandidateMap = new Map<string, any>();
    const emailToCandidateMap = new Map<string, any>();

    for (const ec of existingDbCandidates) {
      if (ec.phone) phoneToCandidateMap.set(ec.phone, ec);
      if (ec.email) emailToCandidateMap.set(ec.email.toLowerCase(), ec);
    }

    const errorReport: { row: number; candidateName: string; phone: string; email: string; reason: string }[] = [];
    const validRowsToInsert: ProcessedRow[] = [];
    let duplicateSheetCount = 0;
    let duplicateDbCount = 0;
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

      // Check DB duplicates by phone or email:
      // STRICT POLICY: SKIP and REPORT; NEVER OVERWRITE existing records
      const matchedByPhone = phoneToCandidateMap.get(row.data.phone);
      const matchedByEmail = row.data.email ? emailToCandidateMap.get(row.data.email) : null;
      const matchedExisting = matchedByPhone || matchedByEmail;

      if (matchedExisting) {
        duplicateDbCount++;
        errorReport.push({
          row: row.rowNumber,
          candidateName: row.data.fullName,
          phone: row.data.phone,
          email: row.data.email,
          reason: `Duplicate candidate skipped: ${matchedByPhone ? 'Phone' : 'Email'} already exists in database (matched Candidate: ${matchedExisting.candidateCode} - ${matchedExisting.fullName || matchedExisting.name}).`,
        });
        continue;
      }

      // Row is completely valid and not duplicate: ready for atomic insert
      validRowsToInsert.push(row);
    }

    const totalDuplicates = duplicateSheetCount + duplicateDbCount;

    // 5. If dryRun is requested (or /bulk-import-validate), return preview analysis without writing to DB
    if (isDryRun) {
      sendSuccess(
        res,
        {
          isDryRun: true,
          totalRows: processedRows.length,
          validCount: validRowsToInsert.length,
          createdCount: validRowsToInsert.length,
          importedCount: validRowsToInsert.length,
          updatedCount: 0,
          matchedCount: 0,
          duplicateCount: totalDuplicates,
          duplicateSheetCount,
          duplicateDbCount,
          skippedCount: totalDuplicates,
          conflictCount: 0,
          invalidCount: invalidFieldCount,
          failedCount: errorReport.length,
          previewRows: validRowsToInsert.slice(0, 10).map((r) => ({
            row: r.rowNumber,
            name: r.data.fullName,
            phone: r.data.phone,
            email: r.data.email,
            location: r.data.location,
            totalExperience: r.data.totalExperience,
            currentCompany: r.data.currentCompany,
            status: 'Valid',
          })),
          errors: errorReport.slice(0, 200),
        },
        'Spreadsheet validation completed successfully.'
      );
      return;
    }

    // 6. Execute atomic batch operations in transactions (batches of 50)
    const insertedCodes: string[] = [];
    const CHUNK_SIZE = 50;

    if (validRowsToInsert.length > 0) {
      const candidateCodes = await generateCandidateCodesBatch(validRowsToInsert.length);

      for (let i = 0; i < validRowsToInsert.length; i += CHUNK_SIZE) {
        const chunk = validRowsToInsert.slice(i, i + CHUNK_SIZE);
        const codesChunk = candidateCodes.slice(i, i + CHUNK_SIZE);

        await prisma.$transaction(async (tx) => {
          for (let j = 0; j < chunk.length; j++) {
            const rowItem = chunk[j];
            const code = codesChunk[j];
            const dataToInsert = rowItem.data;

            const tagsWithRecruiter = targetRecruiterId
              ? Array.from(new Set([...dataToInsert.tags, `assignedRecruiter:${targetRecruiterId}`]))
              : dataToInsert.tags;

            const created = await tx.candidate.create({
              data: {
                ...dataToInsert,
                candidateCode: code,
                tags: tagsWithRecruiter,
                source: dataToInsert.source || 'Bulk Import',
              },
              select: { id: true, candidateCode: true },
            });

            insertedCodes.push(created.candidateCode);

            try {
              await logCandidateTimeline({
                candidateId: created.id,
                userId: currentUserId || null,
                userName: (req.user as any)?.email,
                userRole: (req.user as any)?.role,
                action: 'Candidate Imported',
                newStatus: 'New',
                remarks: `Candidate profile created (${created.candidateCode}) via Bulk Import by ${(req.user as any)?.email || 'User'}`,
                client: tx,
              });
            } catch {}
          }
        });
      }
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
          role: userRole,
          ownerRecruiterId: targetRecruiterId,
        },
      });
    } catch {}

    sendSuccess(
      res,
      {
        totalProcessed: processedRows.length,
        totalRows: processedRows.length,
        createdCount: insertedCodes.length,
        importedCount: insertedCodes.length,
        updatedCount: 0,
        skippedCount: totalDuplicates,
        duplicateCount: totalDuplicates,
        failedCount: invalidFieldCount,
        generatedCodes: insertedCodes,
        errors: errorReport,
        message: `Bulk candidate import completed: ${insertedCodes.length} imported, ${totalDuplicates} duplicates skipped, ${invalidFieldCount} invalid rows failed.`,
      },
      'Bulk candidate import processed successfully.'
    );
  } catch (err) {
    next(err);
  }
};


export const assignJobToCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const { jobId, stage, status, notes } = req.body;

    if (!jobId) {
      sendError(res, 'Job ID is required', 400);
      return;
    }

    if (!(await canAccessCandidate(req, identifier))) {
      sendError(res, 'Candidate not found or access denied', 404);
      return;
    }

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [{ id: identifier }, { candidateCode: identifier }],
      },
      include: {
        ownerRecruiter: { select: { id: true, fullName: true, email: true } },
      },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, jobCode: true, title: true, department: true, location: true, client: { select: { companyName: true } } },
    });

    if (!job) {
      sendError(res, 'Job not found', 404);
      return;
    }

    const currentUserId = req.user?.userId;
    const userRole = req.user?.role || 'ADMIN';
    const userEmail = req.user?.email || 'User';

    let application = await prisma.application.findUnique({
      where: {
        jobId_candidateId: {
          jobId: job.id,
          candidateId: candidate.id,
        },
      },
    });

    let isNewApplication = false;

    if (application) {
      const updatedNotes = notes
        ? [...((Array.isArray(application.internalNotes) ? (application.internalNotes as any[]) : [])), { text: notes, by: userEmail, at: new Date().toISOString() }]
        : application.internalNotes;

      application = await prisma.application.update({
        where: { id: application.id },
        data: {
          stage: (stage as any) || application.stage,
          status: status || application.status,
          internalNotes: updatedNotes as any,
        },
      });
    } else {
      isNewApplication = true;
      const applicationCode = await generateApplicationCode(prisma);
      const recruiterId = candidate.ownerRecruiterId || (['RECRUITER', 'FREELANCE_RECRUITER'].includes(userRole) ? currentUserId : null);
      const teamLeaderId = candidate.teamLeaderId || null;

      application = await prisma.application.create({
        data: {
          applicationCode,
          jobId: job.id,
          candidateId: candidate.id,
          recruiterId,
          teamLeaderId,
          stage: (stage as any) || 'APPLIED',
          status: status || 'Submitted',
          internalNotes: notes ? [{ text: notes, by: userEmail, at: new Date().toISOString() }] : [],
        },
      });
    }

    if (candidate.status === 'New') {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { status: 'Submitted' },
      });
    }

    try {
      await logCandidateTimeline({
        candidateId: candidate.id,
        applicationId: application.id,
        userId: currentUserId || null,
        userName: userEmail,
        userRole: userRole,
        action: isNewApplication ? 'Job Assigned' : 'Job Application Updated',
        previousStatus: candidate.status,
        newStatus: candidate.status === 'New' ? 'Submitted' : candidate.status,
        remarks: (isNewApplication ? 'Assigned' : 'Updated assignment') + ' to job "' + job.title + '" (' + (job.jobCode || job.id) + ')' + (notes ? ' - ' + notes : ''),
      });
    } catch {}

    try {
      await prisma.candidateActivity.create({
        data: {
          candidateId: candidate.id,
          jobId: job.id,
          applicationId: application.id,
          userId: currentUserId || null,
          recruiterId: candidate.ownerRecruiterId || (['RECRUITER', 'FREELANCE_RECRUITER'].includes(userRole) ? currentUserId : null),
          action: 'JOB_ASSIGNED',
          notes: 'Assigned to job: ' + job.title,
          metadata: {
            jobId: job.id,
            jobTitle: job.title,
            jobCode: job.jobCode,
            applicationCode: application.applicationCode,
            isNewApplication,
            assignedBy: userEmail,
          },
        },
      });
    } catch {}

    try {
      await logAudit({
        userId: currentUserId,
        action: 'JOB_ASSIGNED',
        module: 'CANDIDATES',
        entity: 'Candidate',
        entityId: candidate.id,
        newValue: {
          candidateId: candidate.id,
          candidateName: candidate.fullName,
          candidateCode: candidate.candidateCode,
          jobId: job.id,
          jobTitle: job.title,
          jobCode: job.jobCode,
          applicationId: application.id,
          applicationCode: application.applicationCode,
          isNewApplication,
        },
      });
    } catch {}

    sendSuccess(res, {
      application,
      job,
      candidate: {
        id: candidate.id,
        candidateCode: candidate.candidateCode,
        fullName: candidate.fullName,
      },
      message: 'Candidate ' + candidate.fullName + ' successfully assigned to job "' + job.title + '".',
    });
  } catch (err) {
    next(err);
  }
};

export const bulkAssignJobToCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { candidateIds, jobId, stage, status, notes } = req.body;

    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      sendError(res, 'candidateIds array is required and must not be empty', 400);
      return;
    }

    if (!jobId) {
      sendError(res, 'jobId is required', 400);
      return;
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, jobCode: true, title: true, department: true },
    });

    if (!job) {
      sendError(res, 'Job not found', 404);
      return;
    }

    const currentUserId = req.user?.userId;
    const userRole = req.user?.role || 'ADMIN';
    const userEmail = req.user?.email || 'User';

    const candidates = await prisma.candidate.findMany({
      where: {
        OR: [
          { id: { in: candidateIds } },
          { candidateCode: { in: candidateIds } },
        ],
      },
      select: {
        id: true,
        candidateCode: true,
        fullName: true,
        status: true,
        ownerRecruiterId: true,
        teamLeaderId: true,
      },
    });

    let assignedCount = 0;
    let updatedCount = 0;
    const errors = [];

    for (const cand of candidates) {
      try {
        if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
          const hasAccess = await canAccessCandidate(req, cand.id);
          if (!hasAccess) {
            errors.push({ candidateId: cand.id, error: 'Access denied' });
            continue;
          }
        }

        const existingApp = await prisma.application.findUnique({
          where: {
            jobId_candidateId: {
              jobId: job.id,
              candidateId: cand.id,
            },
          },
        });

        if (existingApp) {
          if (stage || status || notes) {
            const updatedNotes = notes
              ? [...((Array.isArray(existingApp.internalNotes) ? (existingApp.internalNotes as any[]) : [])), { text: notes, by: userEmail, at: new Date().toISOString() }]
              : existingApp.internalNotes;

            await prisma.application.update({
              where: { id: existingApp.id },
              data: {
                stage: (stage as any) || existingApp.stage,
                status: status || existingApp.status,
                internalNotes: updatedNotes as any,
              },
            });
          }
          updatedCount++;
        } else {
          const applicationCode = await generateApplicationCode(prisma);
          const recruiterId = cand.ownerRecruiterId || (['RECRUITER', 'FREELANCE_RECRUITER'].includes(userRole) ? currentUserId : null);
          const teamLeaderId = cand.teamLeaderId || null;

          const newApp = await prisma.application.create({
            data: {
              applicationCode,
              jobId: job.id,
              candidateId: cand.id,
              recruiterId,
              teamLeaderId,
              stage: (stage as any) || 'APPLIED',
              status: status || 'Submitted',
              internalNotes: notes ? [{ text: notes, by: userEmail, at: new Date().toISOString() }] : [],
            },
          });

          if (cand.status === 'New') {
            await prisma.candidate.update({
              where: { id: cand.id },
              data: { status: 'Submitted' },
            });
          }

          try {
            await logCandidateTimeline({
              candidateId: cand.id,
              applicationId: newApp.id,
              userId: currentUserId || null,
              userName: userEmail,
              userRole: userRole,
              action: 'Job Assigned',
              previousStatus: cand.status,
              newStatus: cand.status === 'New' ? 'Submitted' : cand.status,
              remarks: 'Assigned to job "' + job.title + '" (' + (job.jobCode || job.id) + ')' + (notes ? ' - ' + notes : ''),
            });
          } catch {}

          try {
            await prisma.candidateActivity.create({
              data: {
                candidateId: cand.id,
                jobId: job.id,
                applicationId: newApp.id,
                userId: currentUserId || null,
                recruiterId: cand.ownerRecruiterId || (['RECRUITER', 'FREELANCE_RECRUITER'].includes(userRole) ? currentUserId : null),
                action: 'JOB_ASSIGNED',
                notes: 'Assigned to job: ' + job.title,
                metadata: {
                  jobId: job.id,
                  jobTitle: job.title,
                  jobCode: job.jobCode,
                  applicationCode: newApp.applicationCode,
                  assignedBy: userEmail,
                },
              },
            });
          } catch {}

          assignedCount++;
        }
      } catch (err: any) {
        errors.push({ candidateId: cand.id, error: err.message || 'Failed to assign' });
      }
    }

    try {
      await logAudit({
        userId: currentUserId,
        action: 'BULK_JOB_ASSIGNED',
        module: 'CANDIDATES',
        entity: 'Candidate',
        entityId: 'batch-' + Date.now(),
        newValue: {
          jobId: job.id,
          jobTitle: job.title,
          jobCode: job.jobCode,
          assignedCount,
          updatedCount,
          totalCandidates: candidateIds.length,
        },
      });
    } catch {}

    sendSuccess(res, {
      job,
      totalRequested: candidateIds.length,
      assignedCount,
      updatedCount,
      errors,
      message: 'Assigned ' + assignedCount + ' candidates and updated ' + updatedCount + ' candidates for job "' + job.title + '".',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Manual Archive Candidate: POST /api/v1/candidates/:id/archive
 * Soft-archives candidate, preserves previousStatus and full candidate history/audit.
 */
export const archiveCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const { reason } = req.body || {};

    if (!identifier) {
      sendError(res, 'Candidate ID is required.', 400);
      return;
    }

    if (!(await canAccessCandidate(req, identifier))) {
      sendError(res, 'Candidate not found or access denied', 404);
      return;
    }

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [{ id: identifier }, { candidateCode: identifier }],
      },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (candidate.isArchived) {
      sendError(res, 'Candidate is already archived.', 400);
      return;
    }

    const archivedAt = new Date();
    const userId = req.user?.userId || null;
    const userEmail = req.user?.email || 'User';
    const cleanReason = reason ? String(reason).trim() : null;

    const updated = await prisma.$transaction(async (tx) => {
      const updatedCandidate = await tx.candidate.update({
        where: { id: candidate.id },
        data: {
          isArchived: true,
          archivedAt,
          archivedById: userId,
          archiveReason: cleanReason,
          previousStatus: candidate.status,
        },
        include: {
          archivedBy: { select: { id: true, fullName: true, email: true, role: true } },
          ownerRecruiter: { select: { id: true, fullName: true, email: true } },
          sourcingRecruiter: { select: { id: true, fullName: true, email: true } },
          applications: {
            include: {
              job: { select: { id: true, title: true, jobCode: true, department: true } },
            },
          },
        },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: candidate.id,
          userId,
          recruiterId: candidate.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? userId : null),
          action: 'CANDIDATE_ARCHIVED',
          notes: cleanReason || 'Candidate archived manually',
          metadata: {
            previousStatus: candidate.status,
            reason: cleanReason,
            archivedAt: archivedAt.toISOString(),
            archivedByEmail: userEmail,
          },
        },
      });

      await logCandidateTimeline({
        candidateId: candidate.id,
        userId,
        userName: userEmail,
        userRole: req.user?.role,
        action: 'Candidate Archived',
        previousStatus: candidate.status,
        newStatus: candidate.status,
        remarks: `Candidate archived manually: ${cleanReason || 'Administrative archive'}`,
        client: tx,
      });

      return updatedCandidate;
    });

    await logAudit({
      req,
      userId: req.user?.userId,
      action: 'ARCHIVE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: candidate.id,
      details: {
        candidateCode: candidate.candidateCode,
        fullName: candidate.fullName,
        previousStatus: candidate.status,
        reason: cleanReason,
      },
    });

    sendSuccess(res, updated, 'Candidate archived successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Bulk Archive Candidates: POST /api/v1/candidates/bulk-archive
 * Archives multiple candidates with partial failure tracking and safe audit logging.
 */
export const bulkArchiveCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { candidateIds, reason } = req.body || {};

    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      sendError(res, 'candidateIds array is required and cannot be empty.', 400);
      return;
    }

    if (candidateIds.length > 200) {
      sendError(res, 'Cannot archive more than 200 candidates at once.', 400);
      return;
    }

    const userId = req.user?.userId || null;
    const userEmail = req.user?.email || 'User';
    const cleanReason = reason ? String(reason).trim() : null;

    const successfulIds: string[] = [];
    const failedRecords: { id: string; reason: string }[] = [];

    for (const rawId of candidateIds) {
      const id = String(rawId).trim();
      if (!id) continue;

      try {
        const hasAccess = await canAccessCandidate(req, id);
        if (!hasAccess) {
          failedRecords.push({ id, reason: 'Access denied or candidate not found' });
          continue;
        }

        const candidate = await prisma.candidate.findFirst({
          where: {
            OR: [{ id }, { candidateCode: id }],
          },
        });

        if (!candidate) {
          failedRecords.push({ id, reason: 'Candidate not found' });
          continue;
        }

        if (candidate.isArchived) {
          failedRecords.push({ id: candidate.id, reason: 'Candidate is already archived' });
          continue;
        }

        const archivedAt = new Date();
        await prisma.$transaction(async (tx) => {
          await tx.candidate.update({
            where: { id: candidate.id },
            data: {
              isArchived: true,
              archivedAt,
              archivedById: userId,
              archiveReason: cleanReason,
              previousStatus: candidate.status,
            },
          });

          await tx.candidateActivity.create({
            data: {
              candidateId: candidate.id,
              userId,
              recruiterId: candidate.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? userId : null),
              action: 'CANDIDATE_ARCHIVED',
              notes: cleanReason || 'Candidate archived via bulk action',
              metadata: {
                previousStatus: candidate.status,
                reason: cleanReason,
                archivedAt: archivedAt.toISOString(),
                archivedByEmail: userEmail,
                isBulk: true,
              },
            },
          });

          await logCandidateTimeline({
            candidateId: candidate.id,
            userId,
            userName: userEmail,
            userRole: req.user?.role,
            action: 'Candidate Archived',
            previousStatus: candidate.status,
            newStatus: candidate.status,
            remarks: `Candidate archived in bulk: ${cleanReason || 'Administrative archive'}`,
            client: tx,
          });
        });

        successfulIds.push(candidate.id);
      } catch (err: any) {
        failedRecords.push({ id, reason: err?.message || 'Unexpected error' });
      }
    }

    if (successfulIds.length > 0) {
      await logAudit({
        req,
        userId: req.user?.userId,
        action: 'BULK_ARCHIVE_CANDIDATES',
        module: 'CANDIDATES',
        entity: 'Candidate',
        entityId: 'BULK',
        details: {
          successfulCount: successfulIds.length,
          failureCount: failedRecords.length,
          successfulIds,
          reason: cleanReason,
        },
      });
    }

    sendSuccess(res, {
      totalRequested: candidateIds.length,
      successfulCount: successfulIds.length,
      failureCount: failedRecords.length,
      successfulIds,
      failedRecords,
    }, `Archived ${successfulIds.length} candidate(s)${failedRecords.length > 0 ? `, ${failedRecords.length} failed` : ''}.`);
  } catch (err) {
    next(err);
  }
};

/**
 * Manual Restore Candidate: POST /api/v1/candidates/:id/restore
 * Restores candidate back to their previous workflow status, updating original record without duplication.
 */
export const restoreCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;

    if (!identifier) {
      sendError(res, 'Candidate ID is required.', 400);
      return;
    }

    if (!(await canAccessCandidate(req, identifier))) {
      sendError(res, 'Candidate not found or access denied', 404);
      return;
    }

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [{ id: identifier }, { candidateCode: identifier }],
      },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (!candidate.isArchived) {
      sendError(res, 'Candidate is not archived.', 400);
      return;
    }

    const userId = req.user?.userId || null;
    const userEmail = req.user?.email || 'User';
    const restoredStatus = candidate.previousStatus || 'New';

    const updated = await prisma.$transaction(async (tx) => {
      const restoredCandidate = await tx.candidate.update({
        where: { id: candidate.id },
        data: {
          isArchived: false,
          archivedAt: null,
          archivedById: null,
          archiveReason: null,
          status: restoredStatus,
          previousStatus: null,
        },
        include: {
          ownerRecruiter: { select: { id: true, fullName: true, email: true } },
          sourcingRecruiter: { select: { id: true, fullName: true, email: true } },
          applications: {
            include: {
              job: { select: { id: true, title: true, jobCode: true, department: true } },
            },
          },
        },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: candidate.id,
          userId,
          recruiterId: candidate.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? userId : null),
          action: 'CANDIDATE_RESTORED',
          notes: `Candidate restored to active pipeline at status: ${restoredStatus}`,
          metadata: {
            restoredFromStatus: candidate.status,
            restoredToStatus: restoredStatus,
            restoredAt: new Date().toISOString(),
            restoredByEmail: userEmail,
          },
        },
      });

      await logCandidateTimeline({
        candidateId: candidate.id,
        userId,
        userName: userEmail,
        userRole: req.user?.role,
        action: 'Candidate Restored',
        previousStatus: 'Archived',
        newStatus: restoredStatus,
        remarks: `Candidate restored from archive to ${restoredStatus} by ${userEmail}`,
        client: tx,
      });

      return restoredCandidate;
    });

    await logAudit({
      req,
      userId: req.user?.userId,
      action: 'RESTORE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: candidate.id,
      details: {
        candidateCode: candidate.candidateCode,
        fullName: candidate.fullName,
        restoredToStatus: restoredStatus,
      },
    });

    sendSuccess(res, updated, `Candidate restored to ${restoredStatus} successfully.`);
  } catch (err) {
    next(err);
  }
};

/**
 * Get Archived Candidates Count: GET /api/v1/candidates/archived/count
 * Returns real persisted count of archived candidates scoped to user RBAC.
 */
export const getArchivedCandidatesCount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;
    const andFilters: any[] = [{ isArchived: true }];

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

    const count = await prisma.candidate.count({
      where: { AND: andFilters },
    });

    sendSuccess(res, { count }, 'Archived candidates count retrieved successfully.');
  } catch (err) {
    next(err);
  }
};
