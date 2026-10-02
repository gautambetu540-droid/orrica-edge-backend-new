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
  education: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
});

// 1. Submit Application with Resume Upload (High Performance & Non-blocking Email)
export const applyForJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = applySchema.parse(req.body);

    // Verify target job exists
    const job = await prisma.job.findUnique({
      where: { id: data.jobId, status: 'PUBLISHED' },
      select: {
        id: true,
        status: true,
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
      sendError(res, 'Target job opening is unavailable', 404);
      return;
    }

    // Upload to S3 / Local storage
    const uploadResult = req.file ? await uploadResumeFile(req.file, data.fullName) : null;

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
      const existingCandidate = await tx.candidate.findUnique({
        where: { email: data.email },
        select: { candidateCode: true },
      });

      const nextCode = async () => {
        if (existingCandidate?.candidateCode) return existingCandidate.candidateCode;

        const rows = await tx.candidate.findMany({
          select: { candidateCode: true },
          orderBy: { candidateCode: 'desc' },
          take: 1,
        });

        const current = rows[0]?.candidateCode
          ? Number(rows[0].candidateCode.replace('OE-CAND-', ''))
          : 0;

        return `OE-CAND-${String((Number.isFinite(current) ? current : 0) + 1).padStart(4, '0')}`;
      };

      const generatedCandidateCode = await nextCode();

      const cand = await tx.candidate.upsert({
        where: { email: data.email },
        update: {
          fullName: data.fullName,
          phone: data.phone,
          location: data.location,
          skills: data.skills,
          languages: data.languages,
          resumeUrl: uploadResult?.fileUrl || '',
          experienceYears: data.experienceYears,
          currentCompany: data.currentCompany,
          currentDesignation: data.currentDesignation,
          currentCtc: data.currentCtc,
          expectedCtc: data.expectedCtc,
          noticePeriodDays: data.noticePeriodDays,
          education: data.education,
          source: data.source || 'Website Direct',
          notes: data.notes,
        },
        create: {
          candidateCode: generatedCandidateCode,
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
          education: data.education,
          source: data.source || 'Website Direct',
          notes: data.notes,
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
        appliedAt: application.appliedAt,
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
    const filters: any[] = [];

    if (jobId) filters.push({ jobId: jobId as string });
    if (stage) filters.push({ stage: stage as any });
    if (search) {
      filters.push({
        candidate: {
          OR: [
            { fullName: { contains: search as string, mode: 'insensitive' } },
            { email: { contains: search as string, mode: 'insensitive' } },
            { location: { contains: search as string, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (req.user?.role === 'RECRUITER') {
      filters.push({
        OR: [
          { recruiterId: req.user.userId },
          { candidate: { ownerRecruiterId: req.user.userId } },
        ],
      });
    }

    const where = filters.length ? { AND: filters } : {};

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

    const validStages = [
      'APPLIED',
      'SCREENING',
      'ASSESSMENT',
      'INTERVIEW',
      'SHORTLISTED',
      'SELECTED',
      'OFFERED',
      'JOINED',
      'REJECTED',
    ];

    if (!validStages.includes(String(stage))) {
      sendError(res, 'Invalid application stage.', 400);
      return;
    }

    const application = await prisma.application.findUnique({
      where: { id },
      include: {
        candidate: {
          select: { id: true, candidateCode: true, fullName: true, ownerRecruiterId: true },
        },
        job: { select: { id: true, title: true } },
      },
    });

    if (!application) {
      sendError(res, 'Application not found', 404);
      return;
    }

    const isAdmin = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN';
    const isRecruiter = req.user?.role === 'RECRUITER';

    if (isRecruiter) {
      const currentUserId = req.user?.userId;
      const ownsCandidate =
        application.candidate.ownerRecruiterId === currentUserId ||
        application.recruiterId === currentUserId;

      if (!ownsCandidate) {
        sendError(res, 'You are not authorized to update this application.', 403);
        return;
      }
    }

    const existingNotes = Array.isArray(application.internalNotes) ? application.internalNotes : [];
    if (note) {
      existingNotes.push({
        note: String(note),
        addedBy: req.user?.email || 'User',
        timestamp: new Date().toISOString(),
      });
    }

    const timeline = Array.isArray(application.timeline) ? application.timeline : [];
    timeline.push({
      stage: String(stage),
      timestamp: new Date().toISOString(),
      action: `Moved to ${String(stage)} by ${req.user?.email || 'User'}`,
    });

    const effectiveRecruiterId =
      application.recruiterId ||
      application.candidate.ownerRecruiterId ||
      (isRecruiter ? req.user?.userId : null) ||
      null;

    const updated = await prisma.$transaction(async (tx) => {
      const nextApplication = await tx.application.update({
        where: { id },
        data: {
          stage: String(stage) as any,
          recruiterId: effectiveRecruiterId,
          rejectionReason: String(stage) === 'REJECTED' ? rejectionReason || null : null,
          internalNotes: existingNotes,
          timeline,
        },
      });

      const candidateStatus =
        String(stage) === 'JOINED'
          ? 'JOINED'
          : String(stage) === 'SELECTED'
            ? 'SELECTED'
            : String(stage) === 'REJECTED'
              ? 'REJECTED'
              : String(stage) === 'INTERVIEW'
                ? 'INTERVIEW'
                : String(stage) === 'SHORTLISTED'
                  ? 'SHORTLISTED'
                  : 'SCREENING';

      await tx.candidate.update({
        where: { id: application.candidateId },
        data: { status: candidateStatus as any },
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: application.candidateId,
          userId: req.user?.userId || null,
          recruiterId: effectiveRecruiterId,
          applicationId: application.id,
          jobId: application.jobId,
          action:
            String(stage) === 'SELECTED'
              ? 'SELECTED'
              : String(stage) === 'JOINED'
                ? 'JOINED'
                : String(stage) === 'REJECTED'
                  ? 'REJECTED'
                  : 'STATUS_UPDATED',
          notes: note || null,
          metadata: {
            previousStage: application.stage,
            newStage: String(stage),
            updatedBy: req.user?.userId || null,
            adminOverride: isAdmin,
          },
        },
      });

      return nextApplication;
    });

    await logAudit({
      req,
      action: 'UPDATE_APPLICATION_STAGE',
      module: 'ATS',
      entity: 'Application',
      entityId: id,
      oldValue: { stage: application.stage, recruiterId: application.recruiterId },
      newValue: { stage: updated.stage, recruiterId: updated.recruiterId },
    });

    sendSuccess(res, { application: updated }, `Candidate stage moved to ${String(stage)}`);
  } catch (err) {
    next(err);
  }
};
