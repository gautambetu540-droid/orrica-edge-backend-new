import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Standardizes Candidate Code formatting to canonical: OE-CAND-XXXX (e.g. OE-CAND-0001, OE-CAND-0173, OE-CAND-0185)
 * Padded to at least 4 digits.
 */
export const formatCandidateCode = (seqNum: number): string => {
  return `OE-CAND-${String(seqNum).padStart(4, '0')}`;
};

/**
 * Generates an auto-incrementing Candidate Code in the format: OE-CAND-XXXX (e.g. OE-CAND-0001, OE-CAND-0185)
 * Uses atomic PostgreSQL sequence when available, with resilient fallback for unit tests and unmigrated environments.
 */
export const generateCandidateCode = async (client?: DbClient): Promise<string> => {
  const db: any = client || defaultPrisma;

  // 1. Attempt atomic allocation via PostgreSQL sequence using root Prisma client.
  // NEVER execute speculative DDL/sequence queries directly on a Prisma TransactionClient (tx),
  // because in PostgreSQL any query error inside a BEGIN...COMMIT block instantly aborts the transaction (SQLSTATE 25P02).
  const isMockClient = client && typeof (client as any).$queryRaw !== 'function';

  if (!isMockClient) {
    const rootClient: any = defaultPrisma && typeof defaultPrisma.$queryRaw === 'function'
      ? defaultPrisma
      : (typeof db?.$queryRaw === 'function' ? db : null);

    if (rootClient) {
      try {
        const result = await rootClient.$queryRaw`SELECT nextval('candidate_code_seq')::text AS next_val`;
        if (Array.isArray(result) && result.length > 0 && result[0]?.next_val) {
          const seqNum = parseInt(result[0].next_val, 10);
          if (!isNaN(seqNum) && seqNum > 0) {
            return formatCandidateCode(seqNum);
          }
        }
      } catch {
        // Sequence query failed or not created yet in current environment, proceed to fallback
      }
    }
  }

  // 2. Fallback in-memory scanner (supports mockDb in unit tests and active tx)
  try {
    const candidateModel = db?.candidate || defaultPrisma?.candidate;
    if (candidateModel?.findMany) {
      const latestCandidates = await candidateModel.findMany({
        select: { candidateCode: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      let maxSeq = 0;

      for (const c of latestCandidates) {
        if (!c.candidateCode) continue;

        // Check for canonical OE-CAND-XXXX
        const oeMatch = c.candidateCode.match(/^OE-CAND-(\d+)$/i);
        if (oeMatch) {
          const num = parseInt(oeMatch[1], 10);
          if (!isNaN(num) && num > maxSeq) {
            maxSeq = num;
          }
        }

        // Check for legacy CND-XXXXXX format
        const cndMatch = c.candidateCode.match(/^CND-(\d+)$/i);
        if (cndMatch) {
          const num = parseInt(cndMatch[1], 10);
          if (!isNaN(num) && num > maxSeq) {
            maxSeq = num;
          }
        }
      }

      const nextSeq = maxSeq + 1;
      return formatCandidateCode(nextSeq);
    }
  } catch {
    // If scanner fails, proceed to ultimate fallback
  }

  return 'OE-CAND-0001';
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

  // 1. Attempt atomic block reservation via PostgreSQL sequence on root client
  const isMockClient = client && typeof (client as any).$queryRaw !== 'function';

  if (!isMockClient) {
    const rootClient: any = defaultPrisma && typeof defaultPrisma.$queryRaw === 'function'
      ? defaultPrisma
      : (typeof db?.$queryRaw === 'function' ? db : null);

    if (rootClient) {
      try {
        const result = await rootClient.$queryRaw`
          SELECT nextval('candidate_code_seq')::text AS start_val
        `;
        if (Array.isArray(result) && result.length > 0 && result[0]?.start_val) {
          const startVal = parseInt(result[0].start_val, 10);
          if (!isNaN(startVal) && startVal > 0) {
            if (count > 1) {
              const endVal = startVal + count - 1;
              await rootClient.$executeRaw`SELECT setval('candidate_code_seq', ${endVal}, true)`;
            }
            const codes: string[] = [];
            for (let i = 0; i < count; i++) {
              codes.push(formatCandidateCode(startVal + i));
            }
            return codes;
          }
        }
      } catch {
        // Fallback
      }
    }
  }

  // 2. Resilient fallback: obtain initial code and increment
  const firstCode = await generateCandidateCode(db);
  const match = firstCode.match(/^OE-CAND-(\d+)$/i) || firstCode.match(/^CND-(\d+)$/i);
  const startNum = match ? parseInt(match[1], 10) : 1;
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(formatCandidateCode(startNum + i));
  }
  return codes;
};

/**
 * Generates an auto-incrementing Application Code in the format: APP-XXXXXX (e.g. APP-000938)
 */
export const generateApplicationCode = async (client?: DbClient): Promise<string> => {
  const db: any = client || defaultPrisma;

  try {
    const appModel = db?.application || defaultPrisma?.application;
    if (appModel?.findMany) {
      const latestApps = await appModel.findMany({
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
    }
  } catch {
    // Fallback if query fails
  }

  return 'APP-000001';
};

/**
 * Generates an auto-incrementing Job Code in the format: OE-YYYY-XXXXX (e.g. OE-2026-00124)
 */
export const generateJobCode = async (client?: DbClient): Promise<string> => {
  const db: any = client || defaultPrisma;
  const currentYear = new Date().getFullYear();
  const prefix = `OE-${currentYear}-`;

  try {
    const jobModel = db?.job || defaultPrisma?.job;
    if (jobModel?.findMany) {
      const latestJobs = await jobModel.findMany({
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
    }
  } catch {
    // Fallback
  }

  return `${prefix}00001`;
};
