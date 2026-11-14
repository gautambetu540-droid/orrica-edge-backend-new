import { prisma } from '../prisma/client';
import {
  OFFICIAL_10_PIPELINE_STATUSES,
  OfficialPipelineStatus,
  resolvePipelineStage,
  resolveOperationalStatus,
} from '../shared/candidateStatusConfig';

export interface SummaryRowData {
  recruiterId: string;
  name: string;
  email?: string;
  phone?: string;
  avatarUrl?: string;
  gender?: string;
  isUnassignedRow?: boolean;
  assigned: number;
  stageCounts: Record<OfficialPipelineStatus, number>;
  inactiveCount: number;
  unmappedCount: number;
  updated: number;
  pctCalled: number;
  coverageFormatted: string;
  lastActivity: string | null;
}

export interface TeamCallingSummaryResult {
  rows: SummaryRowData[];
  unassignedRow?: SummaryRowData;
  total: SummaryRowData;
  inactiveRecruiterIds: string[];
  activeRecruiterIds: string[];
  dateRange: {
    from: string | null;
    to: string | null;
    timeZone: string;
  };
}

/**
 * Standard Single Rule for Candidate Calling Owner:
 * 1. ownerRecruiterId
 * 2. Fallback assignedRecruiterIds[0]
 * 3. Fallback null (unmapped / unassigned)
 */
export function getCallingOwner(candidate: {
  ownerRecruiterId?: string | null;
  assignedRecruiterIds?: string[] | null;
}): string | null {
  if (candidate.ownerRecruiterId && String(candidate.ownerRecruiterId).trim()) {
    return String(candidate.ownerRecruiterId).trim();
  }
  if (
    Array.isArray(candidate.assignedRecruiterIds) &&
    candidate.assignedRecruiterIds.length > 0 &&
    candidate.assignedRecruiterIds[0] &&
    String(candidate.assignedRecruiterIds[0]).trim()
  ) {
    return String(candidate.assignedRecruiterIds[0]).trim();
  }
  return null;
}

/**
 * Parse date strings into UTC Date boundaries representing IST (UTC+05:30) day bounds.
 */
