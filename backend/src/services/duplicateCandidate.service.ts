import { prisma } from '../prisma/client';
import { normalizeIndianPhone } from '../utils/phone';

export interface DuplicateCheckInput {
  phone?: string | null;
  email?: string | null;
  targetJobId?: string | null;
  excludeCandidateId?: string | null;
}

export interface MatchedCandidateSummary {
  id: string;
  candidateCode: string;
  name: string;
  fullName: string;
  email: string;
  phone: string;
  status: string;
  operationalStatus?: string | null;
  pipelineStage?: string | null;
  sourcingRecruiterName?: string | null;
  teamLeaderName?: string | null;
  assignedRecruiterName?: string | null;
  ownerRecruiterId?: string | null;
  sourcingRecruiterId?: string | null;
  teamLeaderId?: string | null;
  currentCompany?: string | null;
  totalExperience?: number;
  noticePeriod?: string | null;
  currentSalary?: number | null;
  currentApplication?: {
    jobId?: string;
    jobCode?: string;
    jobTitle?: string;
    status?: string;
  } | null;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchedCandidate: MatchedCandidateSummary | null;
  matchedSignal: 'Email' | 'Phone' | 'Both' | null;
  hasAlreadyAppliedToJob: boolean;
  message?: string;
}

/**
 * Single Source of Truth for Duplicate Candidate Detection across Orrica Edge.
 * Used by createCandidate, recruiterSubmit, publicForm, universalForm, bulkImport, and checkDuplicate.
 */
export async function findDuplicateCandidate(
  input: DuplicateCheckInput
): Promise<DuplicateCheckResult> {
  const rawEmail = input.email ? String(input.email).trim().toLowerCase() : null;
  const normalizedPhone = normalizeIndianPhone(input.phone);

  if (!rawEmail && !normalizedPhone) {
    return {
      isDuplicate: false,
      matchedCandidate: null,
      matchedSignal: null,
      hasAlreadyAppliedToJob: false,
    };
  }

  const orConditions: any[] = [];
  if (rawEmail) {
    orConditions.push({ email: { equals: rawEmail, mode: 'insensitive' } });
  }

  if (normalizedPhone) {
    orConditions.push(
      { phone: normalizedPhone },
      { phone: `+91${normalizedPhone}` },
      { phone: `+91 ${normalizedPhone.slice(0, 5)} ${normalizedPhone.slice(5)}` },
      { phone: { endsWith: normalizedPhone } }
    );
  }

  const whereClause: any = {
    OR: orConditions,
    isArchived: false,
  };

  if (input.excludeCandidateId) {
    whereClause.id = { not: input.excludeCandidateId };
  }

  const candidate = await prisma.candidate.findFirst({
    where: whereClause,
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
        include: {
          job: {
            select: { id: true, jobCode: true, title: true, department: true },
          },
        },
      },
    },
  });

  if (!candidate) {
    return {
      isDuplicate: false,
      matchedCandidate: null,
      matchedSignal: null,
      hasAlreadyAppliedToJob: false,
    };
  }

  const candEmail = String(candidate.email || '').trim().toLowerCase();
  const candPhoneNorm = normalizeIndianPhone(candidate.phone);

  const emailMatch = Boolean(rawEmail && candEmail === rawEmail);
  const phoneMatch = Boolean(normalizedPhone && (candPhoneNorm === normalizedPhone || candidate.phone.endsWith(normalizedPhone)));

  let matchedSignal: 'Email' | 'Phone' | 'Both' = 'Email';
  if (emailMatch && phoneMatch) {
    matchedSignal = 'Both';
  } else if (phoneMatch) {
    matchedSignal = 'Phone';
  }

  const latestApp = candidate.applications && candidate.applications.length > 0 ? candidate.applications[0] : null;

  const hasAlreadyAppliedToJob = Boolean(
    input.targetJobId &&
      candidate.applications &&
      candidate.applications.some((app) => app.jobId === input.targetJobId)
  );

  const sourcingRecruiterName =
    candidate.sourcingRecruiter?.fullName ||
    candidate.ownerRecruiter?.fullName ||
    null;

  const teamLeaderName = candidate.teamLeader?.fullName || null;
  const assignedRecruiterName = candidate.ownerRecruiter?.fullName || sourcingRecruiterName;

  const matchedSummary: MatchedCandidateSummary = {
    id: candidate.id,
    candidateCode: candidate.candidateCode,
    name: candidate.name || candidate.fullName,
    fullName: candidate.fullName,
    email: candidate.email,
    phone: candidate.phone,
    status: candidate.status,
    operationalStatus: candidate.operationalStatus,
    pipelineStage: candidate.pipelineStage,
    sourcingRecruiterName,
    teamLeaderName,
    assignedRecruiterName,
    ownerRecruiterId: candidate.ownerRecruiterId,
    sourcingRecruiterId: candidate.sourcingRecruiterId,
    teamLeaderId: candidate.teamLeaderId,
    currentCompany: candidate.currentCompany || null,
    totalExperience: candidate.totalExperience ? Number(candidate.totalExperience) : 0,
    noticePeriod: candidate.noticePeriod || null,
    currentSalary: candidate.currentSalary ? Number(candidate.currentSalary) : null,
    currentApplication: latestApp
      ? {
          jobId: latestApp.jobId,
          jobCode: latestApp.job?.jobCode,
          jobTitle: latestApp.job?.title,
          status: latestApp.status || (latestApp as any).stage,
        }
      : null,
  };

  return {
    isDuplicate: true,
    matchedCandidate: matchedSummary,
    matchedSignal,
    hasAlreadyAppliedToJob,
    message: `A candidate with this ${matchedSignal === 'Both' ? 'phone number and email' : matchedSignal.toLowerCase()} already exists in the system.`,
  };
}
