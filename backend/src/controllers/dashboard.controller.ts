import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess } from '../utils/response';

/**
 * 1. Legacy/General Dashboard Stats (Real DB Calculations, No Mock Data, No Payouts)
 * Route: GET /api/dashboard/stats
 */
export const getDashboardStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { range = '30d' } = req.query;

    let dateFilter: Date | undefined;
    if (range === 'today') dateFilter = new Date(new Date().setHours(0, 0, 0, 0));
    else if (range === '7d') dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    else if (range === '30d') dateFilter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    else if (range === '3m') dateFilter = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const appliedFilter = dateFilter ? { appliedAt: { gte: dateFilter } } : {};

    const [
      totalCandidates,
      activeCandidates,
      newCandidates,
      rejectedCandidates,
      activeJobs,
      closedJobs,
      totalApplications,
      shortlistedCount,
      selectedCount,
      joinedCount,
      interviewsCount,
      pendingAssessments,
      pendingOnboarding,
      totalClients,
      pendingInquiries,
      interviewApplications,
      screenedApplications,
      locationRows,
      noticeRows,
    ] = await Promise.all([
      prisma.candidate.count(),
      prisma.candidate.count({ where: { status: { notIn: ['REJECTED', 'DROPPED', 'Rejected', 'Not Interested', 'Not Eligible', 'Withdrawn'] } } }),
      prisma.candidate.count({ where: { status: { in: ['NEW', 'New'] } } }),
      prisma.candidate.count({ where: { status: { in: ['REJECTED', 'Rejected'] } } }),

      prisma.job.count({ where: { status: 'PUBLISHED' } }),
      prisma.job.count({ where: { status: { in: ['CLOSED', 'ARCHIVED'] } } }),
      prisma.application.count({ where: appliedFilter }),
      prisma.application.count({ where: { stage: 'SHORTLISTED', ...appliedFilter } }),
      prisma.application.count({ where: { stage: 'SELECTED', ...appliedFilter } }),
      prisma.application.count({ where: { stage: 'JOINED', ...appliedFilter } }),
      prisma.interview.count({ where: dateFilter ? { scheduledAt: { gte: dateFilter } } : {} }),
      prisma.application.count({ where: { stage: 'ASSESSMENT', ...appliedFilter } }),
      prisma.application.count({ where: { stage: { in: ['SELECTED', 'OFFERED'] }, ...appliedFilter } }),
      prisma.client.count({ where: { status: 'ACTIVE' } }),
      prisma.inquiry.count({ where: { status: 'NEW' } }),
      prisma.application.count({ where: { stage: 'INTERVIEW', ...appliedFilter } }),
      prisma.application.count({ where: { stage: { in: ['SCREENING', 'ASSESSMENT'] }, ...appliedFilter } }),
      prisma.candidate.groupBy({ by: ['location'], _count: { _all: true }, where: { location: { not: '' } }, orderBy: { _count: { location: 'desc' } }, take: 5 }),
      prisma.candidate.groupBy({ by: ['noticePeriodDays'], _count: { _all: true }, orderBy: { _count: { noticePeriodDays: 'desc' } }, take: 10 }),
    ]);

    const totalForRate = Math.max(totalApplications, 1);
    const interviewConversion = Math.round((interviewApplications / totalForRate) * 100);
    const joiningConversion = Math.round((joinedCount / totalForRate) * 100);
    const screeningRatio = Math.round((screenedApplications / totalForRate) * 100);

    const recentApplications = await prisma.application.findMany({
      take: 6,
      orderBy: { appliedAt: 'desc' },
      include: {
        job: { select: { title: true, jobCode: true } },
        candidate: { select: { fullName: true, email: true, location: true } },
      },
    });

    sendSuccess(res, {
      metrics: {
        totalCandidates,
        activeCandidates,
        newCandidates,
        rejectedCandidates,
        activeJobs,
        closedJobs,
        totalApplications,
        shortlistedCount,
        selectedCount,
        joinedCount,
        interviewsCount,
        pendingAssessments,
        pendingOnboarding,
        totalClients,
        pendingInquiries,
        pendingPayoutsAmount: 0,
        totalPayoutClaims: 0,
        interviewConversionRate: interviewConversion + '%',
        joiningConversionRate: joiningConversion + '%',
        screeningRatio: screeningRatio + '%',
        candidateGeography: locationRows.map((r) => ({ location: r.location || 'Not specified', count: r._count?._all ?? 0 })),
        noticePeriodDistribution: noticeRows.map((r) => ({ noticePeriodDays: r.noticePeriodDays, count: r._count._all })),
      },
      recentApplications,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 2. Admin Dashboard (Phases 17 & 19)
 * Route: GET /api/dashboard/admin
 * Real aggregated database counts across candidates, jobs, applications, team members.
 */
export const getAdminDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const todayEnd = new Date(new Date().setHours(23, 59, 59, 999));

    const [
      totalCandidates,
      activeCandidates,
      newCandidates,
      activeJobs,
      closedJobs,
      totalApplications,
      pendingTLReviews,
      shortlistedCount,
      interviewCount,
      selectedCount,
      joinedCount,
      rejectedCount,
      activeRecruiters,
      activeTeamLeaders,
      todayInterviewsCount,
      totalInterviews,
      recentApplications,
      locationRows,
      noticeRows,
    ] = await Promise.all([
      prisma.candidate.count(),
      prisma.candidate.count({ where: { status: { notIn: ['REJECTED', 'DROPPED', 'Rejected', 'Not Interested', 'Not Eligible', 'Withdrawn'] } } }),
      prisma.candidate.count({ where: { status: { in: ['NEW', 'New'] } } }),
      prisma.job.count({ where: { status: 'PUBLISHED' } }),
      prisma.job.count({ where: { status: { in: ['CLOSED', 'ARCHIVED'] } } }),
      prisma.application.count(),
      prisma.application.count({ where: { reviewStatus: 'PENDING_TL_REVIEW' } }),
      prisma.application.count({ where: { stage: 'SHORTLISTED' } }),
      prisma.application.count({ where: { stage: 'INTERVIEW' } }),
      prisma.application.count({ where: { stage: 'SELECTED' } }),
      prisma.application.count({ where: { stage: 'JOINED' } }),
      prisma.application.count({ where: { stage: 'REJECTED' } }),
      prisma.user.count({ where: { role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] }, isActive: true } }),
      prisma.user.count({ where: { role: 'TEAM_LEADER', isActive: true } }),

      prisma.interview.count({ where: { scheduledAt: { gte: todayStart, lte: todayEnd } } }),
      prisma.interview.count(),
      prisma.application.findMany({
        take: 6,
        orderBy: { appliedDate: 'desc' },
        include: {
          job: { select: { id: true, title: true, jobCode: true, department: true } },
          candidate: { select: { id: true, fullName: true, email: true, phone: true, candidateCode: true } },
          recruiter: { select: { id: true, fullName: true, email: true } },
          teamLeader: { select: { id: true, fullName: true, email: true } },
        },
      }),
      prisma.candidate.groupBy({
        by: ['location'],
        _count: { _all: true },
        where: { location: { not: '' } },
        orderBy: { _count: { location: 'desc' } },
        take: 5,
      }),
      prisma.candidate.groupBy({
        by: ['noticePeriodDays'],
        _count: { _all: true },
        orderBy: { _count: { noticePeriodDays: 'desc' } },
        take: 8,
      }),
    ]);

    const totalForRate = Math.max(totalApplications, 1);
    const interviewConversion = Math.round((interviewCount / totalForRate) * 100);
    const joiningConversion = Math.round((joinedCount / totalForRate) * 100);

    sendSuccess(res, {
      metrics: {
        totalCandidates,
        candidateTalentPool: totalCandidates,
        activeCandidates,
        newCandidates,
        activeJobs,
        activeMandates: activeJobs,
        closedJobs,
        totalApplications,
        pendingTLReviews,
        shortlistedCount,
        interviewCount,
        selectedCount,
        offersInPlay: selectedCount,
        joinedCount,
        confirmedPlacements: joinedCount,
        rejectedCount,
        activeRecruiters,
        recruitersCount: activeRecruiters,
        activeTeamLeaders,
        teamLeadersCount: activeTeamLeaders,
        todayInterviewsCount,
        interviewsToday: todayInterviewsCount,
        totalInterviews,
        interviewConversionRate: `${interviewConversion}%`,
        joiningConversionRate: `${joiningConversion}%`,
      },

      pipelineBreakdown: {
        totalApplications,
        pendingReview: pendingTLReviews,
        shortlisted: shortlistedCount,
        interview: interviewCount,
        selected: selectedCount,
        joined: joinedCount,
        rejected: rejectedCount,
      },
      candidateGeography: locationRows.map((r) => ({
        location: r.location || 'Not specified',
        count: r._count?._all ?? 0,
      })),
      noticePeriodDistribution: noticeRows.map((r) => ({
        noticePeriodDays: r.noticePeriodDays,
        count: r._count?._all ?? 0,
      })),
      recentApplications,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 3. Team Leader Dashboard (Phase 18)
 * Route: GET /api/dashboard/tl and GET /api/team-leader/dashboard
 * Real pod-scoped metrics for authenticated TL and their assigned recruiters.
 */
export const getTLDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user!;
    const tlId = user.role === 'TEAM_LEADER' ? user.userId : (req.query.teamLeaderId ? String(req.query.teamLeaderId) : user.userId);

    // 1. Identify recruiters in this TL's pod
    const select = {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      recruiterType: true,
      avatarUrl: true,
      createdAt: true,
      _count: {
        select: {
          sourcedCandidates: true,
          assignedApplications: true,
        },
      },
    };

    const podRecruiters = await prisma.user.findMany({
      where: {
        teamLeaderId: tlId,
        role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
        isActive: true,
      },
      select,
      orderBy: { fullName: 'asc' },
    });


    const recruiterIds = [tlId, ...podRecruiters.map((r) => r.id)];

    // Pod filters
    const applicationPodFilter = {
      OR: [
        { teamLeaderId: tlId },
        { recruiterId: { in: recruiterIds } },
      ],
    };

    const candidatePodFilter = {
      OR: [
        { teamLeaderId: tlId },
        { sourcingRecruiterId: { in: recruiterIds } },
        { ownerRecruiterId: { in: recruiterIds } },
      ],
    };

    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const todayEnd = new Date(new Date().setHours(23, 59, 59, 999));

    const [
      podCandidatesCount,
      podApplicationsCount,
      pendingApprovalsCount,
      approvedCount,
      sentBackCount,
      rejectedCount,
      shortlistedCount,
      interviewCount,
      selectedCount,
      joinedCount,
      todayInterviewsCount,
      assignedJobsCount,
      recentPendingApprovals,
    ] = await Promise.all([
      prisma.candidate.count({ where: candidatePodFilter }),
      prisma.application.count({ where: applicationPodFilter }),
      prisma.application.count({
        where: {
          AND: [
            applicationPodFilter,
            {
              OR: [
                { reviewStatus: 'PENDING_TL_REVIEW' },
                { status: 'Submitted' },
              ],
            },
          ],
        },
      }),
      prisma.application.count({
        where: {
          AND: [applicationPodFilter, { reviewStatus: 'TL_APPROVED' }],
        },
      }),
      prisma.application.count({
        where: {
          AND: [applicationPodFilter, { reviewStatus: 'TL_SENT_BACK' }],
        },
      }),
      prisma.application.count({
        where: {
          AND: [applicationPodFilter, { reviewStatus: 'TL_REJECTED' }],
        },
      }),
      prisma.application.count({
        where: {
          AND: [applicationPodFilter, { stage: 'SHORTLISTED' }],
        },
      }),
      prisma.application.count({
        where: {
          AND: [applicationPodFilter, { stage: 'INTERVIEW' }],
        },
      }),
      prisma.application.count({
        where: {
          AND: [applicationPodFilter, { stage: 'SELECTED' }],
        },
      }),
      prisma.application.count({
        where: {
          AND: [applicationPodFilter, { stage: 'JOINED' }],
        },
      }),
      prisma.interview.count({
        where: {
          application: applicationPodFilter,
          scheduledAt: { gte: todayStart, lte: todayEnd },
        },
      }),
      prisma.job.count({
        where: {
          status: 'PUBLISHED',
          assignedRecruiters: { some: { id: { in: recruiterIds } } },
        },
      }),
      prisma.application.findMany({
        where: {
          AND: [
            applicationPodFilter,
            {
              OR: [
                { reviewStatus: 'PENDING_TL_REVIEW' },
                { status: 'Submitted' },
              ],
            },
          ],
        },
        take: 5,
        orderBy: { appliedDate: 'desc' },
        include: {
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              fullName: true,
              name: true,
              email: true,
              phone: true,
              totalExperience: true,
              currentLocation: true,
            },
          },
          job: {
            select: { id: true, title: true, jobCode: true, department: true },
          },
          recruiter: {
            select: { id: true, fullName: true, email: true },
          },
        },
      }),
    ]);

    sendSuccess(res, {
      metrics: {
        teamMembersCount: podRecruiters.length,
        podCandidatesCount,
        podApplicationsCount,
        pendingApprovalsCount,
        approvedCount,
        sentBackCount,
        rejectedCount,
        shortlistedCount,
        interviewCount,
        selectedCount,
        joinedCount,
        todayInterviewsCount,
        assignedJobsCount,
      },
      teamMembers: podRecruiters,
      recentPendingApprovals,
      pipelineBreakdown: {
        total: podApplicationsCount,
        pendingApprovals: pendingApprovalsCount,
        shortlisted: shortlistedCount,
        interview: interviewCount,
        selected: selectedCount,
        joined: joinedCount,
        rejected: rejectedCount,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 4. Recruiter Dashboard (Phase 17)
 * Route: GET /api/dashboard/recruiter and GET /api/recruiter/dashboard
 * Real recruiter-scoped metrics for authenticated recruiter.
 */
export const getRecruiterDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user!;
    const recruiterId = user.userId;

    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const todayEnd = new Date(new Date().setHours(23, 59, 59, 999));

    const candidateFilter = {
      OR: [
        { sourcingRecruiterId: recruiterId },
        { ownerRecruiterId: recruiterId },
        { createdById: recruiterId },
      ],
    };

    const applicationFilter = {
      OR: [
        { recruiterId },
        { candidate: { sourcingRecruiterId: recruiterId } },
      ],
    };

    const [
      myCandidatesCount,
      myApplicationsCount,
      pendingApprovalsCount,
      shortlistedCount,
      interviewCount,
      selectedCount,
      joinedCount,
      rejectedCount,
      assignedJobsCount,
      assignedJobs,
      todayInterviews,
      recentApplications,
      recentActivities,
    ] = await Promise.all([
      prisma.candidate.count({ where: candidateFilter }),
      prisma.application.count({ where: applicationFilter }),
      prisma.application.count({
        where: {
          AND: [
            applicationFilter,
            {
              OR: [
                { reviewStatus: 'PENDING_TL_REVIEW' },
                { status: 'Submitted' },
              ],
            },
          ],
        },
      }),
      prisma.application.count({
        where: { AND: [applicationFilter, { stage: 'SHORTLISTED' }] },
      }),
      prisma.application.count({
        where: { AND: [applicationFilter, { stage: 'INTERVIEW' }] },
      }),
      prisma.application.count({
        where: { AND: [applicationFilter, { stage: 'SELECTED' }] },
      }),
      prisma.application.count({
        where: { AND: [applicationFilter, { stage: 'JOINED' }] },
      }),
      prisma.application.count({
        where: { AND: [applicationFilter, { stage: 'REJECTED' }] },
      }),
      prisma.job.count({
        where: {
          status: 'PUBLISHED',
          assignedRecruiters: { some: { id: recruiterId } },
        },
      }),
      prisma.job.findMany({
        where: {
          status: 'PUBLISHED',
          assignedRecruiters: { some: { id: recruiterId } },
        },
        select: {
          id: true,
          jobCode: true,
          title: true,
          department: true,
          location: true,
          vacancies: true,
          workMode: true,
        },
        take: 10,
        orderBy: { publishedAt: 'desc' },
      }),
      prisma.interview.findMany({
        where: {
          application: applicationFilter,
          scheduledAt: { gte: todayStart, lte: todayEnd },
        },
        include: {
          application: {
            select: {
              candidate: { select: { fullName: true, phone: true, email: true } },
              job: { select: { title: true, jobCode: true } },
            },
          },
        },
        orderBy: { scheduledAt: 'asc' },
      }),
      prisma.application.findMany({
        where: applicationFilter,
        take: 5,
        orderBy: { appliedDate: 'desc' },
        include: {
          candidate: {
            select: {
              id: true,
              candidateCode: true,
              fullName: true,
              phone: true,
              email: true,
            },
          },
          job: {
            select: { id: true, title: true, jobCode: true },
          },
        },
      }),
      prisma.candidateActivity.findMany({
        where: {
          OR: [
            { recruiterId },
            { userId: recruiterId },
          ],
        },
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: {
          candidate: { select: { fullName: true, candidateCode: true } },
        },
      }),
    ]);

    sendSuccess(res, {
      metrics: {
        myCandidatesCount,
        myApplicationsCount,
        pendingApprovalsCount,
        shortlistedCount,
        interviewCount,
        selectedCount,
        joinedCount,
        rejectedCount,
        assignedJobsCount,
        todayInterviewsCount: todayInterviews.length,
      },
      assignedJobs,
      todayInterviews,
      recentApplications,
      recentActivities,
      pipelineBreakdown: {
        total: myApplicationsCount,
        pendingApprovals: pendingApprovalsCount,
        shortlisted: shortlistedCount,
        interview: interviewCount,
        selected: selectedCount,
        joined: joinedCount,
        rejected: rejectedCount,
      },
    });
  } catch (err) {
    next(err);
  }
};
