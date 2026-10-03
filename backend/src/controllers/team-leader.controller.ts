import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { logCandidateTimeline } from '../services/timeline.service';
import { logAudit } from '../services/audit.service';

export const CANONICAL_SEND_BACK_REASONS = [
  'Experience mismatch',
  'Salary mismatch',
  'Location mismatch',
  'Communication issue',
  'Incomplete profile',
  'Missing document',
  'Other',
] as const;

const sendBackSchema = z.object({
  reason: z.enum(CANONICAL_SEND_BACK_REASONS, {
    errorMap: () => ({
      message: `Reason must be one of: ${CANONICAL_SEND_BACK_REASONS.join(', ')}`,
    }),
  }),
  remarks: z.string().trim().min(3, 'Remarks must be at least 3 characters long'),
});

const approveSchema = z.object({
  remarks: z.string().trim().optional(),
});

const rejectSchema = z.object({
  reason: z.string().trim().optional(),
  remarks: z.string().trim().optional(),
});

/**
 * Helper to check if a Team Leader or Admin has authority over an application
 */
const canTLAccessApplication = async (
  userId: string,
  userRole: string,
  applicationId: string
) => {
  if (userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') {
    return true;
  }

  if (userRole !== 'TEAM_LEADER') {
    return false;
  }

  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      teamLeaderId: true,
      recruiter: {
        select: { teamLeaderId: true },
      },
      candidate: {
        select: { teamLeaderId: true, sourcingRecruiterId: true },
      },
    },
  });

  if (!app) return false;

  return (
    app.teamLeaderId === userId ||
    app.recruiter?.teamLeaderId === userId ||
    app.candidate?.teamLeaderId === userId
  );
};

/**
 * A. Fetch Pending Approvals: GET /api/team-leader/pending-approvals
 * Access: TEAM_LEADER, ADMIN, SUPER_ADMIN
 * Filter: Candidates/applications where status === 'Submitted' or reviewStatus === 'PENDING_TL_REVIEW'
 * Pod scope: If TL, only submissions from recruiters belonging to this TL's pod
 */
