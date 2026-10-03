import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';

/**
 * Global Search API: GET /api/search
 * Fast indexed search across Candidate Name, Phone, Email, Candidate Code,
 * Job Code, Job Title, Recruiter Name, Team Leader Name.
 * Populates complete relationship lineage.
 */
export const globalSearch = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const rawQuery = String(req.query.q || req.query.query || req.query.search || '').trim();
    if (!rawQuery) {
      sendSuccess(res, {
        candidates: [],
        jobs: [],
        query: '',
        totalResults: 0,
      });
      return;
    }

    const user = req.user;
    const userRole = user?.role;
    const currentUserId = user?.userId;

    // Build Candidate RBAC filter
    const candidateRbacFilters: any[] = [];
    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      candidateRbacFilters.push({
        OR: [
          { sourcingRecruiterId: currentUserId },
          { ownerRecruiterId: currentUserId },
          { createdById: currentUserId },
          { applications: { some: { recruiterId: currentUserId } } },
        ],
      });
    } else if (userRole === 'TEAM_LEADER') {
      candidateRbacFilters.push({
        OR: [
          { teamLeaderId: currentUserId },
          { sourcingRecruiter: { teamLeaderId: currentUserId } },
          { sourcingRecruiterId: currentUserId },
          { ownerRecruiterId: currentUserId },
        ],
      });
    }

    // Build Job RBAC filter
    const jobRbacFilters: any[] = [];
    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      jobRbacFilters.push({
        assignedRecruiters: { some: { id: currentUserId } },
      });
    } else if (userRole === 'TEAM_LEADER') {
      jobRbacFilters.push({
        assignedRecruiters: {
          some: {
            OR: [
              { id: currentUserId },
              { teamLeaderId: currentUserId },
            ],
          },
        },
      });
    }

    // Candidate Search OR conditions:
    const candidateSearchFilter = {
      OR: [
        { candidateCode: { contains: rawQuery, mode: 'insensitive' as const } },
        { name: { contains: rawQuery, mode: 'insensitive' as const } },
        { fullName: { contains: rawQuery, mode: 'insensitive' as const } },
        { phone: { contains: rawQuery, mode: 'insensitive' as const } },
        { email: { contains: rawQuery, mode: 'insensitive' as const } },
        { sourcingRecruiter: { fullName: { contains: rawQuery, mode: 'insensitive' as const } } },
        { teamLeader: { fullName: { contains: rawQuery, mode: 'insensitive' as const } } },
        {
          applications: {
            some: {
              OR: [
                { job: { jobCode: { contains: rawQuery, mode: 'insensitive' as const } } },
                { job: { title: { contains: rawQuery, mode: 'insensitive' as const } } },
              ],
            },
          },
        },
      ],
    };

    const candidateWhere = {
      AND: [candidateSearchFilter, ...candidateRbacFilters],
    };

    // Job Search OR conditions:
    const jobSearchFilter = {
      OR: [
        { jobCode: { contains: rawQuery, mode: 'insensitive' as const } },
        { title: { contains: rawQuery, mode: 'insensitive' as const } },
        { department: { contains: rawQuery, mode: 'insensitive' as const } },
        { location: { contains: rawQuery, mode: 'insensitive' as const } },
        { skills: { has: rawQuery } },
      ],
    };

    const jobWhere = {
      AND: [jobSearchFilter, ...jobRbacFilters],
    };

    const [candidates, jobs] = await Promise.all([
      prisma.candidate.findMany({
        where: candidateWhere,
        take: 30,
        orderBy: { createdAt: 'desc' },
        include: {
          sourcingRecruiter: { select: { id: true, fullName: true, email: true } },
          teamLeader: { select: { id: true, fullName: true, email: true } },
          ownerRecruiter: { select: { id: true, fullName: true, email: true } },
          applications: {
            orderBy: { appliedDate: 'desc' },
            take: 1,
            include: {
              job: {
                select: { id: true, jobCode: true, title: true, department: true },
              },
            },
          },
        },
      }),
      prisma.job.findMany({
        where: jobWhere,
        take: 20,
        orderBy: { publishedAt: 'desc' },
        select: {
          id: true,
          jobCode: true,
          title: true,
          slug: true,
          department: true,
          location: true,
          workMode: true,
          status: true,
          vacancies: true,
        },
      }),
    ]);

    // Format Candidate Lineage matching spec format:
    // { candidateCode, name, phone, email, status, sourcingRecruiterName, teamLeaderName, targetJobCode, targetJobTitle }
    const formattedCandidates = candidates.map((cand) => {
      const latestApp = cand.applications[0];
      return {
        id: cand.id,
        candidateCode: cand.candidateCode,
        name: cand.name || cand.fullName,
        phone: cand.phone,
        email: cand.email,
        status: cand.status,
        sourcingRecruiterName:
          cand.sourcingRecruiter?.fullName ||
          cand.ownerRecruiter?.fullName ||
          null,
        teamLeaderName: cand.teamLeader?.fullName || null,
        targetJobCode: latestApp?.job?.jobCode || null,
        targetJobTitle: latestApp?.job?.title || null,
        totalExperience: cand.totalExperience ?? cand.experienceYears,
        location: cand.currentLocation || cand.location,
        resumeUrl: cand.resumeUrl,
        createdAt: cand.createdAt,
      };
    });

    sendSuccess(res, {
      candidates: formattedCandidates,
      jobs,
      query: rawQuery,
      totalResults: formattedCandidates.length + jobs.length,
    });
  } catch (err) {
    next(err);
  }
};
