/**
 * Working Days Calculation and Client Normalization for Orrica Edge ATS
 * Backend Source of Truth
 */

export const CANONICAL_CLIENTS = [
  'Digitide Solutions',
  'Radical Minds',
] as const;

/**
 * Normalizes client name to ensure consistent matching and prevent duplicate records.
 */
export function normalizeClientName(name?: string | null): string {
  if (!name) return '';
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();

  if (lower.includes('digitide')) {
    return 'Digitide Solutions';
  }
  if (lower.includes('radical') && (lower.includes('mind') || lower.includes('minds'))) {
    return 'Radical Minds';
  }

  return trimmed;
}

/**
 * Validates dates for selected candidate workflow:
 * 1. Date of Joining (DOJ) should not be earlier than Selection Date.
 * 2. Last Working Date (LWD) should not be earlier than Date of Joining (DOJ).
 */
export function validateSelectionDates(params: {
  selectionDate?: Date | string | null;
  dateOfJoin?: Date | string | null;
  lastWorkingDate?: Date | string | null;
}): { isValid: boolean; error?: string } {
  const { selectionDate, dateOfJoin, lastWorkingDate } = params;

  if (selectionDate && dateOfJoin) {
    const selD = typeof selectionDate === 'string' ? new Date(selectionDate) : selectionDate;
    const dojD = typeof dateOfJoin === 'string' ? new Date(dateOfJoin) : dateOfJoin;
    if (!isNaN(selD.getTime()) && !isNaN(dojD.getTime())) {
      const selMidnight = new Date(selD.getFullYear(), selD.getMonth(), selD.getDate());
      const dojMidnight = new Date(dojD.getFullYear(), dojD.getMonth(), dojD.getDate());
      if (dojMidnight < selMidnight) {
        return {
          isValid: false,
          error: 'Date of Joining (DOJ) cannot be earlier than Selection Date.',
        };
      }
    }
  }

  if (dateOfJoin && lastWorkingDate) {
    const dojD = typeof dateOfJoin === 'string' ? new Date(dateOfJoin) : dateOfJoin;
    const lwdD = typeof lastWorkingDate === 'string' ? new Date(lastWorkingDate) : lastWorkingDate;
    if (!isNaN(dojD.getTime()) && !isNaN(lwdD.getTime())) {
      const dojMidnight = new Date(dojD.getFullYear(), dojD.getMonth(), dojD.getDate());
      const lwdMidnight = new Date(lwdD.getFullYear(), lwdD.getMonth(), lwdD.getDate());
      if (lwdMidnight < dojMidnight) {
        return {
          isValid: false,
          error: 'Last Working Date cannot be earlier than Date of Joining (DOJ).',
        };
      }
    }
  }

  return { isValid: true };
}

/**
 * Computes calendar working days (inclusive):
 * - Not Joined Yet / no DOJ -> 0 / null
 * - Joined, no Last Working Date -> (today - DOJ) + 1 (never count before DOJ)
 * - Exited -> (Last Working Date - DOJ) + 1
 */
export function computeWorkingDays(
  joiningStatus: string | undefined | null,
  dateOfJoin: Date | string | undefined | null,
  lastWorkingDate: Date | string | undefined | null,
  now: Date = new Date()
): { totalWorkingDays: number | null; label: string } {
  const normStatus = String(joiningStatus || '').trim().toLowerCase();

  // If Not Joined Yet or no DOJ -> 0 / null
  if (!dateOfJoin || normStatus === 'selected' || normStatus === 'not joined' || normStatus === 'not_joined') {
    return { totalWorkingDays: null, label: 'Not Joined' };
  }

  const doj = typeof dateOfJoin === 'string' ? new Date(dateOfJoin) : dateOfJoin;
  if (!doj || isNaN(doj.getTime())) {
    return { totalWorkingDays: null, label: 'Invalid DOJ' };
  }

  const dojMidnight = new Date(doj.getFullYear(), doj.getMonth(), doj.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Exited: (Last Working Date - DOJ) + 1
  if (normStatus === 'exited' || normStatus === 'exit') {
    if (!lastWorkingDate) {
      return { totalWorkingDays: null, label: 'LWD Required' };
    }
    const lwd = typeof lastWorkingDate === 'string' ? new Date(lastWorkingDate) : lastWorkingDate;
    if (!lwd || isNaN(lwd.getTime())) {
      return { totalWorkingDays: null, label: 'Invalid LWD' };
    }
    const lwdMidnight = new Date(lwd.getFullYear(), lwd.getMonth(), lwd.getDate());
    const diffMs = lwdMidnight.getTime() - dojMidnight.getTime();
    if (diffMs < 0) {
      return { totalWorkingDays: 0, label: 'Invalid (LWD < DOJ)' };
    }
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
    return { totalWorkingDays: days, label: `${days} ${days === 1 ? 'day' : 'days'}` };
  }

  // Joined / Working: (today - DOJ) + 1
  if (normStatus === 'joined' || normStatus === 'working' || normStatus === 'currently working') {
    // If today is before DOJ, do not count before DOJ
    if (nowMidnight < dojMidnight) {
      return { totalWorkingDays: 0, label: 'Joining Pending' };
    }
    const diffMs = nowMidnight.getTime() - dojMidnight.getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
    return { totalWorkingDays: days, label: `${days} ${days === 1 ? 'day' : 'days'}` };
  }

  return { totalWorkingDays: null, label: 'Not Joined' };
}

