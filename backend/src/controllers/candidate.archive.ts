import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logCandidateTimeline } from '../services/timeline.service';
import { logAudit } from '../services/audit.service';
import { canAccessCandidate } from './candidate.controller';

export const archiveCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const { reason } = req.body || {};

    if (!identifier) {
      sendError(res, 'Candidate ID is required.', 400);
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
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (candidate.isArchived) {
      sendError(res, 'Candidate is already archived.', 400);
      return;
    }

    const archivedAt = new Date();
    const userId = req.user?.userId || null;
    const userEmail = req.user?.email || 'User';
    const cleanReason = reason ? String(reason).trim() : null;

    const updated = await prisma.$transaction(async (tx) => {
      const updatedCandidate = await tx.candidate.update({
        where: { id: candidate.id },
        data: {
          isArchived: true,
          archivedAt,
          archivedById: userId,
          archiveReason: cleanReason,
          previousStatus: candidate.status,
        },
        include: {
          archivedBy: { select: { id: true, fullName: true, email: true, role: true } },
          ownerRecruiter: { select: { id: true, fullName: true, email: true } },
          sourcingRecruiter: { select: { id: true, fullName: true, email: true } },
          applications: {
            include: {
              job: { select: { id: true, title: true, jobCode: true, department: true } },
            },
          },
        },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: candidate.id,
          userId,
          recruiterId: candidate.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? userId : null),
          action: 'CANDIDATE_ARCHIVED',
          notes: cleanReason || 'Candidate archived manually',
          metadata: {
            previousStatus: candidate.status,
            reason: cleanReason,
            archivedAt: archivedAt.toISOString(),
            archivedByEmail: userEmail,
          },
        },
      });

      await logCandidateTimeline({
        candidateId: candidate.id,
        userId,
        userName: userEmail,
        userRole: req.user?.role,
        action: 'Candidate Archived',
        previousStatus: candidate.status,
        newStatus: candidate.status,
        remarks: `Candidate archived manually: ${cleanReason || 'Administrative archive'}`,
        client: tx,
      });

      return updatedCandidate;
    });

    await logAudit({
      req,
      userId: req.user?.userId,
      action: 'ARCHIVE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: candidate.id,
      details: {
        candidateCode: candidate.candidateCode,
        fullName: candidate.fullName,
        previousStatus: candidate.status,
        reason: cleanReason,
      },
    });

    sendSuccess(res, updated, 'Candidate archived successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Bulk Archive Candidates: POST /api/v1/candidates/bulk-archive
 * Archives multiple candidates with partial failure tracking and safe audit logging.
 */
export const bulkArchiveCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { candidateIds, reason } = req.body || {};

    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      sendError(res, 'candidateIds array is required and cannot be empty.', 400);
      return;
    }

    if (candidateIds.length > 200) {
      sendError(res, 'Cannot archive more than 200 candidates at once.', 400);
      return;
    }

    const userId = req.user?.userId || null;
    const userEmail = req.user?.email || 'User';
    const cleanReason = reason ? String(reason).trim() : null;

    const successfulIds: string[] = [];
    const failedRecords: { id: string; reason: string }[] = [];

    for (const rawId of candidateIds) {
      const id = String(rawId).trim();
      if (!id) continue;

      try {
        const hasAccess = await canAccessCandidate(req, id);
        if (!hasAccess) {
          failedRecords.push({ id, reason: 'Access denied or candidate not found' });
          continue;
        }

        const candidate = await prisma.candidate.findFirst({
          where: {
            OR: [{ id }, { candidateCode: id }],
          },
        });

        if (!candidate) {
          failedRecords.push({ id, reason: 'Candidate not found' });
          continue;
        }

        if (candidate.isArchived) {
          failedRecords.push({ id: candidate.id, reason: 'Candidate is already archived' });
          continue;
        }

        const archivedAt = new Date();
        await prisma.$transaction(async (tx) => {
          await tx.candidate.update({
            where: { id: candidate.id },
            data: {
              isArchived: true,
              archivedAt,
              archivedById: userId,
              archiveReason: cleanReason,
              previousStatus: candidate.status,
            },
          });

          await tx.candidateActivity.create({
            data: {
              candidateId: candidate.id,
              userId,
              recruiterId: candidate.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? userId : null),
              action: 'CANDIDATE_ARCHIVED',
              notes: cleanReason || 'Candidate archived via bulk action',
              metadata: {
                previousStatus: candidate.status,
                reason: cleanReason,
                archivedAt: archivedAt.toISOString(),
                archivedByEmail: userEmail,
                isBulk: true,
              },
            },
          });

          await logCandidateTimeline({
            candidateId: candidate.id,
            userId,
            userName: userEmail,
            userRole: req.user?.role,
            action: 'Candidate Archived',
            previousStatus: candidate.status,
            newStatus: candidate.status,
            remarks: `Candidate archived in bulk: ${cleanReason || 'Administrative archive'}`,
            client: tx,
          });
        });

        successfulIds.push(candidate.id);
      } catch (err: any) {
        failedRecords.push({ id, reason: err?.message || 'Unexpected error' });
      }
    }

    if (successfulIds.length > 0) {
      await logAudit({
        req,
        userId: req.user?.userId,
        action: 'BULK_ARCHIVE_CANDIDATES',
        module: 'CANDIDATES',
        entity: 'Candidate',
        entityId: 'BULK',
        details: {
          successfulCount: successfulIds.length,
          failureCount: failedRecords.length,
          successfulIds,
          reason: cleanReason,
        },
      });
    }

    sendSuccess(res, {
      totalRequested: candidateIds.length,
      successfulCount: successfulIds.length,
      failureCount: failedRecords.length,
      successfulIds,
      failedRecords,
    }, `Archived ${successfulIds.length} candidate(s)${failedRecords.length > 0 ? `, ${failedRecords.length} failed` : ''}.`);
  } catch (err) {
    next(err);
  }
};

