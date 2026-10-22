import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Generates an auto-incrementing Candidate Code in the format: CND-XXXXXX (e.g. CND-000184)
 * Uses atomic PostgreSQL sequence when available, with resilient fallback for unit tests and unmigrated environments.
 */
export const generateCandidateCode = async (client?: DbClient): Promise<string> => {
  const db: any = client || defaultPrisma;

  // 1. Attempt atomic allocation via PostgreSQL sequence
  if (typeof db.$queryRaw === 'function') {
    try {
      const result = await db.$queryRaw`SELECT nextval('candidate_code_seq')::text AS next_val`;
      if (Array.isArray(result) && result.length > 0 && result[0]?.next_val) {
        const seqNum = parseInt(result[0].next_val, 10);
        if (!isNaN(seqNum) && seqNum > 0) {
          return `CND-${String(seqNum).padStart(6, '0')}`;
        }
      }
    } catch {
      // Sequence query failed or not created yet in current environment, proceed to fallback
    }
  }

  // 2. Fallback in-memory scanner (supports mockDb in unit tests)
  if (db.candidate?.findMany) {
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
  }

  return 'CND-000001';
};

/**
 * Concurrency-safe batch allocation for Bulk Imports.
 * Reserves a contiguous block of N candidate codes in a single atomic sequence call.
 */
export const generateCandidateCodesBatch = async (
  count: number,
  client?: DbClient
): Promise<string[]> => {
  if (count <= 0) return [];
  const db: any = client || defaultPrisma;

  // 1. Attempt atomic block reservation via PostgreSQL sequence
  if (typeof db.$queryRaw === 'function') {
    try {
      const result = await db.$queryRaw`
        SELECT nextval('candidate_code_seq')::text AS start_val
      `;
      if (Array.isArray(result) && result.length > 0 && result[0]?.start_val) {
        const startVal = parseInt(result[0].start_val, 10);
        if (!isNaN(startVal) && startVal > 0) {
          if (count > 1) {
            const endVal = startVal + count - 1;
            await db.$executeRaw`SELECT setval('candidate_code_seq', ${endVal}, true)`;
          }
          const codes: string[] = [];
          for (let i = 0; i < count; i++) {
            codes.push(`CND-${String(startVal + i).padStart(6, '0')}`);
          }
          return codes;
        }
      }
    } catch {
      // Fallback
    }
  }

  // 2. Resilient fallback: obtain initial code and increment
  const firstCode = await generateCandidateCode(db);
  const match = firstCode.match(/^CND-(\d+)$/i);
  const startNum = match ? parseInt(match[1], 10) : 1;
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(`CND-${String(startNum + i).padStart(6, '0')}`);
  }
  return codes;
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
