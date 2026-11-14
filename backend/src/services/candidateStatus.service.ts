import { prisma } from '../prisma/client';
import {
  resolvePipelineStage,
  resolveOperationalStatus,
  deriveStatus,
  statusRules,
  PipelineStage,
  OperationalStatus,
} from '../shared/candidateStatusConfig';

export interface ApplyStatusChangeOptions {
  candidateId: string;
  userId?: string | null;
  userRole?: string;
  status?: string;
  pipelineStage?: string;
  stage?: string;
  operationalStatus?: string;
  remarks?: string;
  notes?: string;
  followUpAt?: string | Date | null;
  walkInDate?: string | Date | null;
  clientName?: string | null;
  dateOfJoin?: string | Date | null;
  actualJoiningStatus?: string | null;
  sourceActivity?: string;
  expectedUpdatedAt?: string | Date;
  idempotencyKey?: string;
}

export interface StatusChangeResult {
  success: boolean;
  statusCode: number;
  message: string;
  candidate?: any;
  conflict?: boolean;
  currentCandidate?: any;
}

export async function applyCandidateStatusChange(
  opts: ApplyStatusChangeOptions
): Promise<StatusChangeResult> {
  const {
    candidateId,
    userId,
    userRole,
    status,
    pipelineStage,
    stage,
    operationalStatus,
    remarks,
    notes,
    followUpAt,
    walkInDate,
    clientName,
    dateOfJoin,
    actualJoiningStatus,
    sourceActivity,
    expectedUpdatedAt,
  } = opts;

  if (!candidateId) {
    return { success: false, statusCode: 400, message: 'Candidate identifier is required.' };
  }

  // 1. Resolve target stages
  const rawStageInput = pipelineStage !== undefined ? pipelineStage : (stage !== undefined ? stage : undefined);
  const resolvedPipeFromStage = rawStageInput !== undefined ? (resolvePipelineStage(rawStageInput) || String(rawStageInput).trim()) : undefined;
  const resolvedPipeFromStatus = status ? resolvePipelineStage(status) : null;
  const pipeStage = resolvedPipeFromStage !== undefined ? resolvedPipeFromStage : (resolvedPipeFromStatus || undefined);

  const rawOpInput = operationalStatus !== undefined ? operationalStatus : (pipeStage ? undefined : status);
  const resolvedOp = rawOpInput ? (resolveOperationalStatus(rawOpInput) || String(rawOpInput).trim()) : undefined;
  const opStatus = operationalStatus !== undefined ? (resolveOperationalStatus(operationalStatus) || operationalStatus) : resolvedOp;

  if (!opStatus && pipeStage === undefined) {
    return {
      success: false,
      statusCode: 400,
      message: 'A valid operational status or pipeline stage is required.',
    };
  }

  // 2. Fetch existing candidate
  const existing = await prisma.candidate.findFirst({
    where: {
      OR: [{ id: candidateId }, { candidateCode: candidateId }],
    },
    select: {
      id: true,
      candidateCode: true,
      name: true,
      fullName: true,
      status: true,
      operationalStatus: true,
      pipelineStage: true,
      followUpAt: true,
      nextActionDate: true,
      walkInDate: true,
      walkInTime: true,
      walkInStatus: true,
      walkInResponse: true,
      clientName: true,
      clientId: true,
      feedback: true,
      notes: true,
      dateOfJoin: true,
      actualJoiningStatus: true,
      ownerRecruiterId: true,
      sourcingRecruiterId: true,
      createdById: true,
      assignedRecruiterIds: true,
      updatedAt: true,
      ownerRecruiter: {
        select: { id: true, recruiterId: true, fullName: true, email: true, phone: true },
      },
    },
  });

  if (!existing) {
    return { success: false, statusCode: 404, message: 'Candidate not found.' };
  }

  // 3. Optimistic Concurrency Check
  if (expectedUpdatedAt) {
    const expectedTime = new Date(expectedUpdatedAt).getTime();
    const currentTime = new Date(existing.updatedAt).getTime();
    if (!Number.isNaN(expectedTime) && Math.abs(currentTime - expectedTime) > 1500) {
      return {
        success: false,
        statusCode: 409,
        conflict: true,
        message: 'Candidate was modified by another user. Please refresh and review latest updates.',
        currentCandidate: existing,
      };
    }
  }

  // 4. Validation Gates (statusRules)
  const validationPayload = {
    followUpAt,
    walkInDate,
    clientName,
    remarks,
    notes,
    dateOfJoin,
    actualJoiningStatus,
  };

  if (pipeStage) {
    const rule = (statusRules as Record<string, any>)[pipeStage];
    if (rule) {
      const check = rule.validate(validationPayload, existing);
      if (!check.valid) {
        return { success: false, statusCode: 400, message: check.error || 'Validation failed for pipeline stage.' };
      }
    }
  }

  if (opStatus) {
    const rule = (statusRules as Record<string, any>)[opStatus];
    if (rule) {
      const check = rule.validate(validationPayload, existing);
      if (!check.valid) {
        return { success: false, statusCode: 400, message: check.error || 'Validation failed for operational status.' };
      }
    }
  }

  // 5. Build update data with single source of truth deriveStatus
  const finalRemarks = String(remarks || notes || '').trim();
  const updateData: any = {};
  if (opStatus !== undefined) {
    updateData.operationalStatus = opStatus;
  }
  if (pipeStage !== undefined) {
    updateData.pipelineStage = pipeStage ? String(pipeStage).trim() : null;
  }

  updateData.status = deriveStatus({
    pipelineStage: updateData.pipelineStage !== undefined ? updateData.pipelineStage : existing.pipelineStage,
    operationalStatus: updateData.operationalStatus !== undefined ? updateData.operationalStatus : existing.operationalStatus,
    status: existing.status,
  });

  if (finalRemarks) {
    updateData.notes = finalRemarks;
    updateData.feedback = finalRemarks;
  }
  if (followUpAt !== undefined) updateData.followUpAt = followUpAt ? new Date(followUpAt) : null;
  if (walkInDate !== undefined) updateData.walkInDate = walkInDate ? new Date(walkInDate) : null;
  if (clientName !== undefined) updateData.clientName = String(clientName).trim();
  if (dateOfJoin !== undefined) updateData.dateOfJoin = dateOfJoin ? new Date(dateOfJoin) : null;
  if (actualJoiningStatus !== undefined) updateData.actualJoiningStatus = String(actualJoiningStatus).trim();

  // 6. Transactional Execution
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.update({
        where: { id: existing.id },
        data: updateData,
        include: {
          ownerRecruiter: {
            select: { id: true, recruiterId: true, fullName: true, email: true, phone: true },
          },
        },
      });

      // Stage transition recording
      if (updateData.pipelineStage !== undefined && updateData.pipelineStage !== existing.pipelineStage) {
        await (tx as any).candidateStageTransition.create({
          data: {
            candidateId: existing.id,
            fromStage: existing.pipelineStage || null,
            toStage: updateData.pipelineStage,
            changedById: userId || null,
            sourceActivity: sourceActivity || 'MANUAL_UPDATE',
            notes: finalRemarks || null,
          },
        });
      }

      // Application status sync (strictly inside transaction)
      const apps = await tx.application.findMany({
        where: { candidateId: existing.id },
        select: { id: true, status: true },
      });

      for (const app of apps) {
        await tx.application.update({
          where: { id: app.id },
          data: {
            status: updateData.status,
            updatedAt: new Date(),
          },
        });
      }

      return candidate;
    });

    return {
      success: true,
      statusCode: 200,
      message: `Candidate status updated to ${updated.status}.`,
      candidate: updated,
    };
  } catch (err: any) {
    return {
      success: false,
      statusCode: 500,
      message: err?.message || 'Database error while saving candidate status change.',
    };
  }
}

