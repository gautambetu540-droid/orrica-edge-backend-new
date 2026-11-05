import { prisma } from '../prisma/client';

export interface SubAdminScope {
  assignedRecruiters: Array<{
    id: string;
    recruiterId: string | null;
    email: string;
    fullName: string;
    role: string;
  }>;
  recruiterUserIds: string[];
  allIdentifierStrings: string[];
}

/**
 * Resolves all recruiters assigned to a given Sub-Admin user.
 * Queries User records where subAdminId === subAdminUserId (or legacy teamLeaderId === subAdminUserId).
 */
export async function getSubAdminAssignedScope(subAdminUserId: string): Promise<SubAdminScope> {
  if (!subAdminUserId) {
    return {
      assignedRecruiters: [],
      recruiterUserIds: [],
      allIdentifierStrings: [],
    };
  }

  const assigned = await prisma.user.findMany({
    where: {
      OR: [
        { subAdminId: subAdminUserId },
        { teamLeaderId: subAdminUserId },
      ],
      isActive: true,
    },
    select: {
      id: true,
      recruiterId: true,
      email: true,
      fullName: true,
      role: true,
    },
  });

  const ids = assigned.map((u) => u.id);
  const codes = assigned.map((u) => u.recruiterId).filter(Boolean) as string[];
  const emails = assigned.map((u) => u.email.toLowerCase()).filter(Boolean);

  const allIdentifierStrings = Array.from(new Set([...ids, ...codes, ...emails]));

  return {
    assignedRecruiters: assigned,
    recruiterUserIds: ids,
    allIdentifierStrings,
  };
}

/**
 * Builds a Prisma `where` clause condition for Candidate records
 * that restricts visibility strictly to candidates sourced/owned/assigned by the sub-admin's recruiters.
 * If the sub-admin has 0 assigned recruiters, returns a condition that matches nothing (empty set).
 */
export async function buildSubAdminCandidateFilter(subAdminUserId: string) {
  const { allIdentifierStrings, recruiterUserIds } = await getSubAdminAssignedScope(subAdminUserId);

  if (allIdentifierStrings.length === 0) {
    // No recruiters assigned -> empty result set
    return { id: '__NO_ASSIGNED_RECRUITERS__' };
  }

  const orConditions: any[] = [];

  for (const idStr of allIdentifierStrings) {
    orConditions.push(
      { sourcingRecruiterId: idStr },
      { ownerRecruiterId: idStr },
      { createdById: idStr },
      { applications: { some: { recruiterId: idStr } } },
      { assignedRecruiterIds: { has: idStr } },
      { tags: { has: `assignedRecruiter:${idStr}` } }
    );
  }

  return { OR: orConditions };
}