export const getPendingApprovals = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user!;
    const { search, page = '1', limit = '20', jobId } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const andFilters: any[] = [
      {
        OR: [
          { status: 'Submitted' },
          { reviewStatus: 'PENDING_TL_REVIEW' },
        ],
      },
    ];

    // TL Data Ownership Filtering: Pod-restricted
    if (user.role === 'TEAM_LEADER') {
      andFilters.push({
        OR: [
          { teamLeaderId: user.userId },
          { recruiter: { teamLeaderId: user.userId } },
          { candidate: { teamLeaderId: user.userId } },
        ],
      });
    }

    if (jobId) {
      andFilters.push({ jobId: String(jobId) });
    }

    if (search) {
      const q = String(search).trim();
      andFilters.push({
        OR: [
          { applicationCode: { contains: q, mode: 'insensitive' } },
          { candidate: { name: { contains: q, mode: 'insensitive' } } },
          { candidate: { fullName: { contains: q, mode: 'insensitive' } } },
          { candidate: { candidateCode: { contains: q, mode: 'insensitive' } } },
          { candidate: { email: { contains: q, mode: 'insensitive' } } },
          { candidate: { phone: { contains: q, mode: 'insensitive' } } },
          { job: { title: { contains: q, mode: 'insensitive' } } },
          { job: { jobCode: { contains: q, mode: 'insensitive' } } },
          { recruiter: { fullName: { contains: q, mode: 'insensitive' } } },
        ],
      });
    }

    const where = { AND: andFilters };

    const [total, applications] = await Promise.all([
      prisma.application.count({ where }),
      prisma.application.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { appliedDate: 'desc' },
        include: {
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              name: true,
              fullName: true,
              phone: true,
              email: true,
              gender: true,
              currentLocation: true,
              location: true,
              totalExperience: true,
              relevantExperience: true,
              experienceYears: true,
              highestQualification: true,
              education: true,
              currentCompany: true,
              currentDesignation: true,
              noticePeriod: true,
              currentSalary: true,
              expectedSalary: true,
              skills: true,
              resumeUrl: true,
              status: true,
              sourcingRecruiter: {
                select: { id: true, fullName: true, email: true },
              },
              teamLeader: {
                select: { id: true, fullName: true, email: true },
              },
            },
          },
          job: {
            select: {
              id: true,
              jobCode: true,
              title: true,
              department: true,
              location: true,
              workMode: true,
              experienceMin: true,
              experienceMax: true,
              salaryText: true,
            },
          },
          recruiter: {
            select: {
              id: true,
              fullName: true,
              email: true,
              recruiterType: true,
            },
          },
          teamLeader: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
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

/**
 * B. TL Approve Candidate: POST /api/team-leader/applications/:id/approve
 * - Sets application.reviewStatus = 'TL_APPROVED'
 * - Moves candidate/application status to 'Shortlisted'
 * - Creates an audit timeline record
 */
export const approveApplication = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const body = approveSchema.parse(req.body);
    const user = req.user!;

    const hasAccess = await canTLAccessApplication(user.userId, user.role, id);
    if (!hasAccess) {
      sendError(res, 'You are not authorized to approve applications outside your pod.', 403);
      return;
    }

    const application = await prisma.application.findUnique({
      where: { id },
      include: {
        candidate: { select: { id: true, fullName: true, name: true, candidateCode: true } },
        job: { select: { id: true, title: true, jobCode: true } },
      },
    });

    if (!application) {
      sendError(res, 'Application not found', 404);
      return;
    }

    const remarks = body.remarks || 'Approved for client technical round.';
    const previousStatus = application.status || application.stage;

    const updatedApp = await prisma.$transaction(async (tx) => {
      // 1. Update Application
      const updated = await tx.application.update({
        where: { id },
        data: {
          reviewStatus: 'TL_APPROVED',
          status: 'Shortlisted',
          stage: 'SHORTLISTED',
          teamLeaderId: user.role === 'TEAM_LEADER' ? user.userId : application.teamLeaderId,
        },
      });

      // 2. Update Candidate Status
      await tx.candidate.update({
        where: { id: application.candidateId },
        data: {
          status: 'Shortlisted',
          ...(user.role === 'TEAM_LEADER' && !application.teamLeaderId
            ? { teamLeaderId: user.userId }
            : {}),
        },
      });

      // 3. Create Audit Timeline record
      await logCandidateTimeline({
        candidateId: application.candidateId,
        applicationId: application.id,
        userId: user.userId,
        userName: user.email,
        userRole: user.role,
        action: 'TL Approved',
        previousStatus,
        newStatus: 'Shortlisted',
        remarks,
        client: tx,
      });

      return updated;
    });

    await logAudit({
      req,
      action: 'TL_APPROVE_APPLICATION',
      module: 'TEAM_LEADER_GATEWAY',
      entity: 'Application',
      entityId: id,
      oldValue: { status: previousStatus, reviewStatus: application.reviewStatus },
      newValue: { status: 'Shortlisted', reviewStatus: 'TL_APPROVED' },
    });

    sendSuccess(
      res,
      { application: updatedApp },
      `Candidate application approved and moved to Shortlisted stage.`
    );
  } catch (err) {
    next(err);
  }
};

/**
 * C. TL Send Back Candidate: POST /api/team-leader/applications/:id/send-back
 * - Validates reason from 7 canonical reasons
 * - Sets application.reviewStatus = 'TL_SENT_BACK'
 * - Moves status back to 'Screening'
 * - Creates an audit timeline record
 */
export const sendBackApplication = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason, remarks } = sendBackSchema.parse(req.body);
    const user = req.user!;

    const hasAccess = await canTLAccessApplication(user.userId, user.role, id);
    if (!hasAccess) {
      sendError(res, 'You are not authorized to send back applications outside your pod.', 403);
      return;
    }

    const application = await prisma.application.findUnique({
      where: { id },
      include: {
        candidate: { select: { id: true, fullName: true, name: true, candidateCode: true } },
        job: { select: { id: true, title: true, jobCode: true } },
      },
    });

    if (!application) {
      sendError(res, 'Application not found', 404);
      return;
    }

    const previousStatus = application.status || application.stage;
    const formattedRemarks = `Reason: ${reason}. Remarks: ${remarks}`;

    const updatedApp = await prisma.$transaction(async (tx) => {
      // 1. Update Application
      const updated = await tx.application.update({
        where: { id },
        data: {
          reviewStatus: 'TL_SENT_BACK',
          sendBackReason: reason,
          sendBackRemarks: remarks,
          status: 'Screening',
          stage: 'SCREENING',
          teamLeaderId: user.role === 'TEAM_LEADER' ? user.userId : application.teamLeaderId,
        },
      });

      // 2. Update Candidate Status back to Screening
      await tx.candidate.update({
        where: { id: application.candidateId },
        data: {
          status: 'Screening',
        },
      });

      // 3. Create Audit Timeline record
      await logCandidateTimeline({
        candidateId: application.candidateId,
        applicationId: application.id,
        userId: user.userId,
        userName: user.email,
        userRole: user.role,
        action: 'Sent Back by TL',
        previousStatus,
        newStatus: 'Screening',
        remarks: formattedRemarks,
        client: tx,
      });

      return updated;
    });

    await logAudit({
      req,
      action: 'TL_SEND_BACK_APPLICATION',
      module: 'TEAM_LEADER_GATEWAY',
      entity: 'Application',
      entityId: id,
      oldValue: { status: previousStatus, reviewStatus: application.reviewStatus },
      newValue: {
        status: 'Screening',
        reviewStatus: 'TL_SENT_BACK',
        sendBackReason: reason,
        sendBackRemarks: remarks,
      },
    });

    sendSuccess(
      res,
      { application: updatedApp },
      `Application sent back to recruiter for revision. Stage moved to Screening.`
    );
  } catch (err) {
    next(err);
  }
};

