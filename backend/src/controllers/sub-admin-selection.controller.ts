import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { computeWorkingDays } from '../utils/workingDays';

const SELECTED_STATUSES = [
  'Selected',
  'Joined',
  'SELECTED',
  'JOINED',
  'selected',
  'joined',
  'Selected (Not Joined Yet)',
  'Joining Pending',
  'Joining Scheduled',
];

const parseDate = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const buildDateFilter = (from?: Date, to?: Date) => {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  };
};

/**
 * Helper to build team recruiter IDs and codes for a given Sub-Admin
 */
export const getSubAdminTeamRecruiters = async (subAdminId: string) => {
  const directRecruiters = await prisma.user.findMany({
    where: {
      OR: [
        { teamLeaderId: subAdminId },
        { id: subAdminId },
      ],
      isActive: true,
    },
    select: {
      id: true,
      recruiterId: true,
      fullName: true,
      email: true,
      role: true,
      phone: true,
    },
  });

  // Also include recruiters reporting to team leaders who report to this sub-admin
  const tlIds = directRecruiters.filter((u) => u.role === 'TEAM_LEADER').map((u) => u.id);
  let nestedRecruiters: typeof directRecruiters = [];
  if (tlIds.length > 0) {
    nestedRecruiters = await prisma.user.findMany({
      where: {
        teamLeaderId: { in: tlIds },
        isActive: true,
      },
      select: {
        id: true,
        recruiterId: true,
        fullName: true,
        email: true,
        role: true,
        phone: true,
      },
    });
  }

  const allTeamUsers = [...directRecruiters, ...nestedRecruiters];
  const uniqueMap = new Map<string, (typeof allTeamUsers)[0]>();
  for (const u of allTeamUsers) {
    uniqueMap.set(u.id, u);
  }

  const teamList = Array.from(uniqueMap.values());
  const userIds = teamList.map((u) => u.id);
  const recruiterCodes = teamList.map((u) => u.recruiterId).filter(Boolean) as string[];

  return {
    teamList,
    userIds,
    recruiterCodes,
    allMatchIds: Array.from(new Set([...userIds, ...recruiterCodes])),
  };
};

/**
 * 1. GET /api/v1/candidates/sub-admin/list
 * Returns list of all Sub-Admins with summary counts (assigned recruiters, total selections)
 * RBAC: Super Admin & Admin see all Sub-Admins. Sub-Admin sees only themselves.
 */
