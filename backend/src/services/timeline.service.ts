import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface LogTimelineOptions {
  candidateId: string;
  applicationId?: string | null;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  action: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  remarks?: string | null;
  client?: DbClient;
}

/**
 * Records an auditable timeline event in CandidateTimeline
 */
export const logCandidateTimeline = async (options: LogTimelineOptions) => {
  const db = options.client || defaultPrisma;

  try {
    const timeline = await db.candidateTimeline.create({
      data: {
        candidateId: options.candidateId,
        applicationId: options.applicationId || null,
        userId: options.userId || null,
        userName: options.userName || null,
        userRole: options.userRole || null,
        action: options.action,
        previousStatus: options.previousStatus || null,
        newStatus: options.newStatus || null,
        remarks: options.remarks || null,
      },
    });

    // Also mirror into CandidateActivity for existing dashboard compatibility
    try {
      await db.candidateActivity.create({
        data: {
          candidateId: options.candidateId,
          applicationId: options.applicationId || null,
          userId: options.userId || null,
          action: options.action,
          notes: options.remarks || null,
          metadata: {
            previousStatus: options.previousStatus,
            newStatus: options.newStatus,
            userRole: options.userRole,
            userName: options.userName,
          },
        },
      });
    } catch {
      // Ignored if activity model format difference occurs
    }

    return timeline;
  } catch (error) {
    console.error('[TIMELINE_LOG_ERROR]', error);
    return null;
  }
};
