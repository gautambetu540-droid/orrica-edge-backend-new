import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { analyzeAtsMatch } from '../services/ats.service';
import { uploadResumeFile } from '../services/storage.service';
import { sendApplicationReceivedEmailAsync } from '../services/email.service';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';

const applySchema = z.object({
  jobId: z.string().uuid(),
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  location: z.string().min(2),
  experienceYears: z.coerce.number().min(0).default(0),
  skills: z.preprocess((val) => {
    if (typeof val === 'string') {
      return val.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return val;
  }, z.array(z.string()).default([])),
  languages: z.preprocess((val) => {
    if (typeof val === 'string') {
      return val.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return val;
  }, z.array(z.string()).default(['English'])),
  currentCompany: z.string().optional(),
  currentDesignation: z.string().optional(),
  currentCtc: z.coerce.number().optional(),
  expectedCtc: z.coerce.number().optional(),
  noticePeriodDays: z.coerce.number().optional(),
});

// 1. Submit Application with Resume Upload (High Performance & Non-blocking Email)
export const applyForJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = applySchema.parse(req.body);

    if (!req.file) {
      sendError(res, 'Resume file is required (PDF or DOC/DOCX up to 5MB)', 400);
      return;
    }

    // Verify target job exists
    const job = await prisma.job.findUnique({
      where: { id: data.jobId },
      select: {
        id: true,
        title: true,
        jobCode: true,
        skills: true,
        experienceMin: true,
        experienceMax: true,
        location: true,
        workMode: true,
        languages: true,
      },
    });

    if (!job) {
      sendError(res, 'Target job opening not found', 404);
      return;
    }

    // Upload to S3 / Local storage
    const uploadResult = await uploadResumeFile(req.file, data.fullName);

    // Compute ATS match in memory
    const atsMatch = analyzeAtsMatch(
      {
        skills: data.skills,
        experienceYears: data.experienceYears,
        location: data.location,
        languages: data.languages,
      },
      {
        skills: job.skills,
        experienceMin: job.experienceMin,
        experienceMax: job.experienceMax,
        location: job.location,
        workMode: job.workMode,
        languages: job.languages,
      }
    );

    // Atomic transaction for Candidate upsert and Application creation
    const { candidate, application } = await prisma.$transaction(async (tx) => {
      // Upsert candidate
      const cand = await tx.candidate.upsert({
        where: { email: data.email },
        update: {
          fullName: data.fullName,
          phone: data.phone,
          location: data.location,
          skills: data.skills,
          languages: data.languages,
          resumeUrl: uploadResult.fileUrl,
          experienceYears: data.experienceYears,
          currentCompany: data.currentCompany,
          currentDesignation: data.currentDesignation,
          currentCtc: data.currentCtc,
          expectedCtc: data.expectedCtc,
          noticePeriodDays: data.noticePeriodDays,
        },
        create: {
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          location: data.location,
          skills: data.skills,
          languages: data.languages,
          resumeUrl: uploadResult.fileUrl,
          experienceYears: data.experienceYears,
          currentCompany: data.currentCompany,
          currentDesignation: data.currentDesignation,
          currentCtc: data.currentCtc,
          expectedCtc: data.expectedCtc,
          noticePeriodDays: data.noticePeriodDays,
        },
      });

      // Prevent duplicate application
      const existingApp = await tx.application.findUnique({
        where: {
          jobId_candidateId: {
            jobId: job.id,
            candidateId: cand.id,
          },
        },
      });

      if (existingApp) {
        throw new Error('DUPLICATE_APPLICATION');
      }

      // Create application
      const app = await tx.application.create({
        data: {
          jobId: job.id,
          candidateId: cand.id,
          stage: 'APPLIED',
          atsScore: atsMatch.score,
          matchReason: atsMatch.matchReason,
          missingSkills: atsMatch.missingSkills,
          timeline: [
            {
              stage: 'APPLIED',
              timestamp: new Date().toISOString(),
              action: 'Application submitted online',
            },
          ],
        },
      });

      return { candidate: cand, application: app };
    });

    // Fire non-blocking email in background (does not slow down response)
    sendApplicationReceivedEmailAsync(candidate.fullName, candidate.email, job.title);

    sendSuccess(
      res,
      {
        applicationId: application.id,
        candidateId: candidate.id,
        jobTitle: job.title,
        atsScore: atsMatch.score,
        matchReason: atsMatch.matchReason,
      },
      'Application submitted successfully! Confirmation sent to your email.',
      201
    );
  } catch (err: any) {
    if (err.message === 'DUPLICATE_APPLICATION') {
      sendError(res, 'You have already submitted an application for this position.', 409);
      return;
    }
    next(err);
  }
};

// 2. Get Applications (ATS Pipeline - Recruiter/Admin)
export const getApplications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { jobId, stage, search, page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (jobId) where.jobId = jobId as string;
    if (stage) where.stage = stage as any;
    if (search) {
      where.candidate = {
        OR: [
          { fullName: { contains: search as string, mode: 'insensitive' } },
          { email: { contains: search as string, mode: 'insensitive' } },
          { location: { contains: search as string, mode: 'insensitive' } },
        ],
      };
    }

    const [total, applications] = await Promise.all([
      prisma.application.count({ where }),
      prisma.application.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { appliedAt: 'desc' },
        select: {
          id: true,
          stage: true,
          atsScore: true,
          matchReason: true,
          missingSkills: true,
          appliedAt: true,
          job: {
            select: { id: true, title: true, jobCode: true, department: true },
          },
          candidate: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              location: true,
              experienceYears: true,
              skills: true,
              resumeUrl: true,
            },
          },
          recruiter: {
            select: { id: true, fullName: true, email: true },
          },
        },
      }),
    ]);

    sendSuccess(res, {
      applications,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// 3. Update Pipeline Stage
export const updateApplicationStage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { stage, rejectionReason, note } = req.body;

    const application = await prisma.application.findUnique({ where: { id } });
    if (!application) {
      sendError(res, 'Application not found', 404);
      return;
    }

    const existingNotes = Array.isArray(application.internalNotes) ? application.internalNotes : [];
    if (note) {
      existingNotes.push({
        note,
        addedBy: req.user?.email || 'Recruiter',
        timestamp: new Date().toISOString(),
      });
    }

    const timeline = Array.isArray(application.timeline) ? application.timeline : [];
    timeline.push({
      stage,
      timestamp: new Date().toISOString(),
      action: `Moved to ${stage} by ${req.user?.email || 'Recruiter'}`,
    });

    const updated = await prisma.application.update({
      where: { id },
      data: {
        stage: stage as any,
        rejectionReason: stage === 'REJECTED' ? rejectionReason : null,
        internalNotes: existingNotes,
        timeline,
      },
    });

    await logAudit({
      req,
      action: 'UPDATE_APPLICATION_STAGE',
      module: 'ATS',
      entity: 'Application',
      entityId: id,
      oldValue: { stage: application.stage },
      newValue: { stage: updated.stage },
    });

    sendSuccess(res, { application: updated }, `Candidate stage moved to ${stage}`);
  } catch (err) {
    next(err);
  }
};