export const getSubAdminsList = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'ADMIN' && userRole !== 'SUB_ADMIN') {
      sendError(res, 'Forbidden: Insufficient privileges to view Sub-Admin roster.', 403);
      return;
    }

    const whereUser: any = {
      role: 'SUB_ADMIN',
      isActive: true,
    };

    if (userRole === 'SUB_ADMIN') {
      whereUser.id = currentUserId;
    }

    const subAdmins = await prisma.user.findMany({
      where: whereUser,
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
      },
      orderBy: { fullName: 'asc' },
    });

    // Populate team recruiter and candidate count for each Sub-Admin
    const listWithStats = await Promise.all(
      subAdmins.map(async (sa) => {
        const { userIds, allMatchIds, teamList } = await getSubAdminTeamRecruiters(sa.id);
        const recruitersOnly = teamList.filter((r) => r.id !== sa.id);

        const totalSelectedCount = await prisma.candidate.count({
          where: {
            isArchived: false,
            OR: [
              { status: { in: SELECTED_STATUSES } },
              { actualJoiningStatus: { not: null } },
              { selectionDate: { not: null } },
            ],
            AND: [
              {
                OR: [
                  { teamLeaderId: sa.id },
                  { ownerRecruiterId: { in: allMatchIds } },
                  { sourcingRecruiterId: { in: allMatchIds } },
                  { createdById: sa.id },
                  { assignedRecruiterIds: { hasSome: allMatchIds } },
                  {
                    applications: {
                      some: {
                        OR: [
                          { recruiterId: { in: allMatchIds } },
                          { teamLeaderId: sa.id },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
        });

        return {
          id: sa.id,
          name: sa.fullName,
          email: sa.email,
          phone: sa.phone,
          role: sa.role,
          totalRecruiters: recruitersOnly.length,
          totalSelectedCandidates: totalSelectedCount,
          recruiters: recruitersOnly.map((r) => ({
            id: r.id,
            name: r.fullName,
            recruiterId: r.recruiterId,
            email: r.email,
          })),
        };
      })
    );

    sendSuccess(res, { subAdmins: listWithStats });
  } catch (err) {
    next(err);
  }
};

/**
 * 2. GET /api/v1/candidates/sub-admin/selected-candidates
 * Returns filtered, paginated candidate selection records attributed to Sub-Admins.
 * Provides live performance KPI cards (Total Selected, Joined, Pending Joining, Not Joined, Total Recruiters, Active Selections).
 */
export const getSubAdminSelectedCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'ADMIN' && userRole !== 'SUB_ADMIN') {
      sendError(res, 'Forbidden: Insufficient privileges to view Sub-Admin selections.', 403);
      return;
    }

    const {
      subAdminId,
      recruiterId,
      clientId,
      joiningStatus,
      dateFrom,
      dateTo,
      search,
      sortBy = 'selection_newest',
      page = '1',
      limit = '50',
    } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    // RBAC: Sub-Admin can ONLY see their own team's candidate records!
    let targetSubAdminId: string = String(subAdminId || 'ALL');
    if (userRole === 'SUB_ADMIN') {
      targetSubAdminId = currentUserId || '';
    }

    const andFilters: any[] = [
      { isArchived: false },
      {
        OR: [
          { status: { in: SELECTED_STATUSES } },
          { actualJoiningStatus: { not: null } },
          { selectionDate: { not: null } },
        ],
      },
    ];

    // Find all Sub-Admins in the system for lookup
    const allSubAdmins = await prisma.user.findMany({
      where: { role: 'SUB_ADMIN', isActive: true },
      select: { id: true, fullName: true, email: true },
    });
    const subAdminMap = new Map<string, { id: string; fullName: string; email: string }>(
      allSubAdmins.map((sa) => [sa.id, sa])
    );

    let activeTeamRecruitersCount = 0;

    // Sub-Admin Specific Filter
    if (targetSubAdminId !== 'ALL' && targetSubAdminId) {
      const { allMatchIds, teamList } = await getSubAdminTeamRecruiters(targetSubAdminId);
      activeTeamRecruitersCount = teamList.filter((r) => r.id !== targetSubAdminId).length;

      andFilters.push({
        OR: [
          { teamLeaderId: targetSubAdminId },
          { ownerRecruiterId: { in: allMatchIds } },
          { sourcingRecruiterId: { in: allMatchIds } },
          { createdById: targetSubAdminId },
          { assignedRecruiterIds: { hasSome: allMatchIds } },
          {
            applications: {
              some: {
                OR: [
                  { recruiterId: { in: allMatchIds } },
                  { teamLeaderId: targetSubAdminId },
                ],
              },
            },
          },
          {
            timelines: {
              some: {
                userId: { in: allMatchIds },
                action: { in: ['STATUS_CHANGE', 'STAGE_CHANGE', 'SELECTED'] },
                newStatus: { in: ['Selected', 'Joined'] },
              },
            },
          },
        ],
      });
    } else {
      // Total active recruiters in the platform
      activeTeamRecruitersCount = await prisma.user.count({
        where: {
          role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] },
          isActive: true,
        },
      });
    }

    // Recruiter filter
    if (recruiterId && recruiterId !== 'ALL') {
      const rId = String(recruiterId).trim();
      andFilters.push({
        OR: [
          { ownerRecruiterId: rId },
          { sourcingRecruiterId: rId },
          { assignedRecruiterIds: { has: rId } },
          { applications: { some: { recruiterId: rId } } },
        ],
      });
    }

    // Client filter
    if (clientId && clientId !== 'ALL') {
      const cStr = String(clientId).trim();
      andFilters.push({
        OR: [
          { clientId: cStr },
          { clientName: { contains: cStr, mode: 'insensitive' } },
        ],
      });
    }

    // Joining status filter
    if (joiningStatus && joiningStatus !== 'ALL') {
      const jStatus = String(joiningStatus).trim();
      if (jStatus === 'Selected') {
        andFilters.push({
          OR: [
            { actualJoiningStatus: 'Selected' },
            { actualJoiningStatus: 'Selected (Not Joined Yet)' },
            { status: 'Selected' },
          ],
        });
      } else if (jStatus === 'Joined') {
        andFilters.push({
          OR: [
            { actualJoiningStatus: 'Joined' },
            { status: 'Joined' },
          ],
        });
      } else if (jStatus === 'Working') {
        andFilters.push({
          OR: [
            { actualJoiningStatus: 'Working' },
            { totalWorkingDays: { gt: 0 } },
          ],
        });
      } else if (jStatus === 'Not Joined') {
        andFilters.push({
          OR: [
            { actualJoiningStatus: 'Not Joined' },
            { actualJoiningStatus: 'Offer Dropped' },
            { actualJoiningStatus: 'Rejected' },
          ],
        });
      } else if (jStatus === 'Exited') {
        andFilters.push({
          actualJoiningStatus: 'Exited',
        });
      } else {
        andFilters.push({
          OR: [
            { actualJoiningStatus: jStatus },
            { status: jStatus },
          ],
        });
      }
    }

    // Date range filter (selectionDate or fallback)
    const fromDate = parseDate(dateFrom);
    const toDate = parseDate(dateTo);
    if (toDate) toDate.setHours(23, 59, 59, 999);
    const selectionDateFilter = buildDateFilter(fromDate, toDate);
    if (selectionDateFilter) {
      andFilters.push({
        OR: [
          { selectionDate: selectionDateFilter },
          { dateOfJoin: selectionDateFilter },
        ],
      });
    }

    // Search filter
    if (search) {
      const q = String(search).trim();
      const phoneDigits = q.replace(/\D/g, '');
      const searchOr: any[] = [
        { candidateCode: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { clientName: { contains: q, mode: 'insensitive' } },
      ];
      if (phoneDigits.length >= 4) {
        searchOr.push({ phone: { contains: phoneDigits } });
      }
      andFilters.push({ OR: searchOr });
    }

    const where = { AND: andFilters };

    // Sorting
    let orderBy: any = { selectionDate: 'desc' };
    if (sortBy === 'selection_oldest') {
      orderBy = { selectionDate: 'asc' };
    } else if (sortBy === 'doj_asc') {
      orderBy = { dateOfJoin: 'asc' };
    } else if (sortBy === 'doj_desc') {
      orderBy = { dateOfJoin: 'desc' };
    } else if (sortBy === 'name_asc') {
      orderBy = { fullName: 'asc' };
    } else if (sortBy === 'working_days_desc') {
      orderBy = { totalWorkingDays: 'desc' };
    }

    // Query Total Count and Records in Parallel
    const [total, rawCandidates, allMatchingCandidatesForStats] = await Promise.all([
      prisma.candidate.count({ where }),
      prisma.candidate.findMany({
        where,
        take: limitNum,
        skip,
        orderBy: [orderBy, { id: 'desc' }],
        include: {
          client: { select: { id: true, companyName: true } },
          ownerRecruiter: {
            select: {
              id: true,
              fullName: true,
              email: true,
              recruiterId: true,
              teamLeaderId: true,
              teamLeader: { select: { id: true, fullName: true, email: true, role: true } },
            },
          },
          sourcingRecruiter: {
            select: {
              id: true,
              fullName: true,
              email: true,
              recruiterId: true,
              teamLeaderId: true,
              teamLeader: { select: { id: true, fullName: true, email: true, role: true } },
            },
          },
          teamLeader: { select: { id: true, fullName: true, email: true, role: true } },
          createdBy: { select: { id: true, fullName: true, email: true, role: true } },
          applications: {
            orderBy: { appliedAt: 'desc' },
            take: 2,
            include: {
              job: { select: { id: true, title: true, jobCode: true, department: true } },
              recruiter: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  recruiterId: true,
                  teamLeaderId: true,
                  teamLeader: { select: { id: true, fullName: true, email: true, role: true } },
                },
              },
              teamLeader: { select: { id: true, fullName: true, email: true, role: true } },
            },
          },
        },
      }),
      // Aggregate stats for this scope
      prisma.candidate.findMany({
        where,
        select: {
          id: true,
          status: true,
          actualJoiningStatus: true,
          totalWorkingDays: true,
          ownerRecruiterId: true,
          sourcingRecruiterId: true,
        },
      }),
    ]);

    // Format Candidate Rows
    const candidates = rawCandidates.map((c) => {
      // Determine Attributed Sub-Admin
      let resolvedSubAdminId: string | null = null;
      let resolvedSubAdminName = 'Direct Admin / Unassigned';
      let resolvedSubAdminEmail: string | null = null;

      if (c.teamLeader?.role === 'SUB_ADMIN') {
        resolvedSubAdminId = c.teamLeader.id;
        resolvedSubAdminName = c.teamLeader.fullName;
        resolvedSubAdminEmail = c.teamLeader.email;
      } else if (c.ownerRecruiter?.teamLeader?.role === 'SUB_ADMIN') {
        resolvedSubAdminId = c.ownerRecruiter.teamLeader.id;
        resolvedSubAdminName = c.ownerRecruiter.teamLeader.fullName;
        resolvedSubAdminEmail = c.ownerRecruiter.teamLeader.email;
      } else if (c.sourcingRecruiter?.teamLeader?.role === 'SUB_ADMIN') {
        resolvedSubAdminId = c.sourcingRecruiter.teamLeader.id;
        resolvedSubAdminName = c.sourcingRecruiter.teamLeader.fullName;
        resolvedSubAdminEmail = c.sourcingRecruiter.teamLeader.email;
      } else if (c.createdBy?.role === 'SUB_ADMIN') {
        resolvedSubAdminId = c.createdBy.id;
        resolvedSubAdminName = c.createdBy.fullName;
        resolvedSubAdminEmail = c.createdBy.email;
      } else if (c.applications?.[0]?.teamLeader?.role === 'SUB_ADMIN') {
        resolvedSubAdminId = c.applications[0].teamLeader.id;
        resolvedSubAdminName = c.applications[0].teamLeader.fullName;
        resolvedSubAdminEmail = c.applications[0].teamLeader.email;
      } else if (c.applications?.[0]?.recruiter?.teamLeader?.role === 'SUB_ADMIN') {
        resolvedSubAdminId = c.applications[0].recruiter.teamLeader.id;
        resolvedSubAdminName = c.applications[0].recruiter.teamLeader.fullName;
        resolvedSubAdminEmail = c.applications[0].recruiter.teamLeader.email;
      } else if (targetSubAdminId !== 'ALL' && subAdminMap.has(targetSubAdminId)) {
        const sa = subAdminMap.get(targetSubAdminId)!;
        resolvedSubAdminId = sa.id;
        resolvedSubAdminName = sa.fullName;
        resolvedSubAdminEmail = sa.email;
      }

      // Determine Assigned Recruiter
      const primaryRecruiter =
        c.ownerRecruiter ||
        c.sourcingRecruiter ||
        c.applications?.[0]?.recruiter ||
        null;
      const assignedRecruiterName = primaryRecruiter?.fullName || 'Platform Recruiter';
      const assignedRecruiterCode = primaryRecruiter?.recruiterId || '—';
      const assignedRecruiterId = primaryRecruiter?.id || c.ownerRecruiterId || c.sourcingRecruiterId || null;

      // Determine Job / Process
      const primaryJob = c.applications?.[0]?.job;
      const jobTitle = primaryJob?.title || primaryJob?.jobCode || 'Direct Talent Pool';

      // Joining Status
      const effectiveJoiningStatus =
        c.actualJoiningStatus || (c.status === 'Joined' ? 'Joined' : 'Selected');

      // Live working days
      let workingDays = c.totalWorkingDays !== null && c.totalWorkingDays !== undefined ? c.totalWorkingDays : 0;
      if (c.totalWorkingDays === null || c.totalWorkingDays === undefined) {
        const computed = computeWorkingDays(
          c.actualJoiningStatus || c.status,
          c.dateOfJoin || undefined,
          c.lastWorkingDate || undefined
        );
        workingDays = computed.totalWorkingDays || 0;
      }

      return {
        id: c.id,
        candidateCode: c.candidateCode,
        name: c.name || c.fullName,
        fullName: c.fullName,
        phone: c.phone,
        email: c.email,
        clientName: c.clientName || c.client?.companyName || '—',
        clientId: c.clientId,
        jobTitle,
        jobCode: primaryJob?.jobCode || null,
        subAdminId: resolvedSubAdminId,
        subAdminName: resolvedSubAdminName,
        subAdminEmail: resolvedSubAdminEmail,
        assignedRecruiterId,
        assignedRecruiterName,
        assignedRecruiterCode,
        selectionDate: c.selectionDate,
        dateOfJoin: c.dateOfJoin,
        actualJoiningStatus: effectiveJoiningStatus,
        totalWorkingDays: workingDays,
        lastWorkingDate: c.lastWorkingDate,
        updatedAt: c.updatedAt,
        resumeUrl: c.resumeUrl,
      };
    });

    // Calculate Dynamic Performance Dashboard Stats
    let totalJoined = 0;
    let pendingJoining = 0;
    let notJoined = 0;

    for (const cand of allMatchingCandidatesForStats) {
      const st = String(cand.actualJoiningStatus || cand.status || '').toLowerCase();
      if (st.includes('joined') && !st.includes('not joined') && !st.includes('pending')) {
        totalJoined++;
      } else if (st.includes('not joined') || st.includes('dropped') || st.includes('exited') || st.includes('rejected')) {
        notJoined++;
      } else {
        pendingJoining++;
      }
    }

    const stats = {
      totalSelectedCandidates: allMatchingCandidatesForStats.length,
      totalJoined,
      pendingJoining,
      notJoined,
      totalRecruiters: activeTeamRecruitersCount,
      totalActiveSelections: Math.max(0, allMatchingCandidatesForStats.length - notJoined),
    };

    const targetSubAdminRecord =
      targetSubAdminId !== 'ALL' && subAdminMap.has(targetSubAdminId)
        ? subAdminMap.get(targetSubAdminId)
        : null;

    sendSuccess(res, {
      candidates,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
      stats,
      subAdminInfo: targetSubAdminRecord
        ? {
            id: targetSubAdminRecord.id,
            name: targetSubAdminRecord.fullName,
            email: targetSubAdminRecord.email,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 3. GET /api/v1/candidates/sub-admin/export
 * Exports Sub Admin-wise selected candidates to CSV with full column attribution.
 */
export const exportSubAdminSelectedCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;

    if (userRole !== 'SUPER_ADMIN' && userRole !== 'ADMIN' && userRole !== 'SUB_ADMIN') {
      sendError(res, 'Forbidden: Insufficient privileges to export Sub-Admin selections.', 403);
      return;
    }

    const {
      subAdminId,
      recruiterId,
      clientId,
      joiningStatus,
      dateFrom,
      dateTo,
      search,
    } = req.query;

    let targetSubAdminId: string = String(subAdminId || 'ALL');
    if (userRole === 'SUB_ADMIN') {
      targetSubAdminId = currentUserId || '';
    }

    const andFilters: any[] = [
      { isArchived: false },
      {
        OR: [
          { status: { in: SELECTED_STATUSES } },
          { actualJoiningStatus: { not: null } },
          { selectionDate: { not: null } },
        ],
      },
    ];

    if (targetSubAdminId !== 'ALL' && targetSubAdminId) {
      const { allMatchIds } = await getSubAdminTeamRecruiters(targetSubAdminId);
      andFilters.push({
        OR: [
          { teamLeaderId: targetSubAdminId },
          { ownerRecruiterId: { in: allMatchIds } },
          { sourcingRecruiterId: { in: allMatchIds } },
          { createdById: targetSubAdminId },
          { assignedRecruiterIds: { hasSome: allMatchIds } },
          {
            applications: {
              some: {
                OR: [
                  { recruiterId: { in: allMatchIds } },
                  { teamLeaderId: targetSubAdminId },
                ],
              },
            },
          },
        ],
      });
    }

    if (recruiterId && recruiterId !== 'ALL') {
      const rId = String(recruiterId).trim();
      andFilters.push({
        OR: [
          { ownerRecruiterId: rId },
          { sourcingRecruiterId: rId },
          { assignedRecruiterIds: { has: rId } },
          { applications: { some: { recruiterId: rId } } },
        ],
      });
    }

    if (clientId && clientId !== 'ALL') {
      const cStr = String(clientId).trim();
      andFilters.push({
        OR: [
          { clientId: cStr },
          { clientName: { contains: cStr, mode: 'insensitive' } },
        ],
      });
    }

    if (joiningStatus && joiningStatus !== 'ALL') {
      andFilters.push({
        OR: [
          { actualJoiningStatus: String(joiningStatus) },
          { status: String(joiningStatus) },
        ],
      });
    }

    const fromDate = parseDate(dateFrom);
    const toDate = parseDate(dateTo);
    if (toDate) toDate.setHours(23, 59, 59, 999);
    const selectionDateFilter = buildDateFilter(fromDate, toDate);
    if (selectionDateFilter) {
      andFilters.push({
        OR: [
          { selectionDate: selectionDateFilter },
          { dateOfJoin: selectionDateFilter },
        ],
      });
    }

    if (search) {
      const q = String(search).trim();
      const phoneDigits = q.replace(/\D/g, '');
      const searchOr: any[] = [
        { candidateCode: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { clientName: { contains: q, mode: 'insensitive' } },
      ];
      if (phoneDigits.length >= 4) {
        searchOr.push({ phone: { contains: phoneDigits } });
      }
      andFilters.push({ OR: searchOr });
    }

    const candidates = await prisma.candidate.findMany({
      where: { AND: andFilters },
      orderBy: [{ selectionDate: 'desc' }, { id: 'desc' }],
      take: 2000,
      include: {
        client: { select: { companyName: true } },
        ownerRecruiter: {
          select: {
            fullName: true,
            recruiterId: true,
            teamLeader: { select: { fullName: true, role: true } },
          },
        },
        sourcingRecruiter: {
          select: {
            fullName: true,
            recruiterId: true,
            teamLeader: { select: { fullName: true, role: true } },
          },
        },
        teamLeader: { select: { fullName: true, role: true } },
        applications: {
          take: 1,
          orderBy: { appliedAt: 'desc' },
          include: {
            job: { select: { title: true, jobCode: true } },
            recruiter: { select: { fullName: true, recruiterId: true } },
          },
        },
      },
    });

    const headers = [
      'Candidate Code',
      'Candidate Name',
      'Contact Number',
      'Email',
      'Client Name',
      'Job / Process',
      'Sub Admin Name',
      'Assigned Recruiter',
      'Selection Date',
      'Date of Joining (DOJ)',
      'Joining Status',
      'Total Working Days',
      'Last Updated',
    ];

    const escapeCsv = (val: any): string => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = candidates.map((c) => {
      const subAdminName =
        c.teamLeader?.role === 'SUB_ADMIN'
          ? c.teamLeader.fullName
          : c.ownerRecruiter?.teamLeader?.role === 'SUB_ADMIN'
            ? c.ownerRecruiter.teamLeader.fullName
            : c.sourcingRecruiter?.teamLeader?.role === 'SUB_ADMIN'
              ? c.sourcingRecruiter.teamLeader.fullName
              : 'Direct Admin / Unassigned';

      const rec = c.ownerRecruiter || c.sourcingRecruiter || c.applications?.[0]?.recruiter;
      const recName = rec ? `${rec.fullName} (${rec.recruiterId || 'REC'})` : 'Platform Recruiter';
      const client = c.clientName || c.client?.companyName || '—';
      const job = c.applications?.[0]?.job?.title || c.applications?.[0]?.job?.jobCode || 'Direct Sourcing';
      const selDate = c.selectionDate ? c.selectionDate.toISOString().split('T')[0] : '—';
      const doj = c.dateOfJoin ? c.dateOfJoin.toISOString().split('T')[0] : '—';
      const status = c.actualJoiningStatus || c.status || 'Selected';
      const updated = c.updatedAt.toISOString().split('T')[0];

      return [
        escapeCsv(c.candidateCode),
        escapeCsv(c.fullName),
        escapeCsv(c.phone),
        escapeCsv(c.email),
        escapeCsv(client),
        escapeCsv(job),
        escapeCsv(subAdminName),
        escapeCsv(recName),
        escapeCsv(selDate),
        escapeCsv(doj),
        escapeCsv(status),
        escapeCsv(c.totalWorkingDays || 0),
        escapeCsv(updated),
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const timestamp = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Sub_Admin_Selected_Candidates_${timestamp}.csv"`);
    res.send(csvContent);
  } catch (err) {
    next(err);
  }
};
