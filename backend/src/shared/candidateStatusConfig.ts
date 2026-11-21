/**
 * Orrica Edge — Single Source of Truth for Candidate Status Configuration
 *
 * SEMANTICS:
 * 1. pipelineStage: Where the candidate currently is in the structured 10-stage hiring funnel.
 * 2. operationalStatus: The outcome/result of the latest calling or operational outreach attempt.
 * 3. status: Derived display status: deriveStatus({ pipelineStage, operationalStatus }).
 */

/* ------------------------------------------------------------------ */
/* 1. Official 10 Pipeline Stages (Exact order and canonical naming)   */
/* ------------------------------------------------------------------ */
export const PIPELINE_STAGES = [
  'Not Called',
  'No Response',
  'Callback Scheduled',
  'On Hold – After 7 Days',
  'Screening – Under Evaluation',
  'Shortlisted by Recruiter',
  'Ready to Go – Walk-in Scheduled',
  'Client Select',
  'Onboarding Under Process',
  'Joined – Winning Option',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const PIPELINE_STAGE_SET = new Set<string>(PIPELINE_STAGES);

// Backward-compatibility alias
export const OFFICIAL_10_PIPELINE_STATUSES = PIPELINE_STAGES;
export type OfficialPipelineStatus = PipelineStage;

/* ------------------------------------------------------------------ */
/* 2. Operational Call Outcome Statuses                                */
/* ------------------------------------------------------------------ */
export const OPERATIONAL_STATUSES = [
  'Not Called',
  'Contacted',
  'Interested',
  'Not Interested',
  'Not Reachable',
  'Wrong Number',
  'Callback Requested',
  'On Hold',
  'Do Not Call',
] as const;

export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];
export const OPERATIONAL_STATUS_SET = new Set<string>(OPERATIONAL_STATUSES);

/* ------------------------------------------------------------------ */
/* 3. Canonical Exceptions / Terminal States                           */
/* ------------------------------------------------------------------ */
export const TERMINAL_STATUSES = [
  'Joined – Winning Option',
  'Joined',
  'Rejected',
  'Do Not Call',
  'Dropped',
  'Not Interested',
  'Duplicate',
  'Withdrawn',
] as const;

