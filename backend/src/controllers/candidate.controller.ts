import { computeWorkingDays, normalizeClientName, validateSelectionDates } from '../utils/workingDays';
import { maskCandidateForRole, maskCandidatesListForRole, maskPhone, maskEmail } from '../utils/masking';
import { buildSubAdminCandidateFilter } from '../utils/subAdminScoping';
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
import {
  PIPELINE_STAGES,
  PipelineStage,
  PIPELINE_STAGE_SET,
  OPERATIONAL_STATUSES,
  OperationalStatus,
  OPERATIONAL_STATUS_SET,
  resolvePipelineStage,
  resolveOperationalStatus,
  deriveStatus,
  statusRules,
  isTerminal,
  OFFICIAL_10_PIPELINE_STATUSES,
  OfficialPipelineStatus,
} from '../shared/candidateStatusConfig';
import {
  applyCandidateStatusChange,
  bulkCandidateStatusChange,
} from '../services/candidateStatus.service';
import { normalizeIndianPhone, formatIndianPhone, isValidIndianPhone } from '../utils/phone';
import { findDuplicateCandidate } from '../services/duplicateCandidate.service';

export {
  PIPELINE_STAGES,
  PipelineStage,
  PIPELINE_STAGE_SET,
  OPERATIONAL_STATUSES,
  OperationalStatus,
  OPERATIONAL_STATUS_SET,
  resolvePipelineStage,
  resolveOperationalStatus,
  deriveStatus,
  statusRules,
  isTerminal,
  OFFICIAL_10_PIPELINE_STATUSES,
  OfficialPipelineStatus,
};

