import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Generates an auto-incrementing Candidate Code in the format: CND-XXXXXX (e.g. CND-000184)
 */
export const generateCandidateCode = async (client?: DbClient): Promise<string> => {
  const db = client || defaultPrisma;

  const latestCandidates = await db.candidate.findMany({
    select: { candidateCode: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  let maxSeq = 0;

  for (const c of latestCandidates) {
    if (!c.candidateCode) continue;

    // Check for CND-XXXXXX
    const cndMatch = c.candidateCode.match(/^CND-(\d+)$/i);
    if (cndMatch) {
      const num = parseInt(cndMatch[1], 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }

    // Also support legacy OE-CAND-XXXX format
    const legacyMatch = c.candidateCode.match(/^OE-CAND-(\d+)$/i);
    if (legacyMatch) {
      const num = parseInt(legacyMatch[1], 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }

  const nextSeq = maxSeq + 1;
  return `CND-${String(nextSeq).padStart(6, '0')}`;
};

/**
 * Generates an auto-incrementing Application Code in the format: APP-XXXXXX (e.g. APP-000938)
 */
export const generateApplicationCode = async (client?: DbClient): Promise<string> => {
  const db = client || defaultPrisma;

  const latestApps = await db.application.findMany({
    where: { applicationCode: { not: null } },
    select: { applicationCode: true },
    orderBy: { appliedDate: 'desc' },
    take: 50,
  });

  let maxSeq = 0;

  for (const a of latestApps) {
    if (!a.applicationCode) continue;

    const match = a.applicationCode.match(/^APP-(\d+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }

  const nextSeq = maxSeq + 1;
  return `APP-${String(nextSeq).padStart(6, '0')}`;
};

/**
 * Generates an auto-incrementing Job Code in the format: OE-YYYY-XXXXX (e.g. OE-2026-00124)
 */
export const generateJobCode = async (client?: DbClient): Promise<string> => {
  const db = client || defaultPrisma;
  const currentYear = new Date().getFullYear();
  const prefix = `OE-${currentYear}-`;

  const latestJobs = await db.job.findMany({
    where: { jobCode: { startsWith: prefix } },
    select: { jobCode: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  let maxSeq = 0;

  for (const j of latestJobs) {
    if (!j.jobCode) continue;

    const suffix = j.jobCode.slice(prefix.length);
    const num = parseInt(suffix, 10);
    if (!isNaN(num) && num > maxSeq) {
      maxSeq = num;
    }
  }

  const nextSeq = maxSeq + 1;
  return `${prefix}${String(nextSeq).padStart(5, '0')}`;
};