/**
 * D. TL Reject Candidate: POST /api/team-leader/applications/:id/reject
 * - Sets status = 'Rejected', reviewStatus = 'TL_REJECTED'
 * - Logs timeline event with rejection reason
 */
export const rejectApplication = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const body = rejectSchema.parse(req.body);
    const user = req.user!;

    const hasAccess = await canTLAccessApplication(user.userId, user.role, id);
    if (!hasAccess) {
      sendError(res, 'You are not authorized to reject applications outside your pod.', 403);
      return;
    }

    const application = await prisma.application.findUnique({
      where: { id },
      include: {
        candidate: { select: { id: true, fullName: true, name: true, candidateCode: true } },
        job: { select: { id: true, title: true, jobCode: true } },
      },
    });

    if (!application) {
      sendError(res, 'Application not found', 404);
      return;
    }

    const previousStatus = application.status || application.stage;
    const rejectionRemarks = body.remarks || body.reason || 'Candidate rejected by Team Leader.';

    const updatedApp = await prisma.$transaction(async (tx) => {
      // 1. Update Application
      const updated = await tx.application.update({
        where: { id },
        data: {
          reviewStatus: 'TL_REJECTED',
          status: 'Rejected',
          stage: 'REJECTED',
          rejectionReason: rejectionRemarks,
          teamLeaderId: user.role === 'TEAM_LEADER' ? user.userId : application.teamLeaderId,
        },
      });

      // 2. Update Candidate Status
      await tx.candidate.update({
        where: { id: application.candidateId },
        data: {
          status: 'Rejected',
        },
      });

      // 3. Create Audit Timeline record
      await logCandidateTimeline({
        candidateId: application.candidateId,
        applicationId: application.id,
        userId: user.userId,
        userName: user.email,
        userRole: user.role,
        action: 'Rejected by TL',
        previousStatus,
        newStatus: 'Rejected',
        remarks: rejectionRemarks,
        client: tx,
      });

      return updated;
    });

    await logAudit({
      req,
      action: 'TL_REJECT_APPLICATION',
      module: 'TEAM_LEADER_GATEWAY',
      entity: 'Application',
      entityId: id,
      oldValue: { status: previousStatus, reviewStatus: application.reviewStatus },
      newValue: { status: 'Rejected', reviewStatus: 'TL_REJECTED' },
    });

    sendSuccess(
      res,
      { application: updatedApp },
      `Application rejected by Team Leader.`
    );
  } catch (err) {
    next(err);
  }
};

/**
 * Pod Team Members: GET /api/team-leader/team-members
 * Lists recruiters belonging to this Team Leader's pod with candidate & application counts
 */
export const getTeamMembers = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user!;

    const where: any = {
      role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
      isActive: true,
    };

    if (user.role === 'TEAM_LEADER') {
      where.teamLeaderId = user.userId;
    }

    const recruiters = await prisma.user.findMany({
      where,
      select: {
        id: true,
        recruiterId: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        recruiterType: true,
        avatarUrl: true,
        createdAt: true,
        _count: {
          select: {
            sourcedCandidates: true,
            assignedApplications: true,
            assignedJobs: true,
          },
        },
      },
      orderBy: { fullName: 'asc' },
    });

    sendSuccess(res, { teamMembers: recruiters });
  } catch (err) {
    next(err);
  }
};
