import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { sendInterviewScheduledEmail } from '../services/email.service';
import { logAudit } from '../services/audit.service';

const scheduleInterviewSchema = z.object({
  applicationId: z.string().uuid(),
  roundName: z.string().min(2),
  scheduledAt: z.string().datetime(),
  interviewerName: z.string().min(2),
  meetingLink: z.string().url().optional(),
  notes: z.string().optional(),
});

export const scheduleInterview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = scheduleInterviewSchema.parse(req.body);

    const application = await prisma.application.findUnique({
      where: { id: data.applicationId },
      include: {
        job: true,
        candidate: true,
      },
    });

    if (!application) {
      sendError(res, 'Application not found', 404);
      return;
    }

    const scheduledDate = new Date(data.scheduledAt);

    const interview = await prisma.interview.create({
      data: {
        applicationId: data.applicationId,
        roundName: data.roundName,
        scheduledAt: scheduledDate,
        interviewerName: data.interviewerName,
        meetingLink: data.meetingLink,
        status: 'SCHEDULED',
      },
    });

    // Update application stage to INTERVIEW
    await prisma.application.update({
      where: { id: application.id },
      data: { stage: 'INTERVIEW' },
    });

    // Send automatic email to candidate
    await sendInterviewScheduledEmail(
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
      newValue: { roundName: data.roundName, scheduledAt: data.scheduledAt },
    });

    sendSuccess(res, { interview }, 'Interview scheduled and candidate notification sent');
  } catch (err) {
    next(err);
  }
};

export const updateInterviewStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, feedbackRating, feedbackNotes } = req.body;

    const interview = await prisma.interview.update({
      where: { id },
      data: {
        status: status as any,
        feedbackRating: feedbackRating ? parseInt(feedbackRating, 10) : undefined,
        feedbackNotes,
      },
    });

    sendSuccess(res, { interview }, 'Interview status updated');
  } catch (err) {
    next(err);
  }
};
