import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess } from '../utils/response';

export const getDashboardStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { range = '30d' } = req.query;

    let dateFilter: Date | undefined;
    const now = new Date();
    if (range === 'today') {
      dateFilter = new Date(now.setHours(0, 0, 0, 0));
    } else if (range === '7d') {
      dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } else if (range === '30d') {
      dateFilter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    } else if (range === '3m') {
      dateFilter = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    }

    const appliedFilter = dateFilter ? { appliedAt: { gte: dateFilter } } : {};

    const [
      totalCandidates,
      activeJobs,
      totalApplications,
      interviewsCount,
      selectedCount,
      joinedCount,
      totalClients,
      pendingInquiries,
    ] = await Promise.all([
      prisma.candidate.count(),
      prisma.job.count({ where: { status: 'PUBLISHED' } }),
      prisma.application.count({ where: appliedFilter }),
      prisma.interview.count(),
      prisma.application.count({ where: { stage: 'SELECTED', ...appliedFilter } }),
      prisma.application.count({ where: { stage: 'JOINED', ...appliedFilter } }),
      prisma.client.count({ where: { status: 'ACTIVE' } }),
      prisma.inquiry.count({ where: { status: 'NEW' } }),
    ]);

    // Conversion rates
    const interviewConversion = totalApplications > 0
      ? Math.round((interviewsCount / totalApplications) * 100)
      : 0;
    const joiningConversion = totalApplications > 0
      ? Math.round((joinedCount / totalApplications) * 100)
      : 0;

    // Recent applications feed
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
        activeJobs,
        totalApplications,
        interviewsCount,
        selectedCount,
        joinedCount,
        totalClients,
        pendingInquiries,
        interviewConversionRate: `${interviewConversion}%`,
        joiningConversionRate: `${joiningConversion}%`,
      },
      recentApplications,
    });
  } catch (err) {
    next(err);
  }
};