export interface BulkStatusChangeOptions {
  candidateIds: string[];
  userId?: string | null;
  userRole?: string;
  status: string;
  remarks?: string;
  followUpAt?: string | Date;
  walkInDate?: string | Date;
  clientName?: string;
  dateOfJoin?: string | Date;
  actualJoiningStatus?: string;
}

export async function bulkCandidateStatusChange(opts: BulkStatusChangeOptions) {
  const { candidateIds, ...rest } = opts;
  const ids = Array.isArray(candidateIds) ? candidateIds.slice(0, 200) : [];

  if (!ids.length) {
    return {
      success: false,
      statusCode: 400,
      message: 'At least one candidate ID is required (maximum 200 per batch).',
      results: [],
      summary: { total: 0, succeeded: 0, failed: 0 },
    };
  }

  const results: Array<{ id: string; success: boolean; statusCode: number; message: string; candidate?: any }> = [];

  for (const id of ids) {
    try {
      const res = await applyCandidateStatusChange({
        candidateId: id,
        ...rest,
      });
      results.push({
        id,
        success: res.success,
        statusCode: res.statusCode,
        message: res.message,
        candidate: res.candidate,
      });
    } catch (err: any) {
      results.push({
        id,
        success: false,
        statusCode: 500,
        message: err?.message || 'Unknown processing error',
      });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  return {
    success: succeeded > 0,
    statusCode: failed === 0 ? 200 : (succeeded > 0 ? 207 : 400),
    message: `Bulk status update completed: ${succeeded} succeeded, ${failed} failed.`,
    results,
    summary: { total: ids.length, succeeded, failed },
  };
}