export const CANONICAL_PIPELINE_STAGES = [
  ...OFFICIAL_10_PIPELINE_STATUSES,
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
    'not called': 'Not Called',
    'Not Called': 'Not Called',
    'not reachable': 'Not Reachable',
    'Not Reachable': 'Not Reachable',
    'wrong number': 'Wrong Number',
    'Wrong Number': 'Wrong Number',
    'do not call': 'Do Not Call',
    'Do Not Call': 'Do Not Call',
    'callback requested': 'Callback Requested',
    'Callback Requested': 'Callback Requested',
    'No Response': 'No Response',
    'callback scheduled': 'Callback Scheduled',
    'Callback Scheduled': 'Callback Scheduled',
    'on hold – after 7 days': 'On Hold – After 7 Days',
    'on hold - after 7 days': 'On Hold – After 7 Days',
    'On Hold – After 7 Days': 'On Hold – After 7 Days',
    'screening – under evaluation': 'Screening – Under Evaluation',
    'screening - under evaluation': 'Screening – Under Evaluation',
    'Screening – Under Evaluation': 'Screening – Under Evaluation',
    'shortlisted by recruiter': 'Shortlisted by Recruiter',
    'Shortlisted by Recruiter': 'Shortlisted by Recruiter',
    'ready to go – walk-in scheduled': 'Ready to Go – Walk-in Scheduled',
    'ready to go - walk-in scheduled': 'Ready to Go – Walk-in Scheduled',
    'Ready to Go – Walk-in Scheduled': 'Ready to Go – Walk-in Scheduled',
    'client select': 'Client Select',
    'Client Select': 'Client Select',
    'onboarding under process': 'Onboarding Under Process',
    'Onboarding Under Process': 'Onboarding Under Process',
    'joined – winning option': 'Joined – Winning Option',
    'joined - winning option': 'Joined – Winning Option',
    'Joined – Winning Option': 'Joined – Winning Option',
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
  resumeUrl: z.string().max(2000).optional().or(z.literal('')),
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
  operationalStatus: z.string().trim().max(64).nullable().optional(),
  pipelineStage: z.string().trim().max(64).nullable().optional(),
  stage: z.string().optional(),
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
  operationalStatus: z.string().trim().max(64).nullable().optional(),
  sourceActivity: z.string().optional(),
  pipelineStage: z.string().optional(),
  stage: z.string().optional(),
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
export const canAccessCandidate = async (req: Request, candidateIdentifier: string): Promise<boolean> => {
  const user = req.user;
  if (!user) return false;
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return true;

  const candidateIdFilter = [
    { id: candidateIdentifier },
    { candidateCode: candidateIdentifier },
  ];

  if (user.role === 'SUB_ADMIN') {
    const subAdminFilter = await buildSubAdminCandidateFilter(user.userId);
    const accessible = await prisma.candidate.findFirst({
      where: {
        OR: candidateIdFilter,
        AND: [subAdminFilter],
      },
      select: { id: true },
    });
    return !!accessible;
  }

  if (user.role === 'TEAM_LEADER') {
    const podRecruiters = await prisma.user.findMany({
      where: { teamLeaderId: user.userId },
      select: { id: true, recruiterId: true },
    });
    const podRecruiterIds = podRecruiters.flatMap((r) => [r.id, r.recruiterId].filter(Boolean) as string[]);
    podRecruiterIds.push(user.userId);

    const conditions: any[] = [
      { teamLeaderId: user.userId },
      { sourcingRecruiter: { teamLeaderId: user.userId } },
      { ownerRecruiter: { teamLeaderId: user.userId } },
      { sourcingRecruiterId: { in: podRecruiterIds } },
      { ownerRecruiterId: { in: podRecruiterIds } },
      { createdById: { in: podRecruiterIds } },
      { applications: { some: { OR: [{ teamLeaderId: user.userId }, { recruiterId: { in: podRecruiterIds } }] } } },
      { assignedRecruiterIds: { hasSome: podRecruiterIds } },
    ];

    const accessible = await prisma.candidate.findFirst({
      where: {
        OR: candidateIdFilter,
        AND: { OR: conditions },
      },
      select: { id: true },
    });
    return Boolean(accessible);
  }

  if (user.role === 'RECRUITER' || user.role === 'FREELANCE_RECRUITER') {
    let rIds = [user.userId];
    try {
      const u = await prisma.user.findUnique({
        where: { id: user.userId },
        select: { id: true, recruiterId: true },
      });
      if (u?.recruiterId) rIds.push(u.recruiterId);
    } catch {
      // non-blocking fallback
    }
    rIds = Array.from(new Set(rIds.filter(Boolean)));

    const conditions: any[] = [];
    for (const rId of rIds) {
      conditions.push(
        { sourcingRecruiterId: rId },
        { ownerRecruiterId: rId },
        { createdById: rId },
        { applications: { some: { recruiterId: rId } } },
        { assignedRecruiterIds: { has: rId } },
        { tags: { has: `assignedRecruiter:${rId}` } }
      );
    }

    const accessibleCandidate = await prisma.candidate.findFirst({
      where: {
        OR: candidateIdFilter,
        AND: { OR: conditions },
      },
      select: { id: true },
    });
    return Boolean(accessibleCandidate);
  }

  return false;
};

/**
 * Enriches candidate records with fully resolved recruiter objects and display names.
 * Ensures multi-recruiter assignments, owner recruiters, and sourcing recruiters are
 * clearly structured for frontend display and selection tracking.
 */
const enrichCandidatesWithRecruiters = async (candidatesList: any[]): Promise<any[]> => {
  if (!Array.isArray(candidatesList) || candidatesList.length === 0) return [];

  const recruiterIdSet = new Set<string>();
  for (const cand of candidatesList) {
    if (!cand) continue;
    if (Array.isArray(cand.assignedRecruiterIds)) {
      for (const rId of cand.assignedRecruiterIds) {
        if (rId && typeof rId === 'string' && rId.trim()) recruiterIdSet.add(rId.trim());
      }
    }
    if (cand.ownerRecruiterId && typeof cand.ownerRecruiterId === 'string' && cand.ownerRecruiterId.trim()) {
      recruiterIdSet.add(cand.ownerRecruiterId.trim());
    }
    if (cand.sourcingRecruiterId && typeof cand.sourcingRecruiterId === 'string' && cand.sourcingRecruiterId.trim()) {
      recruiterIdSet.add(cand.sourcingRecruiterId.trim());
    }
    if (Array.isArray(cand.tags)) {
      for (const tag of cand.tags) {
        if (typeof tag === 'string' && tag.startsWith('assignedRecruiter:')) {
          const id = tag.replace('assignedRecruiter:', '').trim();
          if (id) recruiterIdSet.add(id);
        }
      }
    }
  }

  const recruiterUsers = recruiterIdSet.size > 0
    ? await prisma.user.findMany({
        where: {
          OR: [
            { id: { in: Array.from(recruiterIdSet) } },
            { recruiterId: { in: Array.from(recruiterIdSet) } },
          ],
        },
        select: {
          id: true,
          recruiterId: true,
          fullName: true,
          email: true,
          role: true,
          recruiterType: true,
        },
      })
    : [];

  const recruiterMap = new Map<string, { id: string; recruiterId?: string | null; name: string; fullName: string; email?: string }>();
  for (const u of recruiterUsers) {
    const recObj = {
      id: u.id,
      recruiterId: u.recruiterId,
      name: u.fullName || u.email || 'Recruiter',
      fullName: u.fullName || u.email || 'Recruiter',
      email: u.email,
    };
    if (u.id) recruiterMap.set(u.id.toLowerCase(), recObj);
    if (u.recruiterId) recruiterMap.set(u.recruiterId.toLowerCase(), recObj);
  }

  return candidatesList.map((cand) => {
    if (!cand) return cand;
    const assignedList: Array<{ id: string; recruiterId?: string | null; name: string; fullName: string; email?: string }> = [];
    const seenIds = new Set<string>();

    const addRec = (r: { id: string; recruiterId?: string | null; name?: string; fullName?: string; email?: string } | null | undefined) => {
      if (!r || !r.id) return;
      const key = r.id.toLowerCase();
      if (!seenIds.has(key)) {
        seenIds.add(key);
        assignedList.push({
          id: r.id,
          recruiterId: r.recruiterId || null,
          name: r.fullName || r.name || 'Recruiter',
          fullName: r.fullName || r.name || 'Recruiter',
          email: r.email,
        });
      }
    };

    // 1. Check assignedRecruiterIds
    if (Array.isArray(cand.assignedRecruiterIds)) {
      for (const rId of cand.assignedRecruiterIds) {
        if (!rId) continue;
        const found = recruiterMap.get(String(rId).toLowerCase());
        if (found) addRec(found);
        else addRec({ id: String(rId), name: String(rId) });
      }
    }

    // 2. Check tags: assignedRecruiter:...
    if (Array.isArray(cand.tags)) {
      for (const tag of cand.tags) {
        if (typeof tag === 'string' && tag.startsWith('assignedRecruiter:')) {
          const id = tag.replace('assignedRecruiter:', '').trim();
          const found = recruiterMap.get(id.toLowerCase());
          if (found) addRec(found);
        }
      }
    }

    // 3. Check ownerRecruiter
    if (cand.ownerRecruiter) {
      addRec({
        id: cand.ownerRecruiter.id,
        recruiterId: cand.ownerRecruiter.recruiterId,
        name: cand.ownerRecruiter.fullName,
        fullName: cand.ownerRecruiter.fullName,
        email: cand.ownerRecruiter.email,
      });
    } else if (cand.ownerRecruiterId) {
      const found = recruiterMap.get(String(cand.ownerRecruiterId).toLowerCase());
      if (found) addRec(found);
    }

    // 4. Check sourcingRecruiter
    if (cand.sourcingRecruiter) {
      addRec({
        id: cand.sourcingRecruiter.id,
        recruiterId: cand.sourcingRecruiter.recruiterId,
        name: cand.sourcingRecruiter.fullName,
        fullName: cand.sourcingRecruiter.fullName,
        email: cand.sourcingRecruiter.email,
      });
    } else if (cand.sourcingRecruiterId) {
      const found = recruiterMap.get(String(cand.sourcingRecruiterId).toLowerCase());
      if (found) addRec(found);
    }

    // 5. Check applications
    if (Array.isArray(cand.applications)) {
      for (const app of cand.applications) {
        if (app?.recruiter) {
          addRec({
            id: app.recruiter.id,
            recruiterId: app.recruiter.recruiterId,
            name: app.recruiter.fullName,
            fullName: app.recruiter.fullName,
            email: app.recruiter.email,
          });
        }
      }
    }

    // 6. Check createdBy
    if (cand.createdBy && (cand.createdBy.role === 'RECRUITER' || cand.createdBy.role === 'FREELANCE_RECRUITER')) {
      addRec({
        id: cand.createdBy.id,
        recruiterId: cand.createdBy.recruiterId,
        name: cand.createdBy.fullName,
        fullName: cand.createdBy.fullName,
        email: cand.createdBy.email,
      });
    }

    const primaryRecruiter = assignedList[0];
    const combinedNames = assignedList.map((r) => r.name).join(', ');

    return {
      ...cand,
      assignedRecruiters: assignedList,
      assignedRecruiterIds: assignedList.map((r) => r.id),
      assignedRecruiterName: combinedNames || null,
      assignedRecruiterId: primaryRecruiter?.id || cand.ownerRecruiterId || cand.sourcingRecruiterId || null,
    };
  });
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
    const targetJobId = req.body.targetJobId || req.body.jobId;

    if (!phone && !email) {
      sendError(res, 'At least one of phone or email is required to check for duplicates.', 400);
      return;
    }

    const dupResult = await findDuplicateCandidate({ phone, email, targetJobId });

    if (dupResult.isDuplicate && dupResult.matchedCandidate) {
      const candidate = dupResult.matchedCandidate;
      sendSuccess(res, {
        exists: true,
        isDuplicate: true,
        candidateId: candidate.candidateCode || candidate.id,
        matchedSignal: dupResult.matchedSignal,
        hasAlreadyAppliedToJob: dupResult.hasAlreadyAppliedToJob,
        candidate: {
          id: candidate.id,
          candidateCode: candidate.candidateCode,
          name: candidate.name || candidate.fullName,
          phone: req.user?.role === 'SUB_ADMIN' ? maskPhone(candidate.phone) : candidate.phone,
          email: req.user?.role === 'SUB_ADMIN' ? maskEmail(candidate.email) : candidate.email,
          status: candidate.status,
          operationalStatus: candidate.operationalStatus,
          pipelineStage: candidate.pipelineStage,
          sourcingRecruiterName: candidate.sourcingRecruiterName,
          teamLeaderName: candidate.teamLeaderName,
          assignedRecruiterName: candidate.assignedRecruiterName,
          currentApplication: candidate.currentApplication
            ? {
                jobCode: candidate.currentApplication.jobCode,
                jobTitle: candidate.currentApplication.jobTitle,
                status: candidate.currentApplication.status,
              }
            : null,
        },
      });
      return;
    }

    sendSuccess(res, {
      exists: false,
      isDuplicate: false,
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
      operationalStatus,
      pipelineStage,
      assignmentStatus,
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
      sortBy,
      page = '1',
      limit = '20',
    } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(5000, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const from = parseDate(dateFrom);
    const to = parseDate(dateTo);
    if (to) to.setHours(23, 59, 59, 999);

    const andFilters: any[] = [];
    const SELECTED_STATUSES = [
      'Selected',
      'Joined',
      'SELECTED',
      'JOINED',
      'selected',
      'joined',
      'Selected (Not Joined Yet)',
      'Joining Pending',
      'Joining Scheduled',
    ];

    const isArchivedRequested = String(archived).toLowerCase() === 'true' || String(archived) === '1';
    const isSelectedBucketRequested = String(req.query.selectedBucket).toLowerCase() === 'true';

    if (isArchivedRequested) {
      // 1. ARCHIVE: Archive wins! Shows all candidates with isArchived = true
      andFilters.push({ isArchived: true });
      const archivedAt = buildDateFilter(parseDate(archivedFrom), parseDate(archivedTo));
      if (archivedAt) andFilters.push({ archivedAt });
      if (previousStatus && previousStatus !== 'ALL') andFilters.push({ previousStatus: String(previousStatus) });
    } else if (isSelectedBucketRequested) {
      // 2. SELECTED BUCKET: isArchived is false AND (status in Selected/Joined OR actualJoiningStatus is set OR selectionDate is set)
      andFilters.push({ isArchived: false });
      andFilters.push({
        OR: [
          { status: { in: SELECTED_STATUSES } },
          { actualJoiningStatus: { not: null } },
          { selectionDate: { not: null } },
        ],
      });
    } else {
      // 3. CANDIDATE MASTER DIRECTORY: Retains all active candidates in the system (Single Source of Truth)
      // Master directory shows ALL active candidates (isArchived = false), including Selected/Joined candidates
      andFilters.push({ isArchived: false });

      if (status && status !== 'ALL') {
        const statusStr = String(status).trim();
        if (statusStr.includes(',')) {
          const statuses = statusStr.split(',').map((s) => s.trim()).filter(Boolean);
          andFilters.push({ status: { in: statuses } });
        } else {
          andFilters.push({ status: statusStr });
        }
      }
    }
    
    if (operationalStatus && operationalStatus !== 'ALL') {
      const opStr = String(operationalStatus).trim();
      if (opStr.includes(',')) {
        const opStatuses = opStr.split(',').map((s) => s.trim()).filter(Boolean);
        andFilters.push({
          OR: [
            { operationalStatus: { in: opStatuses } },
            { operationalStatus: null, status: { in: opStatuses } },
          ],
        });
      } else {
        andFilters.push({
          OR: [
            { operationalStatus: opStr },
            { operationalStatus: null, status: opStr },
          ],
        });
      }
    }

    if (pipelineStage && pipelineStage !== 'ALL') {
      const psStr = String(pipelineStage).trim();
      if (psStr.toUpperCase() === 'UNMAPPED') {
        andFilters.push({ pipelineStage: null });
      } else if (psStr.includes(',')) {
        const stages = psStr.split(',').map((s) => s.trim()).filter(Boolean);
        andFilters.push({ pipelineStage: { in: stages } });
      } else {
        andFilters.push({ pipelineStage: psStr });
      }
    }

    if (assignmentStatus && assignmentStatus !== 'ALL') {
      const asStr = String(assignmentStatus).trim().toUpperCase();
      if (asStr === 'UNASSIGNED') {
        andFilters.push({
          ownerRecruiterId: null,
          sourcingRecruiterId: null,
          assignedRecruiterIds: { isEmpty: true },
        });
      } else if (asStr === 'ASSIGNED') {
        andFilters.push({
          OR: [
            { ownerRecruiterId: { not: null } },
            { sourcingRecruiterId: { not: null } },
            { assignedRecruiterIds: { isEmpty: false } },
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

    let recruiterUserIds: string[] = [currentUserId].filter(Boolean) as string[];
    let recUser: any = null;
    if (currentUserId) {
      try {
        recUser = await prisma.user.findUnique({
          where: { id: currentUserId },
          select: { id: true, recruiterId: true, email: true, fullName: true },
        });
        if (recUser?.recruiterId) {
          recruiterUserIds.push(recUser.recruiterId);
        }
        if (recUser?.email) {
          recruiterUserIds.push(recUser.email.toLowerCase());
        }
      } catch (uErr) {
        console.warn('[getCandidates] Failed resolving current user recruiterId:', uErr);
      }
    }
    recruiterUserIds = Array.from(new Set(recruiterUserIds));

    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      const recruiterConditions: any[] = [];
      for (const rId of recruiterUserIds) {
        recruiterConditions.push(
          { sourcingRecruiterId: rId },
          { ownerRecruiterId: rId },
          { createdById: rId },
          { applications: { some: { recruiterId: rId } } },
          { assignedRecruiterIds: { has: rId } },
          { tags: { has: `assignedRecruiter:${rId}` } }
        );
      }
      if (recUser?.fullName) {
        recruiterConditions.push(
          { sourcingRecruiter: { fullName: { contains: recUser.fullName, mode: 'insensitive' } } },
          { ownerRecruiter: { fullName: { contains: recUser.fullName, mode: 'insensitive' } } },
          { createdBy: { fullName: { contains: recUser.fullName, mode: 'insensitive' } } },
          { applications: { some: { recruiter: { fullName: { contains: recUser.fullName, mode: 'insensitive' } } } } }
        );
      }
      andFilters.push({ OR: recruiterConditions });
    } else if (userRole === 'TEAM_LEADER') {
      andFilters.push({
        OR: [
          { teamLeaderId: currentUserId },
          { sourcingRecruiter: { teamLeaderId: currentUserId } },
          { sourcingRecruiterId: currentUserId },
          { ownerRecruiterId: currentUserId },
        ],
      });
    } else if (userRole === 'SUB_ADMIN') {
      const subAdminFilter = await buildSubAdminCandidateFilter(currentUserId || '');
      andFilters.push(subAdminFilter);
    }
    // Admins and Super Admins have global visibility across all candidates.

    const applicationSome: any = {};
    if (recruiterId) {
      const recIdStr = String(recruiterId).trim();
      if (recIdStr.toUpperCase() === 'UNASSIGNED') {
        andFilters.push({
          ownerRecruiterId: null,
          sourcingRecruiterId: null,
          assignedRecruiterIds: { isEmpty: true },
        });
      } else {
      let targetIds = [recIdStr];
      let targetUser: any = null;
      try {
        targetUser = await prisma.user.findFirst({
          where: {
            OR: [
              { id: recIdStr },
              { recruiterId: recIdStr },
            ],
          },
          select: { id: true, recruiterId: true, fullName: true },
        });
        if (targetUser) {
          if (targetUser.id) targetIds.push(targetUser.id);
          if (targetUser.recruiterId) targetIds.push(targetUser.recruiterId);
        }
      } catch (tErr) {
        console.warn('[getCandidates] Failed resolving target recruiterId:', tErr);
      }
      targetIds = Array.from(new Set(targetIds.filter(Boolean)));

      const filterConditions: any[] = [];
      for (const rId of targetIds) {
        filterConditions.push(
          { ownerRecruiterId: rId },
          { sourcingRecruiterId: rId },
          { createdById: rId },
          { applications: { some: { recruiterId: rId } } },
          { assignedRecruiterIds: { has: rId } },
          { tags: { has: `assignedRecruiter:${rId}` } }
        );
      }
      if (targetUser?.fullName) {
        filterConditions.push(
          { sourcingRecruiter: { fullName: { contains: targetUser.fullName, mode: 'insensitive' } } },
          { ownerRecruiter: { fullName: { contains: targetUser.fullName, mode: 'insensitive' } } },
          { createdBy: { fullName: { contains: targetUser.fullName, mode: 'insensitive' } } },
          { applications: { some: { recruiter: { fullName: { contains: targetUser.fullName, mode: 'insensitive' } } } } }
        );
      }
      andFilters.push({ OR: filterConditions });
    }
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
      andFilters.push({
        OR: [
          { walkInStatus: { not: null } },
          { walkInDate: { not: null } },
          { walkInTime: { not: null } },
          { walkInConfirmationStatus: { not: null } },
          { walkInSessionId: { not: null } },
          { venueName: { not: null } },
          { isWalkIn: true },
        ],
      });
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

    let orderBy: any[] = [{ createdAt: 'desc' }, { id: 'desc' }];
    if (isArchivedRequested) {
      if (sortBy === 'archived_asc') {
        orderBy = [{ archivedAt: 'asc' }, { id: 'asc' }];
      } else if (sortBy === 'name_asc') {
        orderBy = [{ fullName: 'asc' }, { id: 'asc' }];
      } else if (sortBy === 'name_desc') {
        orderBy = [{ fullName: 'desc' }, { id: 'desc' }];
      } else {
        orderBy = [{ archivedAt: 'desc' }, { id: 'desc' }];
      }
    } else {
      if (sortBy === 'name_asc') {
        orderBy = [{ fullName: 'asc' }, { id: 'asc' }];
      } else if (sortBy === 'name_desc') {
        orderBy = [{ fullName: 'desc' }, { id: 'desc' }];
      } else if (sortBy === 'created_asc') {
        orderBy = [{ createdAt: 'asc' }, { id: 'asc' }];
      } else {
        orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
      }
    }

    const [total, candidates] = await Promise.all([
      prisma.candidate.count({ where }),
      prisma.candidate.findMany({
        where,
        skip,
        take: limitNum,
        orderBy,
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
    ]);

    let statusCounts: Record<string, number> = {};
    try {
      const statusGroups = await prisma.candidate.groupBy({
        by: ['status'],
        where: statusSummaryWhere,
        _count: { _all: true },
      });
      statusCounts = Object.fromEntries(
        statusGroups.map((group) => [group.status || 'Unknown', group._count._all])
      );
    } catch (groupErr) {
      console.warn('[getCandidates] status summary groupBy non-blocking notice:', groupErr);
    }

    const enrichedCandidates = await enrichCandidatesWithRecruiters(candidates);
    const maskedCandidates = maskCandidatesListForRole(enrichedCandidates, userRole);

    sendSuccess(res, {
      candidates: maskedCandidates,
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

    const cleanPhone = normalizeIndianPhone(data.phone) || data.phone.trim();
    const cleanEmail = (data.email && data.email.trim()) ? data.email.trim().toLowerCase() : ('bulk.' + cleanPhone + '@orricaedge.internal');

    // 2. Hard server-side duplicate check (Critical Requirement via SSOT service)
    const dupCheck = await findDuplicateCandidate({ phone: cleanPhone, email: cleanEmail, targetJobId: data.targetJobId });

    if (dupCheck.isDuplicate && dupCheck.matchedCandidate) {
      const existingCandidate = dupCheck.matchedCandidate;
      res.status(409).json({
        success: false,
        code: 'DUPLICATE_CANDIDATE',
        message: 'A candidate with this phone number or email already exists in the system.',
        data: {
          exists: true,
          isDuplicate: true,
          matchedSignal: dupCheck.matchedSignal,
          hasAlreadyAppliedToJob: dupCheck.hasAlreadyAppliedToJob,
          candidateId: existingCandidate.candidateCode || existingCandidate.id,
          candidate: {
            id: existingCandidate.id,
            candidateCode: existingCandidate.candidateCode,
            name: existingCandidate.name || existingCandidate.fullName,
            phone: existingCandidate.phone,
            email: existingCandidate.email,
            status: existingCandidate.status,
            sourcingRecruiterName: existingCandidate.sourcingRecruiterName,
            teamLeaderName: existingCandidate.teamLeaderName,
            currentApplication: existingCandidate.currentApplication,
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
          status: normalizeCandidateStatus(data.status || data.operationalStatus || 'Not Called'),
          operationalStatus: data.operationalStatus ? normalizeCandidateStatus(data.operationalStatus) : (data.status ? normalizeCandidateStatus(data.status) : 'Not Called'),
          pipelineStage: data.pipelineStage || null,
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

    sendSuccess(res, { candidate: maskCandidateForRole(fullCandidate || candidate, req.user?.role) }, 'Candidate created successfully', 201);
  } catch (err) {
    next(err);
  }
};

export const assignCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const schema = z.object({
      recruiterId: z.string().nullable().optional(),
      assignedRecruiterId: z.string().nullable().optional(),
      assignedRecruiterIds: z.array(z.string()).optional(),
    }).passthrough();
    const parsedBody = schema.parse(req.body);
    const rawRecruiterId = parsedBody.recruiterId !== undefined ? parsedBody.recruiterId : parsedBody.assignedRecruiterId;

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
    let resolvedRecruiterUserId: string | null = null;
    if (rawRecruiterId) {
      const rId = String(rawRecruiterId).trim();
      recruiter = await prisma.user.findFirst({
        where: {
          OR: [
            { id: rId },
            { recruiterId: rId },
            { email: rId },
          ],
        },
        select: { id: true, recruiterId: true, fullName: true, email: true, role: true },
      });
      if (!recruiter) {
        sendError(res, 'Recruiter not found or inactive', 400);
        return;
      }
      resolvedRecruiterUserId = recruiter.id;
    }

    const previousRecruiter = existing.ownerRecruiterId
      ? await prisma.user.findUnique({
          where: { id: existing.ownerRecruiterId },
          select: { id: true, recruiterId: true, fullName: true, email: true },
        })
      : null;

    const recruiterIdToStore = resolvedRecruiterUserId || (rawRecruiterId ? String(rawRecruiterId).trim() : null);
    const recruiterId = recruiterIdToStore;
    const isReassign = Boolean(existing.ownerRecruiterId && existing.ownerRecruiterId !== recruiterIdToStore);
    const candidateName = existing.fullName || existing.name || 'Candidate';
    const candidateCode = existing.candidateCode || existing.id;
    const assignedRecruiterName = recruiter ? (recruiter.fullName || recruiter.email) : 'Unassigned';
    const previousRecruiterName = previousRecruiter ? (previousRecruiter.fullName || previousRecruiter.email) : 'Unassigned';
    const actionType = isReassign ? 'REASSIGN_CANDIDATE_RECRUITER' : 'ASSIGN_CANDIDATE_RECRUITER';
    const detailsDescription = isReassign
      ? `Candidate "${candidateName}" (${candidateCode}) reassigned from ${previousRecruiterName} to ${assignedRecruiterName}`
      : `Candidate "${candidateName}" (${candidateCode}) assigned to recruiter ${assignedRecruiterName}`;

    let newAssignedRecruiterIds = Array.isArray(existing.assignedRecruiterIds) ? [...existing.assignedRecruiterIds] : [];
    if (recruiterIdToStore) {
      if (isReassign && existing.ownerRecruiterId) {
        newAssignedRecruiterIds = newAssignedRecruiterIds.filter(
          (id) => id !== existing.ownerRecruiterId && id !== previousRecruiter?.recruiterId
        );
      }
      if (!newAssignedRecruiterIds.includes(recruiterIdToStore)) {
        newAssignedRecruiterIds.push(recruiterIdToStore);
      }
      if (recruiter?.recruiterId && !newAssignedRecruiterIds.includes(recruiter.recruiterId)) {
        newAssignedRecruiterIds.push(recruiter.recruiterId);
      }
    } else {
      newAssignedRecruiterIds = [];
    }

    let newTags = Array.isArray(existing.tags) ? [...existing.tags] : [];
    newTags = newTags.filter((t: string) => !t.startsWith('assignedRecruiter:') && !t.startsWith('assignedRecruiters:'));
    if (recruiterIdToStore) {
      newTags.push(`assignedRecruiter:${recruiterIdToStore}`);
      if (recruiter?.recruiterId) {
        newTags.push(`assignedRecruiter:${recruiter.recruiterId}`);
      }
      newTags.push(`assignedRecruiters:${newAssignedRecruiterIds.join(',')}`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id: existing.id },
        data: {
          ownerRecruiterId: recruiterIdToStore,
          assignedRecruiterIds: newAssignedRecruiterIds,
          tags: newTags,
        },
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

    sendSuccess(res, { candidate: maskCandidateForRole(updated, req.user?.role) }, 'Candidate recruiter assignment updated successfully');
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

    const [enrichedCandidate] = await enrichCandidatesWithRecruiters([candidate]);
    const maskedCandidate = maskCandidateForRole(enrichedCandidate, req.user?.role);
    sendSuccess(res, { candidate: maskedCandidate });
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
      (req.user?.role === 'RECRUITER' || req.user?.role === 'FREELANCE_RECRUITER') &&
      data.ownerRecruiterId !== undefined &&
      data.ownerRecruiterId !== existing.ownerRecruiterId &&
      data.ownerRecruiterId !== req.user.userId
    ) {
      sendError(res, 'Recruiters cannot change candidate ownership.', 403);
      return;
    }

        // Operational Status and Pipeline Stage decoupling
    const rawOpStatus = (data as any).operationalStatus ?? data.status;
    const nextOpStatus = rawOpStatus !== undefined ? (rawOpStatus ? normalizeCandidateStatus(rawOpStatus) : null) : undefined;
    const nextStatus = nextOpStatus ?? (data.status !== undefined ? normalizeCandidateStatus(data.status) : undefined);
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
      'operationalStatus',
      'pipelineStage',
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

    // A. Operational Status rules
    if (nextOpStatus !== undefined && nextOpStatus !== null) {
      if (nextOpStatus === 'Callback Requested' || nextOpStatus === 'On Hold' || nextOpStatus === 'Callback Scheduled') {
        const hasFollowUp = Boolean(
          data.followUpAt ||
          data.nextActionDate ||
          existing.followUpAt ||
          existing.nextActionDate
        );
        if (!hasFollowUp) {
          sendError(res, 'A follow-up date is required when setting status to Callback Requested or On Hold.', 400);
          return;
        }
      }
      candidateData.operationalStatus = nextOpStatus;
      candidateData.status = nextOpStatus;
    }

    // B. Official Pipeline Stage progression gates
    if ((data as any).pipelineStage !== undefined) {
      const targetStage = (data as any).pipelineStage ? String((data as any).pipelineStage).trim() : null;
      if (targetStage) {
        if (targetStage === 'Ready to Go – Walk-in Scheduled' || targetStage === 'Ready to Go - Walk-in Scheduled') {
          const hasWalkIn = Boolean(data.walkInDate || existing.walkInDate);
          if (!hasWalkIn) {
            sendError(res, 'A walk-in date is required for Ready to Go – Walk-in Scheduled.', 400);
            return;
          }
        } else if (targetStage === 'Client Select') {
          const hasFeedbackOrClient = Boolean(
            clientName ||
            existing.clientName ||
            data.feedback ||
            existing.feedback ||
            recruiterRemarks ||
            remarks
          );
          if (!hasFeedbackOrClient) {
            sendError(res, 'Client feedback or client name is required for Client Select.', 400);
            return;
          }
        } else if (targetStage === 'Joined – Winning Option' || targetStage === 'Joined - Winning Option') {
          const hasJoining = Boolean(
            data.dateOfJoin ||
            existing.dateOfJoin ||
            actualJoiningStatus ||
            existing.actualJoiningStatus
          );
          if (!hasJoining) {
            sendError(res, 'Confirmed joining date or status is required for Joined – Winning Option.', 400);
            return;
          }
        }
      }
      candidateData.pipelineStage = targetStage;
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

    // Selection Workflow Validation & Preparation:
    // Only engage selection-specific operations if the candidate is transitioning into Selected/Joined
    // or if the candidate is already in Selected/Joined and selection fields are explicitly provided.
    const isMovingToSelected = nextStatus === 'Selected' || nextStatus === 'Joined';
    const isExplicitSelectionUpdate =
      (existing.status === 'Selected' || existing.status === 'Joined') &&
      (selectionDate !== undefined || selectedAt !== undefined || actualJoiningStatus !== undefined || lastWorkingDate !== undefined || (clientName !== undefined && clientName.trim().length > 0));

    const isSelectionWorkflow = isMovingToSelected || isExplicitSelectionUpdate;

    let computedTotalWorkingDays: number | null | undefined = undefined;
    let resolvedCanonicalClientName: string | null | undefined = undefined;
    let finalAssignedRecruiterIds: string[] = [];
    let effectiveSelDate: string | undefined = undefined;
    let effectiveJoiningStatus: string = 'Selected (Not Joined Yet)';

    if (isSelectionWorkflow) {
      // 1. Client check & resolution:
      // Check provided client, existing client, or applied job's client; default to 'Digitide Solutions' if none present.
      let effectiveClientName = String(clientName || existing.clientName || '').trim();
      let effectiveClientId = clientId || existing.clientId;
      if (!effectiveClientName && !effectiveClientId) {
        const appClient = (existing as any).applications?.[0]?.job?.client?.companyName;
        effectiveClientName = appClient ? String(appClient).trim() : 'Digitide Solutions';
      }

      // 2. Recruiter assignment check & resolution (Keep existing recruiters; default to owner/creator if missing)
      let effectiveRecruiterIds = Array.isArray(assignedRecruiterIds) && assignedRecruiterIds.length > 0
        ? assignedRecruiterIds
        : (existing.assignedRecruiterIds && existing.assignedRecruiterIds.length > 0)
        ? existing.assignedRecruiterIds
        : (existing.ownerRecruiterId ? [existing.ownerRecruiterId] : []);
      if (!effectiveRecruiterIds || effectiveRecruiterIds.length === 0) {
        const defaultRecruiterId = existing.sourcingRecruiterId || (req.user?.role === 'RECRUITER' || req.user?.role === 'FREELANCE_RECRUITER' ? req.user.userId : null) || existing.id;
        effectiveRecruiterIds = defaultRecruiterId ? [defaultRecruiterId] : [];
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
      if (effectiveClientName) {
        resolvedCanonicalClientName = normalizeClientName(effectiveClientName);
      }

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
          candidateData.selectionDate = new Date(effectiveSelDate);
        }
        candidateData.actualJoiningStatus = effectiveJoiningStatus;
        if (lastWorkingDate !== undefined || existing.lastWorkingDate) {
          const lDate = lastWorkingDate !== undefined ? lastWorkingDate : existing.lastWorkingDate;
          candidateData.lastWorkingDate = lDate ? new Date(lDate) : null;
        }
        candidateData.totalWorkingDays = computedTotalWorkingDays !== undefined ? computedTotalWorkingDays : (existing.totalWorkingDays ?? 0);
        if (finalAssignedRecruiterIds.length > 0) {
          candidateData.assignedRecruiterIds = finalAssignedRecruiterIds;
          const firstRecId = finalAssignedRecruiterIds[0];
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firstRecId);
          if (isUuid) {
            candidateData.ownerRecruiterId = firstRecId;
          } else {
            const recUser = await tx.user.findFirst({
              where: { OR: [{ recruiterId: firstRecId }, { email: firstRecId.toLowerCase() }] },
              select: { id: true },
            });
            if (recUser?.id) {
              candidateData.ownerRecruiterId = recUser.id;
            }
          }
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
          status: candidateData.status ?? nextStatus ?? undefined,
          email: data.email ? data.email.toLowerCase() : undefined,
          ...(walkInWasRescheduled ? { rescheduleCount: { increment: 1 } } : {}),
        } as any,
      });

      const batchedActivities: any[] = [];

      if (candidateData.pipelineStage !== undefined && candidateData.pipelineStage !== existing.pipelineStage) {
        try {
          await (tx as any).candidateStageTransition.create({
            data: {
              candidateId: existing.id,
              fromStage: existing.pipelineStage || null,
              toStage: candidateData.pipelineStage,
              changedById: req.user?.userId || null,
              sourceActivity: (data as any).sourceActivity || 'MANUAL_UPDATE',
              notes: recruiterRemarks || remarks || null,
            },
          });
        } catch (trErr) {
          console.warn('[updateCandidate] Stage transition recording notice:', trErr);
        }

        batchedActivities.push({
          candidateId: existing.id,
          userId: req.user?.userId || null,
          recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
          action: 'STAGE_CHANGED',
          notes: `Pipeline stage moved from "${existing.pipelineStage || 'Unmapped'}" to "${candidateData.pipelineStage}"`,
          metadata: {
            fromStage: existing.pipelineStage,
            toStage: candidateData.pipelineStage,
          },
        });
      }

      if (walkInWasRescheduled) {
        batchedActivities.push({
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
        });
      }

      const walkInChanged =
        (data.walkInStatus !== undefined && data.walkInStatus !== existing.walkInStatus) ||
        (data.walkInResponse !== undefined && data.walkInResponse !== existing.walkInResponse) ||
        (data.walkInDate !== undefined && data.walkInDate?.getTime() !== existing.walkInDate?.getTime()) ||
        (data.walkInTime !== undefined && data.walkInTime !== existing.walkInTime);
      if (walkInChanged && !walkInWasRescheduled) {
        batchedActivities.push({
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
        });
      }

      if (data.followUpAt !== undefined && data.followUpAt?.getTime() !== existing.followUpAt?.getTime()) {
        batchedActivities.push({
          candidateId: existing.id,
          userId: req.user?.userId || null,
          recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
          action: 'FOLLOW_UP_SCHEDULED',
          metadata: { followUpAt: data.followUpAt?.toISOString() ?? null },
        });
      }

      if (data.followUpCompletedAt && !existing.followUpCompletedAt) {
        batchedActivities.push({
          candidateId: existing.id,
          userId: req.user?.userId || null,
          recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
          action: 'FOLLOW_UP_COMPLETED',
          metadata: { followUpAt: existing.followUpAt?.toISOString() ?? null },
        });
      }

      if (nextStatus && nextStatus !== existing.status) {
        try {
          await tx.application.updateMany({
            where: { candidateId: existing.id },
            data: { status: nextStatus },
          });
        } catch (appSyncErr) {
          console.warn('[UPDATE_CANDIDATE] Application sync warning:', appSyncErr);
        }

        batchedActivities.push({
          candidateId: existing.id,
          userId: req.user?.userId || null,
          recruiterId: existing.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? req.user.userId : null),
          action: nextStatus === 'Selected' ? 'SELECTED' : nextStatus === 'Joined' ? 'JOINED' : nextStatus === 'Rejected' ? 'REJECTED' : 'STATUS_UPDATED',
          metadata: { oldStatus: existing.status, newStatus: nextStatus },
        });
      }

      if (batchedActivities.length > 0) {
        await tx.candidateActivity.createMany({ data: batchedActivities });
      }

      return candidate;
    });

    const isOwnerChanged = existing.ownerRecruiterId !== updated.ownerRecruiterId;

    // Send response right away to eliminate UI latency
    const finalCandidate = isOwnerChanged
      ? (await enrichCandidatesWithRecruiters([updated]))[0]
      : updated;
    sendSuccess(res, { candidate: maskCandidateForRole(finalCandidate, req.user?.role) }, 'Candidate profile updated successfully');

    // Async post-response tasks (fire-and-forget)
    if (nextStatus && nextStatus !== existing.status) {
      logCandidateTimeline({
        candidateId: existing.id,
        userId: req.user?.userId || null,
        userName: req.user?.email,
        userRole: req.user?.role,
        action: 'Status Changed',
        previousStatus: existing.status,
        newStatus: nextStatus,
        remarks: `Candidate status updated from ${existing.status} to ${nextStatus} by ${req.user?.email || 'User'}`,
      }).catch((e) => console.error('[TIMELINE_ASYNC_ERROR]', e));
    }

    let prevRecName = 'Unassigned';
    let nextRecName = 'Unassigned';
    (async () => {
      try {
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
      } catch (auditErr) {
        console.error('[AUDIT_ASYNC_ERROR]', auditErr);
      }
    })();
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

    const dupCheck = await findDuplicateCandidate({ phone, email, targetJobId: jobId });
    const existingCandidate = dupCheck.matchedCandidate;

    if (
      existingCandidate &&
      existingCandidate.sourcingRecruiterName &&
      req.user?.role !== 'ADMIN' &&
      req.user?.role !== 'SUPER_ADMIN'
    ) {
      const existingDbCandidate = await prisma.candidate.findUnique({
        where: { id: existingCandidate.id },
        select: { ownerRecruiterId: true, sourcingRecruiterId: true, teamLeaderId: true, resumeUrl: true },
      });
      if (
        existingDbCandidate?.ownerRecruiterId &&
        existingDbCandidate.ownerRecruiterId !== recruiter.id
      ) {
        sendError(res, 'This candidate is owned by another recruiter. Ask an admin to reassign them.', 409);
        return;
      }
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
    const result = await applyCandidateStatusChange({
      candidateId: identifier,
      userId: req.user?.userId,
      userRole: req.user?.role,
      expectedUpdatedAt: req.body?.expectedUpdatedAt,
      ...req.body,
    });

    if (!result.success) {
      if (result.conflict) {
        res.status(409).json({
          success: false,
          conflict: true,
          message: result.message,
          data: result.currentCandidate,
        });
        return;
      }
      sendError(res, result.message, result.statusCode);
      return;
    }

    sendSuccess(
      res,
      { candidate: maskCandidateForRole(result.candidate, req.user?.role) },
      result.message
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Bulk Candidate Status Update: POST /api/candidates/status/bulk
 */
export const bulkUpdateCandidateStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { candidateIds, status, remarks, followUpAt, walkInDate, clientName, dateOfJoin, actualJoiningStatus } = req.body;
    const result = await bulkCandidateStatusChange({
      candidateIds,
      userId: req.user?.userId,
      userRole: req.user?.role,
      status,
      remarks,
      followUpAt,
      walkInDate,
      clientName,
      dateOfJoin,
      actualJoiningStatus,
    });
    res.status(result.statusCode).json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * Delta candidate changes for instant cross-tab / cross-user freshness
 * GET /api/candidates/changes?since=<ISO>
 */
export const getCandidateChanges = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sinceQuery = typeof req.query.since === 'string' ? req.query.since : undefined;
    const sinceDate = sinceQuery ? new Date(sinceQuery) : new Date(Date.now() - 60 * 1000);
    const validSince = Number.isNaN(sinceDate.getTime()) ? new Date(Date.now() - 60 * 1000) : sinceDate;

    const changes = await prisma.candidate.findMany({
      where: {
        updatedAt: { gte: validSince },
      },
      select: {
        id: true,
        candidateCode: true,
        name: true,
        fullName: true,
        status: true,
        pipelineStage: true,
        operationalStatus: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });

    sendSuccess(
      res,
      {
        changes,
        serverTime: new Date().toISOString(),
        count: changes.length,
      },
      'Candidate changes delta retrieved successfully'
    );
  } catch (err) {
    next(err);
  }
};




/* ==========================================================================
   WALK-IN CANDIDATE CONTROLLERS (DELEGATED TO candidate.walkin.ts)
   ========================================================================== */
export {
  resendWalkInEmail,
  sendWalkInInvitation,
  approveWalkInReschedule,
} from './candidate.walkin';



/* ==========================================================================
   BULK CANDIDATE IMPORT (DELEGATED TO candidate.import.ts)
   ========================================================================== */
export {
  CANONICAL_BULK_IMPORT_HEADERS,
  normalizePhoneNumber,
  parseDateOfBirth,
  parseGender,
  downloadCandidateImportTemplate,
  bulkImportCandidates,
} from './candidate.import';


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

/* ==========================================================================
   CANDIDATE ARCHIVE / RESTORE (DELEGATED TO candidate.archive.ts)
   ========================================================================== */
export {
  archiveCandidate,
  bulkArchiveCandidates,
  restoreCandidate,
  getArchivedCandidatesCount,
} from './candidate.archive';
