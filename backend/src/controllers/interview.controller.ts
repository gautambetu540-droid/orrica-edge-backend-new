import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { sendInterviewScheduledEmailAsync } from '../services/email.service';
import { logAudit } from '../services/audit.service';

const scheduleInterviewSchema = z.object({
  applicationId: z.string().uuid(),
  roundName: z.string().min(2).max(120),
  scheduledAt: z.string().datetime(),
  interviewerName: z.string().min(2).max(120),
  meetingLink: z.string().url().optional(),
  notes: z.string().max(5000).optional(),
});

const updateInterviewSchema = z.object({
  status: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELLED', 'RESCHEDULED', 'NO_SHOW']),
  feedbackRating: z.coerce.number().int().min(1).max(5).optional(),
  feedbackNotes: z.string().max(5000).nullable().optional(),
});

const canRecruiterAccessApplication = (
  req: Request,
  application: { recruiterId: string | null; candidate: { ownerRecruiterId: string | null } }
): boolean =>
  req.user?.role !== 'RECRUITER' ||
  application.recruiterId === req.user.userId ||
  application.candidate.ownerRecruiterId === req.user.userId;

export const scheduleInterview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = scheduleInterviewSchema.parse(req.body);

    const application = await prisma.application.findUnique({
      where: { id: data.applicationId },
      include: {
        job: { select: { id: true, title: true } },
        candidate: {
          select: { id: true, fullName: true, email: true, ownerRecruiterId: true },
        },
      },
    });

    if (!application) {
      sendError(res, 'Application not found', 404);
      return;
    }

    if (!canRecruiterAccessApplication(req, application)) {
      sendError(res, 'Application not found', 404);
      return;
    }

    const scheduledDate = new Date(data.scheduledAt);
    const effectiveRecruiterId =
      application.recruiterId ||
      application.candidate.ownerRecruiterId ||
      (req.user?.role === 'RECRUITER' ? req.user.userId : null);

    const interview = await prisma.$transaction(async (tx) => {
      const created = await tx.interview.create({
        data: {
          applicationId: data.applicationId,
          roundName: data.roundName,
          scheduledAt: scheduledDate,
          interviewerName: data.interviewerName,
          meetingLink: data.meetingLink,
          status: 'SCHEDULED',
        },
      });

      await tx.application.update({
        where: { id: application.id },
        data: { stage: 'INTERVIEW', recruiterId: effectiveRecruiterId },
      });

      await tx.candidate.update({
        where: { id: application.candidateId },
        data: { status: 'INTERVIEW' },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: application.candidateId,
          userId: req.user?.userId || null,
          recruiterId: effectiveRecruiterId,
          applicationId: application.id,
          jobId: application.jobId,
          action: 'INTERVIEW_SCHEDULED',
          notes: data.notes || null,
          metadata: { interviewId: created.id, roundName: data.roundName },
        },
      });

      return created;
    });

    sendInterviewScheduledEmailAsync(
      application.candidate.fullName,
      application.candidate.email,
      application.job.title,
      data.roundName,
      scheduledDate,
      data.meetingLink
    );

    await logAudit({
      req,
      action: 'SCHEDULE_INTERVIEW',
      module: 'INTERVIEWS',
      entity: 'Interview',
      entityId: interview.id,
      newValue: { roundName: data.roundName, scheduledAt: data.scheduledAt, applicationId: application.id },
    });

    sendSuccess(res, { interview }, 'Interview scheduled and candidate notification sent');
  } catch (err) {
    next(err);
  }
};

export const updateInterviewStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const data = updateInterviewSchema.parse(req.body);
    const existing = await prisma.interview.findUnique({
      where: { id },
      include: {
        application: {
          select: {
            id: true,
            recruiterId: true,
            candidate: { select: { ownerRecruiterId: true } },
          },
        },
      },
    });

    if (!existing || !canRecruiterAccessApplication(req, existing.application)) {
      sendError(res, 'Interview not found', 404);
      return;
    }

    const updated = await prisma.interview.update({
      where: { id },
      data: {
        status: data.status,
        feedbackRating: data.feedbackRating,
        feedbackNotes: data.feedbackNotes,
      },
    });

    await logAudit({
      req,
      action: 'UPDATE_INTERVIEW_STATUS',
      module: 'INTERVIEWS',
      entity: 'Interview',
      entityId: id,
      oldValue: { status: existing.status, feedbackRating: existing.feedbackRating },
      newValue: { status: updated.status, feedbackRating: updated.feedbackRating },
    });

    sendSuccess(res, { interview: updated }, 'Interview status updated');
  } catch (err) {
    next(err);
  }
};
