import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess } from '../utils/response';

export const getDashboardStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { range = '30d' } = req.query;

    let dateFilter: Date | undefined;
    const now = new Date();
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
      pendingPayouts,
      totalPayoutClaims,
      interviewApplications,
      screenedApplications,
      locationRows,
      noticeRows,
    ] = await Promise.all([
      prisma.candidate.count(),
      prisma.candidate.count({ where: { status: { in: ['NEW', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'SELECTED', 'ON_HOLD'] } } }),
      prisma.candidate.count({ where: { status: 'NEW' } }),
      prisma.candidate.count({ where: { status: 'REJECTED' } }),
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
      prisma.payout.aggregate({ _sum: { amount: true }, where: { status: { in: ['PENDING', 'ELIGIBLE'] } } }),
      prisma.payout.count({ where: { status: { in: ['PENDING', 'ELIGIBLE', 'PAID'] } } }),
      prisma.application.count({ where: { stage: 'INTERVIEW', ...appliedFilter } }),
      prisma.application.count({ where: { stage: { in: ['SCREENING', 'ASSESSMENT'] }, ...appliedFilter } }),
      prisma.candidate.groupBy({ by: ['location'], _count: { _all: true }, where: { location: { not: null } }, orderBy: { _count: { location: 'desc' } }, take: 5 }),
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
        pendingPayoutsAmount: Number(pendingPayouts._sum.amount || 0),
        totalPayoutClaims,
        interviewConversionRate: interviewConversion + '%',
        joiningConversionRate: joiningConversion + '%',
        screeningRatio: screeningRatio + '%',
        candidateGeography: locationRows.map((r) => ({ location: r.location || 'Not specified', count: r._count._all })),
        noticePeriodDistribution: noticeRows.map((r) => ({ noticePeriodDays: r.noticePeriodDays, count: r._count._all })),
      },
      recentApplications,
    });
  } catch (err) {
    next(err);
  }
};
