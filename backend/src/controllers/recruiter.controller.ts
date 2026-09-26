import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess } from '../utils/response';

export const getRecruiters = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const recruiters = await prisma.user.findMany({
      where: { role: 'RECRUITER' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
        isActive: true,
        createdAt: true,
      },
    });

    sendSuccess(res, {
      recruiters: recruiters.map((r) => ({
        id: r.id,
        userId: r.id,
        name: r.fullName,
        email: r.email,
        phone: r.phone || '',
        location: '',
        recruiterType: 'Internal',
        experience: 0,
        specialization: [],
        assignedJobIds: [],
        submittedCount: 0,
        shortlistedCount: 0,
        interviewedCount: 0,
        selectedCount: 0,
        joinedCount: 0,
        replacementCount: 0,
        totalPayoutEarned: 0,
        pendingPayout: 0,
        status: r.isActive ? 'Active' : 'Inactive',
        avatar: r.avatarUrl || undefined,
      })),
      pagination: { total: recruiters.length, page: 1, limit: recruiters.length || 1, totalPages: 1 },
    });
  } catch (err) {
    next(err);
  }
};
