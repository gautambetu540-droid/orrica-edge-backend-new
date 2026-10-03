import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { analyzeAtsMatch } from '../services/ats.service';
import { uploadResumeFile } from '../services/storage.service';
import { sendApplicationReceivedEmailAsync } from '../services/email.service';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';
import { generateCandidateCode, generateApplicationCode } from '../utils/codeGenerators';
import { logCandidateTimeline } from '../services/timeline.service';

const applySchema = z.object({
  jobId: z.string().uuid(),
  fullName: z.string().min(2),
  name: z.string().optional(),
  email: z.string().email(),
  phone: z.string().min(7),
  location: z.string().min(2),
  currentLocation: z.string().optional(),
  experienceYears: z.coerce.number().min(0).default(0),
  totalExperience: z.coerce.number().optional(),
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
  }, z.array(z.string()).default(['English', 'Hindi'])),
  currentCompany: z.string().optional(),
  currentDesignation: z.string().optional(),
  currentCtc: z.coerce.number().optional(),
  expectedCtc: z.coerce.number().optional(),
  currentSalary: z.coerce.number().optional(),
  expectedSalary: z.coerce.number().optional(),
  noticePeriodDays: z.coerce.number().optional(),
  noticePeriod: z.union([z.string(), z.number()]).optional(),
  education: z.string().optional(),
  highestQualification: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
});