/**
 * Manual Restore Candidate: POST /api/v1/candidates/:id/restore
 * Restores candidate back to their previous workflow status, updating original record without duplication.
 */
export const restoreCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;

    if (!identifier) {
      sendError(res, 'Candidate ID is required.', 400);
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
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (!candidate.isArchived) {
      sendError(res, 'Candidate is not archived.', 400);
      return;
    }

    const userId = req.user?.userId || null;
    const userEmail = req.user?.email || 'User';
    const restoredStatus = (candidate.previousStatus && candidate.previousStatus !== 'Archived')
      ? candidate.previousStatus
      : (candidate.status && candidate.status !== 'Archived' ? candidate.status : 'New');

    const updated = await prisma.$transaction(async (tx) => {
      const restoredCandidate = await tx.candidate.update({
        where: { id: candidate.id },
        data: {
          isArchived: false,
          archivedAt: null,
          archivedById: null,
          archiveReason: null,
          status: restoredStatus,
          previousStatus: null,
        },
        include: {
          ownerRecruiter: { select: { id: true, fullName: true, email: true } },
          sourcingRecruiter: { select: { id: true, fullName: true, email: true } },
          applications: {
            include: {
              job: { select: { id: true, title: true, jobCode: true, department: true } },
            },
          },
        },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: candidate.id,
          userId,
          recruiterId: candidate.ownerRecruiterId || (req.user?.role === 'RECRUITER' ? userId : null),
          action: 'CANDIDATE_RESTORED',
          notes: `Candidate restored to active pipeline at status: ${restoredStatus}`,
          metadata: {
            restoredFromStatus: candidate.status,
            restoredToStatus: restoredStatus,
            restoredAt: new Date().toISOString(),
            restoredByEmail: userEmail,
          },
        },
      });

      await logCandidateTimeline({
        candidateId: candidate.id,
        userId,
        userName: userEmail,
        userRole: req.user?.role,
        action: 'Candidate Restored',
        previousStatus: 'Archived',
        newStatus: restoredStatus,
        remarks: `Candidate restored from archive to ${restoredStatus} by ${userEmail}`,
        client: tx,
      });

      return restoredCandidate;
    });

    await logAudit({
      req,
      userId: req.user?.userId,
      action: 'RESTORE_CANDIDATE',
      module: 'CANDIDATES',
      entity: 'Candidate',
      entityId: candidate.id,
      details: {
        candidateCode: candidate.candidateCode,
        fullName: candidate.fullName,
        restoredToStatus: restoredStatus,
      },
    });

    sendSuccess(res, updated, `Candidate restored to ${restoredStatus} successfully.`);
  } catch (err) {
    next(err);
  }
};

/**
 * Get Archived Candidates Count: GET /api/v1/candidates/archived/count
 * Returns real persisted count of archived candidates scoped to user RBAC.
 */
export const getArchivedCandidatesCount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;
    const andFilters: any[] = [{ isArchived: true }];

    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      andFilters.push({
        OR: [
          { sourcingRecruiterId: currentUserId },
          { ownerRecruiterId: currentUserId },
          { createdById: currentUserId },
          { applications: { some: { recruiterId: currentUserId } } },
        ],
      });
    } else if (userRole === 'TEAM_LEADER') {
      andFilters.push({
        OR: [
          { teamLeaderId: currentUserId },
          { sourcingRecruiter: { teamLeaderId: currentUserId } },
          { sourcingRecruiterId: currentUserId },
          { ownerRecruiterId: currentUserId },
        ],
      });
    }

    const count = await prisma.candidate.count({
      where: { AND: andFilters },
    });

    sendSuccess(res, { count }, 'Archived candidates count retrieved successfully.');
  } catch (err) {
    next(err);
  }
};