export function isTerminal(status?: string | null): boolean {
  if (!status) return false;
  const s = status.trim();
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

/* ------------------------------------------------------------------ */
/* 4. Dash & Case Normalization Helper                                 */
/* ------------------------------------------------------------------ */
export function normalizeDashAndCase(s: string): string {
  return s
    .trim()
    .replace(/[\u2013\u2014]/g, '-') // Normalize en-dash and em-dash to regular hyphen
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/* ------------------------------------------------------------------ */
/* 5. Legacy & Alias Status Mapping                                    */
/* ------------------------------------------------------------------ */
export const LEGACY_STATUS_MAP: Record<string, { pipelineStage?: PipelineStage; operationalStatus?: OperationalStatus; derived: string }> = {
  NEW: { pipelineStage: 'Not Called', operationalStatus: 'Not Called', derived: 'Not Called' },
  SCREENING: { pipelineStage: 'Screening – Under Evaluation', operationalStatus: 'Interested', derived: 'Screening – Under Evaluation' },
  SHORTLISTED: { pipelineStage: 'Shortlisted by Recruiter', operationalStatus: 'Interested', derived: 'Shortlisted by Recruiter' },
  INTERVIEW: { pipelineStage: 'Ready to Go – Walk-in Scheduled', operationalStatus: 'Interested', derived: 'Ready to Go – Walk-in Scheduled' },
  SELECTED: { pipelineStage: 'Client Select', operationalStatus: 'Interested', derived: 'Client Select' },
  JOINED: { pipelineStage: 'Joined – Winning Option', operationalStatus: 'Interested', derived: 'Joined – Winning Option' },
  REJECTED: { operationalStatus: 'Not Interested', derived: 'Rejected' },
  ON_HOLD: { pipelineStage: 'On Hold – After 7 Days', operationalStatus: 'On Hold', derived: 'On Hold – After 7 Days' },
  DROPPED: { operationalStatus: 'Not Interested', derived: 'Not Interested' },
};

/* ------------------------------------------------------------------ */
/* 6. Robust Resolvers (Tolerant of en-dash, hyphen, case, spaces)     */
/* ------------------------------------------------------------------ */
export function resolvePipelineStage(raw?: string | null): PipelineStage | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Exact match
  if (PIPELINE_STAGE_SET.has(trimmed)) return trimmed as PipelineStage;

  // 2. Normalized dash + case match against canonical 10
  const normalized = normalizeDashAndCase(trimmed);
  for (const stage of PIPELINE_STAGES) {
    if (normalizeDashAndCase(stage) === normalized) {
      return stage;
    }
  }

  // 3. Known aliases & legacy mappings
  const upper = trimmed.toUpperCase().replace(/[- ]/g, '_');
  if (LEGACY_STATUS_MAP[upper]?.pipelineStage) {
    return LEGACY_STATUS_MAP[upper].pipelineStage!;
  }

  // Common partial alias mapping
  if (normalized === 'ready to go' || normalized === 'walk-in scheduled' || normalized === 'walkin scheduled') {
    return 'Ready to Go – Walk-in Scheduled';
  }
  if (normalized === 'screening' || normalized === 'under evaluation') {
    return 'Screening – Under Evaluation';
  }
  if (normalized === 'shortlisted') {
    return 'Shortlisted by Recruiter';
  }
  if (normalized === 'joined' || normalized === 'joined - winning option') {
    return 'Joined – Winning Option';
  }
  if (normalized === 'on hold' || normalized === 'after 7 days') {
    return 'On Hold – After 7 Days';
  }

  return null;
}

export function resolveOperationalStatus(raw?: string | null): OperationalStatus | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Exact match
  if (OPERATIONAL_STATUS_SET.has(trimmed)) return trimmed as OperationalStatus;

  // 2. Normalized dash + case match
  const normalized = normalizeDashAndCase(trimmed);
  for (const op of OPERATIONAL_STATUSES) {
    if (normalizeDashAndCase(op) === normalized) {
      return op;
    }
  }

  // 3. Known aliases
  if (normalized === 'callback' || normalized === 'call back') {
    return 'Callback Requested';
  }
  if (normalized === 'dnc' || normalized === 'do not call') {
    return 'Do Not Call';
  }
  if (normalized === 'wrong' || normalized === 'invalid number') {
    return 'Wrong Number';
  }
  if (normalized === 'busy' || normalized === 'unreachable' || normalized === 'not answering') {
    return 'Not Reachable';
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 7. Derived Status (Single Source of Truth)                          */
/* ------------------------------------------------------------------ */
export function deriveStatus(candidate: {
  pipelineStage?: string | null;
  operationalStatus?: string | null;
  status?: string | null;
}): string {
  // If explicitly rejected, prioritize Rejected
  const pipeNorm = candidate.pipelineStage ? normalizeDashAndCase(candidate.pipelineStage) : '';
  const opNorm = candidate.operationalStatus ? normalizeDashAndCase(candidate.operationalStatus) : '';
  const stNorm = candidate.status ? normalizeDashAndCase(candidate.status) : '';
  if (pipeNorm === 'rejected' || opNorm === 'rejected' || stNorm === 'rejected') {
    return 'Rejected';
  }

  // If a valid pipeline stage exists and is not the default initial stage, it defines candidate progress
  if (candidate.pipelineStage) {
    const resolvedPipe = resolvePipelineStage(candidate.pipelineStage);
    if (resolvedPipe && resolvedPipe !== 'Not Called') {
      return resolvedPipe;
    }
  }

  // Next prioritize operational call outcome
  if (candidate.operationalStatus) {
    const resolvedOp = resolveOperationalStatus(candidate.operationalStatus);
    if (resolvedOp && resolvedOp !== 'Not Called') {
      return resolvedOp;
    }
  }

  // Fallback to existing valid status or 'Not Called'
  if (candidate.status && candidate.status.trim()) {
    return candidate.status.trim();
  }

  return 'Not Called';
}

/* ------------------------------------------------------------------ */
/* 8. Status Validation Rules & Gates                                  */
/* ------------------------------------------------------------------ */
export interface StatusValidationResult {
  valid: boolean;
  error?: string;
}

export const statusRules = {
  'Callback Scheduled': {
    requiredFields: ['followUpAt'] as const,
    validate: (data: Record<string, any>, existing?: Record<string, any>): StatusValidationResult => {
      const hasFollowUp = Boolean(data.followUpAt || existing?.followUpAt || existing?.nextActionDate);
      return hasFollowUp
        ? { valid: true }
        : { valid: false, error: 'A follow-up date is required when scheduling a callback.' };
    },
  },
  'Callback Requested': {
    requiredFields: ['followUpAt'] as const,
    validate: (data: Record<string, any>, existing?: Record<string, any>): StatusValidationResult => {
      const hasFollowUp = Boolean(data.followUpAt || existing?.followUpAt || existing?.nextActionDate);
      return hasFollowUp
        ? { valid: true }
        : { valid: false, error: 'A follow-up date is required when setting status to Callback Requested.' };
    },
  },
  'On Hold – After 7 Days': {
    requiredFields: ['followUpAt'] as const,
    validate: (data: Record<string, any>, existing?: Record<string, any>): StatusValidationResult => {
      const hasFollowUp = Boolean(data.followUpAt || existing?.followUpAt || existing?.nextActionDate);
      return hasFollowUp
        ? { valid: true }
        : { valid: false, error: 'A follow-up date is required when setting status to On Hold – After 7 Days.' };
    },
  },
  'On Hold': {
    requiredFields: ['followUpAt'] as const,
    validate: (data: Record<string, any>, existing?: Record<string, any>): StatusValidationResult => {
      const hasFollowUp = Boolean(data.followUpAt || existing?.followUpAt || existing?.nextActionDate);
      return hasFollowUp
        ? { valid: true }
        : { valid: false, error: 'A follow-up date is required when placing a candidate On Hold.' };
    },
  },
  'Ready to Go – Walk-in Scheduled': {
    requiredFields: ['walkInDate'] as const,
    validate: (data: Record<string, any>, existing?: Record<string, any>): StatusValidationResult => {
      const hasWalkIn = Boolean(data.walkInDate || existing?.walkInDate);
      return hasWalkIn
        ? { valid: true }
        : { valid: false, error: 'A walk-in date is required for Ready to Go – Walk-in Scheduled.' };
    },
  },
  'Client Select': {
    requiredFields: ['clientName', 'remarks'] as const,
    validate: (data: Record<string, any>, existing?: Record<string, any>): StatusValidationResult => {
      const hasFeedbackOrClient = Boolean(
        data.clientName ||
        existing?.clientName ||
        data.remarks ||
        data.notes ||
        existing?.feedback ||
        existing?.notes
      );
      return hasFeedbackOrClient
        ? { valid: true }
        : { valid: false, error: 'Client feedback or client name is required for Client Select.' };
    },
  },
  'Joined – Winning Option': {
    requiredFields: ['dateOfJoin'] as const,
    validate: (data: Record<string, any>, existing?: Record<string, any>): StatusValidationResult => {
      const hasJoining = Boolean(
        data.dateOfJoin ||
        existing?.dateOfJoin ||
        data.actualJoiningStatus ||
        existing?.actualJoiningStatus
      );
      return hasJoining
        ? { valid: true }
        : { valid: false, error: 'Confirmed joining date or status is required for Joined – Winning Option.' };
    },
  },
};