export function parseISTDateRange(fromStr?: string, toStr?: string): { from: Date | null; to: Date | null } {
  if (!fromStr && !toStr) {
    return { from: null, to: null };
  }

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  let fromDate: Date | null = null;
  let toDate: Date | null = null;

  if (fromStr) {
    const trimmed = fromStr.trim();
    if (trimmed.includes('T')) {
      fromDate = new Date(trimmed);
    } else {
      const parts = trimmed.split('-').map(Number);
      if (parts.length === 3) {
        // Start of day in IST: parts[0]-parts[1]-parts[2] 00:00:00.000 IST
        const utcMidnight = Date.UTC(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
        fromDate = new Date(utcMidnight - IST_OFFSET_MS);
      } else {
        fromDate = new Date(trimmed);
      }
    }
  }

  if (toStr) {
    const trimmed = toStr.trim();
    if (trimmed.includes('T')) {
      toDate = new Date(trimmed);
    } else {
      const parts = trimmed.split('-').map(Number);
      if (parts.length === 3) {
        // End of day in IST: parts[0]-parts[1]-parts[2] 23:59:59.999 IST
        const utcEndOfDay = Date.UTC(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
        toDate = new Date(utcEndOfDay - IST_OFFSET_MS);
      } else {
        toDate = new Date(trimmed);
      }
    }
  }

  return { from: fromDate, to: toDate };
}

export interface SummaryQueryOptions {
  from?: string;
  to?: string;
  location?: string;
  recruiterIds?: string[] | string;
}

export async function fetchTeamCallingSummary(options: SummaryQueryOptions = {}): Promise<TeamCallingSummaryResult> {
  const { from: fromDate, to: toDate } = parseISTDateRange(options.from, options.to);
  const locationFilter = options.location && options.location !== 'all' ? options.location.trim() : null;

  let filterRecruiterIds: string[] | null = null;
  if (options.recruiterIds) {
    if (Array.isArray(options.recruiterIds)) {
      filterRecruiterIds = options.recruiterIds.map((id) => String(id).trim()).filter(Boolean);
    } else if (typeof options.recruiterIds === 'string') {
      filterRecruiterIds = options.recruiterIds.split(',').map((id) => id.trim()).filter(Boolean);
    }
  }

  // 1. Fetch active recruiters from Users table
  const recruiterUsers = await prisma.user.findMany({
    where: {
      role: { in: ['RECRUITER', 'FREELANCE_RECRUITER', 'TEAM_LEADER', 'ADMIN', 'SUB_ADMIN'] },
      isActive: true,
      ...(filterRecruiterIds && filterRecruiterIds.length > 0 ? { id: { in: filterRecruiterIds } } : {}),
    },
    select: {
      id: true,
      recruiterId: true,
      fullName: true,
      email: true,
      phone: true,
      avatarUrl: true,
    },
    orderBy: { fullName: 'asc' },
  });

  const recruiterMap = new Map<string, typeof recruiterUsers[0]>();
  for (const r of recruiterUsers) {
    recruiterMap.set(r.id, r);
  }

  // 2. Fetch all candidates (scoped by location if requested)
  const candidateWhere: any = {
    isArchived: false,
  };
  if (locationFilter) {
    candidateWhere.OR = [
      { location: { contains: locationFilter, mode: 'insensitive' } },
      { currentLocation: { contains: locationFilter, mode: 'insensitive' } },
    ];
  }

  const candidates = await prisma.candidate.findMany({
    where: candidateWhere,
    select: {
      id: true,
      candidateCode: true,
      fullName: true,
      phone: true,
      location: true,
      status: true,
      pipelineStage: true,
      operationalStatus: true,
      ownerRecruiterId: true,
      assignedRecruiterIds: true,
      lastCallAt: true,
      lastCallOutcome: true,
      callAttempts: true,
      notes: true,
      feedback: true,
      followUpAt: true,
      walkInDate: true,
      selectionDate: true,
      dateOfJoin: true,
      updatedAt: true,
      createdAt: true,
    },
  });

  // 3. Find candidate IDs with qualifying updates in date range
  // Definition: stage change in range OR logged call outcome in range OR candidate activity/remark in range
  const candidateIdsWithUpdate = new Set<string>();

  if (fromDate || toDate) {
    const dateRangeCondition: any = {};
    if (fromDate) dateRangeCondition.gte = fromDate;
    if (toDate) dateRangeCondition.lte = toDate;

    // A. Stage transitions in range
    const transitions = await prisma.candidateStageTransition.findMany({
      where: { changedAt: dateRangeCondition },
      select: { candidateId: true },
    });
    for (const t of transitions) candidateIdsWithUpdate.add(t.candidateId);

    // B. Activities / Notes / Call logs in range
    const activities = await prisma.candidateActivity.findMany({
      where: { createdAt: dateRangeCondition },
      select: { candidateId: true },
    });
    for (const a of activities) candidateIdsWithUpdate.add(a.candidateId);

    // C. Direct lastCallAt in range
    for (const c of candidates) {
      if (c.lastCallAt) {
        const callTime = new Date(c.lastCallAt).getTime();
        const afterFrom = !fromDate || callTime >= fromDate.getTime();
        const beforeTo = !toDate || callTime <= toDate.getTime();
        if (afterFrom && beforeTo) {
          candidateIdsWithUpdate.add(c.id);
        }
      }
    }
  }

  // 4. Group candidates by effective calling owner
  interface GroupedRecruiterBucket {
    candidates: typeof candidates;
  }
  const buckets = new Map<string, GroupedRecruiterBucket>();
  const unassignedCandidates: typeof candidates = [];

  for (const c of candidates) {
    const ownerId = getCallingOwner(c);
    if (ownerId && recruiterMap.has(ownerId)) {
      if (!buckets.has(ownerId)) {
        buckets.set(ownerId, { candidates: [] });
      }
      buckets.get(ownerId)!.candidates.push(c);
    } else {
      unassignedCandidates.push(c);
    }
  }

  // 5. Metric computation per recruiter
  const buildSummaryRow = (
    id: string,
    meta: { name: string; email?: string; phone?: string; avatarUrl?: string; gender?: string; isUnassignedRow?: boolean },
    candidateList: typeof candidates
  ): SummaryRowData => {
    const stageCounts: Record<OfficialPipelineStatus, number> = {
      'Not Called': 0,
      'No Response': 0,
      'Callback Scheduled': 0,
      'On Hold – After 7 Days': 0,
      'Screening – Under Evaluation': 0,
      'Shortlisted by Recruiter': 0,
      'Ready to Go – Walk-in Scheduled': 0,
      'Client Select': 0,
      'Onboarding Under Process': 0,
      'Joined – Winning Option': 0,
    };

    let inactiveCount = 0;
    let verifiedInactiveCount = 0;
    let unmappedCount = 0;
    let loggedCallCount = 0;
    let updatedCount = 0;
    let lastActivityDate: string | null = null;

    for (const c of candidateList) {
      const opStatus = c.operationalStatus || c.status;
      const isInactive =
        opStatus === 'Not Interested' ||
        opStatus === 'Wrong Number' ||
        opStatus === 'Do Not Call' ||
        c.status === 'Rejected' ||
        String(c.status).toLowerCase() === 'rejected';

      if (isInactive) {
        inactiveCount += 1;
        verifiedInactiveCount += 1;
      } else {
        const resolvedStage = resolvePipelineStage(c.pipelineStage);
        if (resolvedStage && (OFFICIAL_10_PIPELINE_STATUSES as readonly string[]).includes(resolvedStage)) {
          stageCounts[resolvedStage as OfficialPipelineStatus] += 1;
        } else if (!c.pipelineStage && (opStatus === 'Not Called' || !opStatus)) {
          stageCounts['Not Called'] += 1;
        } else {
          unmappedCount += 1;
        }
      }

      // Calls logged
      const hasCall = Boolean(
        c.lastCallAt ||
        (c.callAttempts && c.callAttempts > 0) ||
        (opStatus && opStatus !== 'Not Called')
      );
      if (hasCall) loggedCallCount += 1;

      // Qualifying update
      const hasQualifyingUpdate =
        (!fromDate && !toDate)
          ? Boolean(c.notes || c.feedback || hasCall || c.followUpAt || c.walkInDate || c.selectionDate)
          : candidateIdsWithUpdate.has(c.id);

      if (hasQualifyingUpdate) {
        updatedCount += 1;
      }

      // Last activity
      if (c.lastCallAt) {
        const iso = new Date(c.lastCallAt).toISOString().slice(0, 10);
        if (!lastActivityDate || iso > lastActivityDate) {
          lastActivityDate = iso;
        }
      } else if (c.updatedAt) {
        const iso = new Date(c.updatedAt).toISOString().slice(0, 10);
        if (!lastActivityDate || iso > lastActivityDate) {
          lastActivityDate = iso;
        }
      }
    }

    const assigned = candidateList.length;
    const isUnassignedRow = Boolean(meta.isUnassignedRow);
    const eligibleDenominator = Math.max(0, assigned - verifiedInactiveCount);
    const pctCalled = isUnassignedRow
      ? 0
      : eligibleDenominator > 0
      ? Math.min(1, loggedCallCount / eligibleDenominator)
      : assigned > 0 && loggedCallCount > 0
      ? 1
      : 0;

    return {
      recruiterId: id,
      name: meta.name,
      email: meta.email,
      phone: meta.phone,
      avatarUrl: meta.avatarUrl,
      gender: meta.gender,
      isUnassignedRow,
      assigned,
      stageCounts,
      inactiveCount,
      unmappedCount,
      updated: isUnassignedRow ? 0 : updatedCount,
      pctCalled,
      coverageFormatted: isUnassignedRow ? '—' : `${Math.round(pctCalled * 100)}%`,
      lastActivity: lastActivityDate,
    };
  };

  const rows: SummaryRowData[] = recruiterUsers.map((recruiter: any) => {
    const bucket = buckets.get(recruiter.id);
    const recCandidates = bucket ? bucket.candidates : [];
    return buildSummaryRow(
      recruiter.id,
      {
        name: recruiter.fullName || recruiter.email || 'Recruiter',
        email: recruiter.email,
        phone: recruiter.phone || undefined,
        avatarUrl: recruiter.avatarUrl || undefined,
        gender: undefined,
      },
      recCandidates
    );
  });

  const unassignedRow = buildSummaryRow(
    'unassigned',
    { name: 'Unassigned', isUnassignedRow: true },
    unassignedCandidates
  );

  const total = buildSummaryRow(
    'total',
    { name: 'Total Portfolio (Assigned + Unassigned)' },
    candidates
  );

  const inactiveRecruiterIds = rows
    .filter((r) => r.updated === 0 && r.pctCalled === 0)
    .map((r) => r.recruiterId);

  const activeRecruiterIds = rows
    .filter((r) => r.updated > 0 || r.pctCalled > 0)
    .map((r) => r.recruiterId);

  return {
    rows,
    unassignedRow,
    total,
    inactiveRecruiterIds,
    activeRecruiterIds,
    dateRange: {
      from: fromDate ? fromDate.toISOString() : null,
      to: toDate ? toDate.toISOString() : null,
      timeZone: 'Asia/Kolkata (IST)',
    },
  };
}