// 1. Submit Application with Resume Upload
export const applyForJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = applySchema.parse(req.body);

    // Verify target job exists and is open
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
      sendError(res, 'Target job opening is unavailable or closed.', 404);
      return;
    }

    // Upload resume to S3 or local storage
    const uploadResult = req.file ? await uploadResumeFile(req.file, data.fullName) : null;

    // Compute ATS match in memory
    const experience = data.totalExperience ?? data.experienceYears ?? 0;
    const atsMatch = analyzeAtsMatch(
      {
        skills: data.skills,
        experienceYears: experience,
        location: data.currentLocation || data.location,
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

    const candidateName = data.name || data.fullName;
    const candidateLocation = data.currentLocation || data.location;
    const qual = data.highestQualification || data.education || null;
    const currSal = data.currentSalary ?? data.currentCtc ?? null;
    const expSal = data.expectedSalary ?? data.expectedCtc ?? null;
    const notice = data.noticePeriod ? String(data.noticePeriod) : (data.noticePeriodDays ? `${data.noticePeriodDays} Days` : null);

    // Atomic transaction for Candidate upsert and Application creation
    const { candidate, application } = await prisma.$transaction(async (tx) => {
      // Upsert candidate
      const existingCandidate = await tx.candidate.findUnique({
        where: { email: data.email.toLowerCase() },
        select: {
          id: true,
          candidateCode: true,
          resumeUrl: true,
          sourcingRecruiterId: true,
          teamLeaderId: true,
        },
      });

      let generatedCandidateCode = existingCandidate?.candidateCode;
      if (!generatedCandidateCode) {
        generatedCandidateCode = await generateCandidateCode(tx);
      }

      const cand = await tx.candidate.upsert({
        where: { email: data.email.toLowerCase() },
        update: {
          name: candidateName,
          fullName: candidateName,
          phone: data.phone,
          currentLocation: candidateLocation,
          location: candidateLocation,
          skills: data.skills,
          languages: data.languages,
          ...(uploadResult ? { resumeUrl: uploadResult.fileUrl } : {}),
          totalExperience: experience,
          experienceYears: experience,
          currentCompany: data.currentCompany,
          currentDesignation: data.currentDesignation,
          currentSalary: currSal,
          expectedSalary: expSal,
          currentCtc: currSal,
          expectedCtc: expSal,
          noticePeriod: notice,
          noticePeriodDays: data.noticePeriodDays,
          highestQualification: qual,
          education: qual,
          source: data.source || 'Website Direct',
          notes: data.notes,
        },
        create: {
          candidateCode: generatedCandidateCode,
          name: candidateName,
          fullName: candidateName,
          email: data.email.toLowerCase(),
          phone: data.phone,
          currentLocation: candidateLocation,
          location: candidateLocation,
          skills: data.skills,
          languages: data.languages,
          resumeUrl: uploadResult?.fileUrl || '',
          totalExperience: experience,
          experienceYears: experience,
          currentCompany: data.currentCompany,
          currentDesignation: data.currentDesignation,
          currentSalary: currSal,
          expectedSalary: expSal,
          currentCtc: currSal,
          expectedCtc: expSal,
          noticePeriod: notice,
          noticePeriodDays: data.noticePeriodDays,
          highestQualification: qual,
          education: qual,
          source: data.source || 'Website Direct',
          notes: data.notes,
          status: 'Submitted',
        },
      });

      // Prevent duplicate application for the same job
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

      // Generate Application Code APP-XXXXXX
      const applicationCode = await generateApplicationCode(tx);

      // Create application with PENDING_TL_REVIEW status and pod linkage
      const app = await tx.application.create({
        data: {
          applicationCode,
          jobId: job.id,
          candidateId: cand.id,
          recruiterId: cand.sourcingRecruiterId || cand.ownerRecruiterId || null,
          teamLeaderId: cand.teamLeaderId || null,
          status: 'Submitted',
          stage: 'APPLIED',
          reviewStatus: 'PENDING_TL_REVIEW',
          appliedDate: new Date(),
          atsScore: atsMatch.score,
          matchReason: atsMatch.matchReason,
          missingSkills: atsMatch.missingSkills,
          timeline: [
            {
              stage: 'Submitted',
              timestamp: new Date().toISOString(),
              action: 'Application submitted online',
            },
          ],
        },
      });

      // Audit Timeline
      await logCandidateTimeline({
        candidateId: cand.id,
        applicationId: app.id,
        action: 'Application Submitted',
        newStatus: 'Submitted',
        remarks: `Candidate applied online for ${job.title} (${app.applicationCode})`,
        client: tx,
      });

      return { candidate: cand, application: app };
    });

    // Fire non-blocking email in background
    sendApplicationReceivedEmailAsync(candidate.fullName, candidate.email, job.title);

    sendSuccess(
      res,
      {
        applicationId: application.id,
        applicationCode: application.applicationCode,
        candidateId: candidate.id,
        candidateCode: candidate.candidateCode,
        jobTitle: job.title,
        appliedDate: application.appliedDate,
        status: application.status,
        reviewStatus: application.reviewStatus,
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

// 2. Get Applications (ATS Pipeline - Recruiter/Team Leader/Admin)
export const getApplications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      jobId,
      stage,
      status,
      reviewStatus,
      recruiterId,
      teamLeaderId,
      search,
      page = '1',
      limit = '20',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;
    const filters: any[] = [];

    if (jobId) filters.push({ jobId: jobId as string });
    if (stage) filters.push({ stage: stage as any });
    if (status) filters.push({ status: String(status) });
    if (reviewStatus) filters.push({ reviewStatus: String(reviewStatus) as any });
    if (recruiterId) filters.push({ recruiterId: String(recruiterId) });
    if (teamLeaderId) filters.push({ teamLeaderId: String(teamLeaderId) });

    if (search) {
      const q = String(search).trim();
      filters.push({
        OR: [
          { applicationCode: { contains: q, mode: 'insensitive' } },
          { candidate: { name: { contains: q, mode: 'insensitive' } } },
          { candidate: { fullName: { contains: q, mode: 'insensitive' } } },
          { candidate: { email: { contains: q, mode: 'insensitive' } } },
          { candidate: { phone: { contains: q, mode: 'insensitive' } } },
          { candidate: { candidateCode: { contains: q, mode: 'insensitive' } } },
          { job: { title: { contains: q, mode: 'insensitive' } } },
          { job: { jobCode: { contains: q, mode: 'insensitive' } } },
        ],
      });
    }

    const user = req.user;
    if (user?.role === 'RECRUITER' || user?.role === 'FREELANCE_RECRUITER') {
      filters.push({
        OR: [
          { recruiterId: user.userId },
          { candidate: { sourcingRecruiterId: user.userId } },
          { candidate: { ownerRecruiterId: user.userId } },
        ],
      });
    } else if (user?.role === 'TEAM_LEADER') {
      filters.push({
        OR: [
          { teamLeaderId: user.userId },
          { recruiter: { teamLeaderId: user.userId } },
          { candidate: { teamLeaderId: user.userId } },
          { candidate: { sourcingRecruiterId: user.userId } },
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
        orderBy: { appliedDate: 'desc' },
        select: {
          id: true,
          applicationCode: true,
          status: true,
          stage: true,
          reviewStatus: true,
          sendBackReason: true,
          sendBackRemarks: true,
          appliedDate: true,
          appliedAt: true,
          atsScore: true,
          matchReason: true,
          missingSkills: true,
          job: {
            select: { id: true, title: true, jobCode: true, department: true, location: true },
          },
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              name: true,
              fullName: true,
              email: true,
              phone: true,
              currentLocation: true,
              location: true,
              totalExperience: true,
              experienceYears: true,
              highestQualification: true,
              currentCompany: true,
              noticePeriod: true,
              currentSalary: true,
              expectedSalary: true,
              skills: true,
              resumeUrl: true,
              status: true,
            },
          },
          recruiter: {
            select: { id: true, fullName: true, email: true, recruiterType: true },
          },
          teamLeader: {
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
      'New',
      'Contacted',
      'Interested',
      'Screening',
      'Eligible',
      'Submitted',
      'Shortlisted',
      'Assessment',
      'Interview Scheduled',
      'Interview Completed',
      'Selected',
      'Joining Pending',
      'Joined',
      'Rejected',
      'On Hold',
      'Not Interested',
      'No Response',
      'Not Eligible',
      'Withdrawn',
      'Duplicate',
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
      sendError(res, 'Invalid pipeline stage.', 400);
      return;
    }

    const application = await prisma.application.findUnique({
      where: { id },
      include: {
        candidate: {
          select: {
            id: true,
            candidateCode: true,
            fullName: true,
            sourcingRecruiterId: true,
            teamLeaderId: true,
            ownerRecruiterId: true,
          },
        },
        job: { select: { id: true, title: true } },
      },
    });

    if (!application) {
      sendError(res, 'Application not found', 404);
      return;
    }

    const isAdmin = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN';
    const isTeamLeader = req.user?.role === 'TEAM_LEADER';
    const isRecruiter = req.user?.role === 'RECRUITER' || req.user?.role === 'FREELANCE_RECRUITER';

    if (isRecruiter) {
      const currentUserId = req.user?.userId;
      const ownsCandidate =
        application.candidate.sourcingRecruiterId === currentUserId ||
        application.candidate.ownerRecruiterId === currentUserId ||
        application.recruiterId === currentUserId;

      if (!ownsCandidate) {
        sendError(res, 'You are not authorized to update this application.', 403);
        return;
      }
    }

    if (isTeamLeader) {
      const currentUserId = req.user?.userId;
      const ownsPod =
        application.teamLeaderId === currentUserId ||
        application.candidate.teamLeaderId === currentUserId;

      if (!ownsPod) {
        sendError(res, 'You are not authorized to update applications outside your pod.', 403);
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

    const previousStatus = application.status || application.stage;

    // Map canonical stage string to Prisma ApplicationStage enum for backward compatibility
    const mapStageToEnum = (s: string) => {
      const upper = s.toUpperCase();
      if (upper === 'JOINED') return 'JOINED';
      if (upper === 'SELECTED') return 'SELECTED';
      if (upper === 'REJECTED') return 'REJECTED';
      if (upper.includes('INTERVIEW')) return 'INTERVIEW';
      if (upper.includes('ASSESSMENT')) return 'ASSESSMENT';
      if (upper.includes('SHORTLISTED')) return 'SHORTLISTED';
      if (upper.includes('SCREENING') || upper.includes('ELIGIBLE')) return 'SCREENING';
      return 'APPLIED';
    };

    const updated = await prisma.$transaction(async (tx) => {
      const nextApplication = await tx.application.update({
        where: { id },
        data: {
          status: String(stage),
          stage: mapStageToEnum(String(stage)) as any,
          rejectionReason: String(stage).toUpperCase() === 'REJECTED' ? rejectionReason || null : null,
          internalNotes: existingNotes,
          timeline,
        },
      });

      await tx.candidate.update({
        where: { id: application.candidateId },
        data: { status: String(stage) },
      });

      // Audit Timeline Logging
      await logCandidateTimeline({
        candidateId: application.candidateId,
        applicationId: application.id,
        userId: req.user?.userId || null,
        userName: req.user?.email,
        userRole: req.user?.role,
        action: 'Stage Changed',
        previousStatus,
        newStatus: String(stage),
        remarks: note || `Candidate stage moved to ${String(stage)} by ${req.user?.email || 'User'}`,
        client: tx,
      });

      await tx.candidateActivity.create({
        data: {
          candidateId: application.candidateId,
          userId: req.user?.userId || null,
          recruiterId: application.recruiterId,
          applicationId: application.id,
          jobId: application.jobId,
          action:
            String(stage).toUpperCase() === 'SELECTED'
              ? 'SELECTED'
              : String(stage).toUpperCase() === 'JOINED'
                ? 'JOINED'
                : String(stage).toUpperCase() === 'REJECTED'
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
      oldValue: { stage: application.stage, status: application.status },
      newValue: { stage: updated.stage, status: updated.status },
    });

    sendSuccess(res, { application: updated }, `Candidate stage moved to ${String(stage)}`);
  } catch (err) {
    next(err);
  }
};
