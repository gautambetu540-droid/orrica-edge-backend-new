import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';
import { dispatchEmail } from '../services/email.service';

export const getAdminPortalData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const [
      clients, candidates, jobs, recruiters, interviews, assessments, attempts, payouts, replacements, invoices,
      blogPosts, inquiries, notifications, emailTemplates, auditLogs
    ] = await Promise.all([
      prisma.client.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.candidate.findMany({
        where: { isArchived: false },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        include: {
          applications: {
            orderBy: { appliedAt: 'desc' },
            select: {
              id: true,
              jobId: true,
              stage: true,
              appliedAt: true,
              updatedAt: true,
              job: {
                select: {
                  id: true,
                  title: true,
                  jobCode: true,
                  department: true,
                },
              },
              recruiter: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          },
          _count: {
            select: {
              applications: true,
              assessmentAttempts: true,
            },
          },
        },
      }),
      prisma.job.findMany({ include: { client: true, createdBy: { select: { id: true, fullName: true, email: true, role: true } } }, orderBy: { createdAt: 'desc' }, take: 1000 }),
      prisma.user.findMany({
        where: { role: { in: ['RECRUITER', 'FREELANCE_RECRUITER', 'TEAM_LEADER', 'ADMIN', 'SUPER_ADMIN', 'SUB_ADMIN'] } },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          phone: true,
          isActive: true,
          createdAt: true,
          recruiterId: true,
          recruiterType: true,
          teamLeaderId: true,
          teamLeader: { select: { id: true, fullName: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),

      prisma.interview.findMany({ orderBy: { scheduledAt: 'desc' }, take: 500 }),
      prisma.assessment.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.assessmentAttempt.findMany({ orderBy: { submittedAt: 'desc' }, take: 500 }),
      prisma.payout.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
      prisma.replacementCase.findMany({ orderBy: { requestedAt: 'desc' }, take: 500 }),
      prisma.invoice.findMany({ orderBy: { billingDate: 'desc' }, take: 500 }),
      prisma.blogPost.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.inquiry.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
      prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.emailTemplate.findMany({ orderBy: { updatedAt: 'desc' } }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
            },
          },
        },
      }),
    ]);

    const questions = assessments.flatMap((assessment: any) => {
      const items = Array.isArray(assessment.questions) ? assessment.questions : [];
      return items.map((q: any, index: number) => ({
        id: String(q.id || `${assessment.id}-${index + 1}`),
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options : [],
        correctAnswer: q.correctOption ?? q.correctAnswer ?? null,
        explanation: q.explanation ?? '',
        difficulty: q.level || assessment.category || 'General',
        skill: q.section || assessment.category || 'General',
        language: 'English',
        assessmentId: assessment.id,
        assessmentTitle: assessment.title,
      }));
    });

    const mappedAuditLogs = auditLogs.map((log: any) => ({
      id: log.id,
      userId: log.userId,
      actorName: log.user?.fullName || log.user?.email || 'System User',
      actorRole: log.user?.role || 'ADMIN',
      userName: log.user?.fullName || log.user?.email || 'System User',
      role: log.user?.role || 'ADMIN',
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      entityType: log.module,
      entityName: log.entity,
      previousValue: log.oldValue ? (typeof log.oldValue === 'string' ? log.oldValue : JSON.stringify(log.oldValue)) : '',
      newValue: log.newValue ? (typeof log.newValue === 'string' ? log.newValue : JSON.stringify(log.newValue)) : '',
      metadata: log.newValue || log.oldValue || null,
      timestamp: log.createdAt,
      createdAt: log.createdAt,
      ipAddress: log.ipAddress || '127.0.0.1',
    }));

    sendSuccess(res, {
      clients,
      candidates,
      jobs,
      recruiters,
      interviews,
      assessments,
      questions,
      attempts,
      payouts,
      replacements,
      invoices,
      blogPosts,
      inquiries,
      notifications,
      emailTemplates,
      auditLogs: mappedAuditLogs,
    });
  } catch (err) {
    next(err);
  }
};

export const getAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10) || 25));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const performedBy = typeof req.query.performedBy === 'string' ? req.query.performedBy.trim() : '';
    const assignedTo = typeof req.query.assignedTo === 'string' ? req.query.assignedTo.trim() : '';
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate.trim() : '';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate.trim() : '';
    const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy.trim() : 'newest';
    const moduleParam = typeof req.query.module === 'string' ? req.query.module.trim() : '';
    const venueParam = typeof req.query.venue === 'string' ? req.query.venue.trim() : '';
    const statusParam = typeof req.query.status === 'string' ? req.query.status.trim() : '';

    const where: any = {};

    // 1. Date Range
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        const start = new Date(startDate.includes('T') ? startDate : `${startDate}T00:00:00.000Z`);
        if (!isNaN(start.getTime())) where.createdAt.gte = start;
      }
      if (endDate) {
        const end = new Date(endDate.includes('T') ? endDate : `${endDate}T23:59:59.999Z`);
        if (!isNaN(end.getTime())) where.createdAt.lte = end;
      }
    }


    if (moduleParam && moduleParam !== 'ALL') {
      where.module = moduleParam;
    }
    // 2. Action Filter
    if (action && action !== 'ALL') {
      const actionGroups: Record<string, string[]> = {
        CANDIDATE_ASSIGNED: ['ASSIGN_CANDIDATE_RECRUITER', 'OWNER_ASSIGNED'],
        CANDIDATE_REASSIGNED: ['REASSIGN_CANDIDATE_RECRUITER', 'TRANSFER_CANDIDATE_RECRUITER'],
        CANDIDATE_TRANSFERRED: ['TRANSFER_CANDIDATE_RECRUITER'],
        CANDIDATE_CREATED: ['CREATE_CANDIDATE', 'PUBLIC_FORM_SUBMITTED', 'Candidate Created'],
        CANDIDATE_UPDATED: ['UPDATE_CANDIDATE', 'UPDATE_APPLICATION_STAGE', 'Status Changed'],
        BULK_CANDIDATE_IMPORT: ['BULK_CANDIDATE_IMPORT'],
      };
      const matched = actionGroups[action] || [action];
      where.action = { in: matched };
    }

    // 3. Performed By Filter
    if (performedBy && performedBy !== 'ALL') {
      where.userId = performedBy;
    }

    // 4. Candidate Search Filter
    if (search) {
      const matchedCandidates = await prisma.candidate.findMany({
        where: {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { candidateCode: { contains: search, mode: 'insensitive' } },
            { id: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: 300,
      });
      const candIds = matchedCandidates.map((c) => c.id);

      where.OR = [
        { entityId: { in: candIds.length > 0 ? candIds : ['__NO_MATCH__'] } },
        { entity: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
      ];
    }

    // 5. Assigned To Filter
    if (assignedTo && assignedTo !== 'ALL') {
      // Find candidate IDs currently or previously associated with this recruiter
      const candidateMatches = await prisma.candidate.findMany({
        where: {
          OR: [
            { ownerRecruiterId: assignedTo },
            { sourcingRecruiterId: assignedTo },
          ],
        },
        select: { id: true },
        take: 300,
      });
      const candIds = candidateMatches.map((c) => c.id);

      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { entityId: { in: candIds } },
            { newValue: { path: ['ownerRecruiterId'], equals: assignedTo } },
            { oldValue: { path: ['ownerRecruiterId'], equals: assignedTo } },
          ],
        },
      ];
    }

    // 6. Chronological Sorting by event timestamp (with stable id tie-breaker)
    const orderBy: any = sortBy === 'oldest'
      ? [{ createdAt: 'asc' }, { id: 'asc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }];

    const total = await prisma.auditLog.count({ where });
    const skip = (page - 1) * limit;

    const rawLogs = await prisma.auditLog.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
          },
        },
      },
    });

    // 7. Batch resolve candidate & recruiter details
    const candidateIdSet = new Set<string>();
    const userIdSet = new Set<string>();

    rawLogs.forEach((log: any) => {
      const isCandidateModule = log.module === 'CANDIDATES' || (log.entity && String(log.entity).toLowerCase().includes('candidate'));
      if (isCandidateModule && log.entityId && log.entityId.length > 5 && !log.entityId.startsWith('batch-')) {
        candidateIdSet.add(log.entityId);
      }
      const nv = log.newValue as any;
      const ov = log.oldValue as any;
      if (nv?.candidateId) candidateIdSet.add(nv.candidateId);
      if (ov?.candidateId) candidateIdSet.add(ov.candidateId);

      if (nv?.ownerRecruiterId) userIdSet.add(nv.ownerRecruiterId);
      if (ov?.ownerRecruiterId) userIdSet.add(ov.ownerRecruiterId);
      if (nv?.assignedRecruiterId) userIdSet.add(nv.assignedRecruiterId);
      if (ov?.assignedRecruiterId) userIdSet.add(ov.assignedRecruiterId);
      if (nv?.recruiterId) userIdSet.add(nv.recruiterId);
      if (ov?.recruiterId) userIdSet.add(ov.recruiterId);
    });

    const [resolvedCandidates, resolvedUsers, allRecruiters, allUsers] = await Promise.all([
      candidateIdSet.size > 0
        ? prisma.candidate.findMany({
            where: { id: { in: Array.from(candidateIdSet) } },
            select: { id: true, candidateCode: true, fullName: true, name: true, ownerRecruiterId: true },
          })
        : Promise.resolve([]),
      userIdSet.size > 0
        ? prisma.user.findMany({
            where: { id: { in: Array.from(userIdSet) } },
            select: { id: true, fullName: true, email: true, role: true },
          })
        : Promise.resolve([]),
      prisma.user.findMany({
        where: { role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] }, isActive: true },
        select: { id: true, fullName: true, email: true },
        orderBy: { fullName: 'asc' },
      }),
      prisma.user.findMany({
        where: { isActive: true },
        select: { id: true, fullName: true, email: true, role: true },
        orderBy: { fullName: 'asc' },
      }),
    ]);

    const candidateMap = new Map<string, any>(resolvedCandidates.map((c: any) => [c.id, c]));
    const userMap = new Map<string, any>(resolvedUsers.map((u: any) => [u.id, u]));

    const formatActionLabel = (act: string): string => {
      switch (act) {
        case 'ASSIGN_CANDIDATE_RECRUITER':
        case 'OWNER_ASSIGNED':
          return 'Candidate Assigned';
        case 'REASSIGN_CANDIDATE_RECRUITER':
          return 'Candidate Reassigned';
        case 'TRANSFER_CANDIDATE_RECRUITER':
          return 'Candidate Transferred';
        case 'CREATE_CANDIDATE':
        case 'Candidate Created':
        case 'PUBLIC_FORM_SUBMITTED':
          return 'Candidate Created';
        case 'UPDATE_CANDIDATE':
        case 'Status Changed':
        case 'UPDATE_APPLICATION_STAGE':
          return 'Candidate Updated';
        case 'DELETE_CANDIDATE':
          return 'Candidate Deleted';
        case 'BULK_CANDIDATE_IMPORT':
          return 'Bulk Candidate Import';
        default:
          return act.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
      }
    };

    let auditLogs = rawLogs.map((log: any) => {
      const nv = (log.newValue && typeof log.newValue === 'object' ? log.newValue : {}) as any;
      const ov = (log.oldValue && typeof log.oldValue === 'object' ? log.oldValue : {}) as any;

      const candId = nv.candidateId || ov.candidateId || log.entityId;
      const candidate = candidateMap.get(candId);

      const isCandEvent = log.module === 'CANDIDATES' || (log.entity && String(log.entity).toLowerCase().includes('candidate'));

      const candidateName =
        nv.candidateName ||
        ov.candidateName ||
        candidate?.fullName ||
        candidate?.name ||
        (isCandEvent && candidate ? 'Candidate' : isCandEvent ? 'Not Available' : 'N/A');

      const candidateCode =
        nv.candidateCode ||
        ov.candidateCode ||
        candidate?.candidateCode ||
        (isCandEvent && candidate ? candidate.candidateCode : isCandEvent ? 'Not Available' : 'N/A');

      const candidateId = candidate?.id || (isCandEvent && candId && !candId.startsWith('batch-') ? candId : 'Not Available');

      const prevUser = userMap.get(ov.ownerRecruiterId || ov.assignedRecruiterId || ov.recruiterId);
      const nextUser = userMap.get(nv.ownerRecruiterId || nv.assignedRecruiterId || nv.recruiterId);

      const previouslyAssignedTo =
        ov.assignedRecruiterName ||
        (prevUser ? (prevUser.fullName || prevUser.email) : null) ||
        (ov.ownerRecruiterId ? 'Not Available' : isCandEvent ? 'Unassigned' : 'N/A');

      const assignedTo =
        nv.assignedRecruiterName ||
        (nextUser ? (nextUser.fullName || nextUser.email) : null) ||
        (nv.ownerRecruiterId ? 'Not Available' : isCandEvent ? 'Unassigned' : 'N/A');

      let details = nv.details || nv.description || ov.details || '';
      if (!details) {
        if (log.action === 'ASSIGN_CANDIDATE_RECRUITER' || log.action === 'OWNER_ASSIGNED') {
          details = `Candidate "${candidateName}" (${candidateCode}) assigned to recruiter ${assignedTo}.`;
        } else if (log.action === 'REASSIGN_CANDIDATE_RECRUITER') {
          details = `Candidate "${candidateName}" (${candidateCode}) reassigned from ${previouslyAssignedTo} to ${assignedTo}.`;
        } else if (log.action === 'TRANSFER_CANDIDATE_RECRUITER') {
          details = `Candidate "${candidateName}" (${candidateCode}) transferred from ${previouslyAssignedTo} to ${assignedTo}.`;
        } else if (log.action === 'CREATE_CANDIDATE' || log.action === 'PUBLIC_FORM_SUBMITTED') {
          details = `New candidate profile created for "${candidateName}" (${candidateCode}).`;
        } else if (log.action === 'UPDATE_CANDIDATE' || log.action === 'Status Changed') {
          details = `Candidate profile updated for "${candidateName}" (${candidateCode}).`;
        } else if (log.action === 'BULK_CANDIDATE_IMPORT') {
          details = `Bulk imported ${nv.importedCount ?? 0} candidates from file "${nv.fileName || 'Spreadsheet'}".`;
        } else {
          details = `Action ${formatActionLabel(log.action)} performed on ${log.entity || 'Record'}.`;
        }
      }

      return {
        id: log.id,
        userId: log.userId,
        actorName: log.user?.fullName || log.user?.email || 'System User',
        actorRole: log.user?.role || 'ADMIN',
        userName: log.user?.fullName || log.user?.email || 'System User',
        role: log.user?.role || 'ADMIN',
        action: log.action,
        actionLabel: formatActionLabel(log.action),
        entity: log.entity,
        entityId: log.entityId,
        entityType: log.module,
        entityName: log.entity,
        candidateName,
        candidateCode,
        candidateId,
        previouslyAssignedTo,
        assignedTo,
        details,
        previousValue: log.oldValue ? (typeof log.oldValue === 'string' ? log.oldValue : JSON.stringify(log.oldValue)) : '',
        newValue: log.newValue ? (typeof log.newValue === 'string' ? log.newValue : JSON.stringify(log.newValue)) : '',
        metadata: log.newValue || log.oldValue || null,
        timestamp: log.createdAt,
        createdAt: log.createdAt,
        ipAddress: log.ipAddress || '127.0.0.1',
      };
    });

    // In-memory Candidate Name A-Z / Z-A sort if requested
    if (sortBy === 'name_asc') {
      auditLogs.sort((a, b) => a.candidateName.localeCompare(b.candidateName) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } else if (sortBy === 'name_desc') {
      auditLogs.sort((a, b) => b.candidateName.localeCompare(a.candidateName) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    sendSuccess(res, {
      auditLogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      filters: {
        search,
        action,
        performedBy,
        assignedTo,
        startDate,
        endDate,
        sortBy,
      },
      recruiters: allRecruiters.map((r: any) => ({ id: r.id, name: r.fullName || r.email })),
      users: allUsers.map((u: any) => ({ id: u.id, name: u.fullName || u.email, role: u.role })),
    });
  } catch (err) {
    next(err);
  }
};

export const createEmployeeUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({
      fullName: z.string().trim().min(2).max(120),
      email: z.string().trim().email().toLowerCase(),
      phone: z.string().trim().max(30).optional(),
      role: z.enum(['ADMIN', 'SUPER_ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER']).default('RECRUITER'),
      department: z.string().trim().optional(),
      designation: z.string().trim().optional(),
      teamLeaderId: z.string().uuid().nullable().optional(),
      permissions: z.array(z.string()).optional(),
    });

    const data = schema.parse(req.body);
    if (req.user?.role === 'SUB_ADMIN' && (data.role === 'RECRUITER' || data.role === 'FREELANCE_RECRUITER')) {
      sendError(res, 'Forbidden: Sub-Admin accounts cannot create new recruiters.', 403, 'SUB_ADMIN_CANNOT_CREATE_RECRUITER');
      return;
    }
    if (req.user?.role === 'SUB_ADMIN' && (data.role === 'SUPER_ADMIN' || data.role === 'ADMIN')) {
      sendError(res, 'Forbidden: Sub-Admin accounts cannot assign Admin or Super Admin roles.', 403, 'PRIVILEGE_ESCALATION_BLOCKED');
      return;
    }
    const existing = await prisma.user.findUnique({
      where: { email: data.email },
      select: { id: true },
    });
    if (existing) {
      sendError(res, 'A user with this email address already exists.', 409);
      return;
    }

    const temporaryPassword = `Orrica@${crypto.randomBytes(4).toString('hex')}`;
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    let recruiterId: string | null = null;
    let recruiterType: 'INTERNAL' | 'FREELANCER' | null = null;
    let rawSetupToken: string | null = null;
    let tokenHash: string | null = null;
    let tokenExpiry: Date | null = null;

    if (data.role === 'RECRUITER' || data.role === 'FREELANCE_RECRUITER') {
      const recruiters = await prisma.user.findMany({
        where: { role: { in: ['RECRUITER', 'FREELANCE_RECRUITER'] }, recruiterId: { not: null } },
        select: { recruiterId: true },
      });
      let highest = 0;
      for (const rec of recruiters) {
        const match = rec.recruiterId?.match(/^REC-(\d+)$/);
        if (!match) continue;
        const number = Number(match[1]);
        if (Number.isFinite(number) && number > highest) highest = number;
      }
      recruiterId = `REC-${String(highest + 1).padStart(4, '0')}`;
      recruiterType = data.role === 'FREELANCE_RECRUITER' ? 'FREELANCER' : 'INTERNAL';

      rawSetupToken = crypto.randomBytes(32).toString('hex');
      tokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
      const expiryHours = config.recruiter.passwordSetupExpiryHours || 24;
      tokenExpiry = new Date(Date.now() + expiryHours * 60 * 60 * 1000);
    }

    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        fullName: data.fullName,
        role: data.role as any,
        phone: data.phone || undefined,
        recruiterId,
        recruiterType: recruiterType || undefined,
        teamLeaderId: data.teamLeaderId || null,
        mustSetPassword: true,
        resetPasswordToken: tokenHash,
        resetPasswordExpires: tokenExpiry,
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phone: true,
        recruiterId: true,
        recruiterType: true,
        teamLeaderId: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (data.role === 'RECRUITER' || data.role === 'FREELANCE_RECRUITER') {
      await prisma.recruiterPermission.create({
        data: {
          recruiterId: user.id,
          dashboard: true,
          candidates: true,
          jobs: true,
          applications: true,
          interviews: true,
          payouts: data.role === 'FREELANCE_RECRUITER',
          reports: false,
          settings: false,
        },
      });

      const setupUrl = `${config.recruiter.passwordSetupUrl}?token=${rawSetupToken}&email=${encodeURIComponent(user.email)}`;
      dispatchEmail('RECRUITER_WELCOME', user.email, {
        recruiter_id: user.recruiterId || '',
        recruiter_name: user.fullName,
        recruiter_email: user.email,
        temporary_password: temporaryPassword,
        setup_url: setupUrl,
        login_url: config.recruiter.loginUrl,
      });
    }

    await logAudit({
      req,
      action: 'CREATE_EMPLOYEE',
      module: 'USERS',
      entity: 'User',
      entityId: user.id,
      newValue: { fullName: user.fullName, email: user.email, role: user.role },
    });

    sendSuccess(res, { employee: user, temporaryPassword }, 'Employee account created successfully and credentials dispatched', 201);
  } catch (err) {
    next(err);
  }
};

export const getEmployeeUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const select = {
      id: true,
      email: true,
      fullName: true,
      role: true,
      phone: true,
      isActive: true,
      recruiterId: true,
      recruiterType: true,
      teamLeaderId: true,
      teamLeader: { select: { id: true, fullName: true, email: true } },
      createdAt: true,
    };

    let employees;
    try {
      employees = await prisma.user.findMany({
        where: {
          role: { in: ['ADMIN', 'SUPER_ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER'] },
        },
        select,
        orderBy: { createdAt: 'desc' },
      });
    } catch (queryErr: any) {
      if (queryErr?.message?.includes('FREELANCE_RECRUITER') || queryErr?.message?.includes('22P02')) {
        try {
          await prisma.$executeRawUnsafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FREELANCE_RECRUITER';`);
          await prisma.$executeRawUnsafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'TEAM_LEADER';`);
          await prisma.$executeRawUnsafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUB_ADMIN';`);
        } catch (_) {}
        employees = await prisma.user.findMany({
          where: {
            role: { in: ['ADMIN', 'SUPER_ADMIN', 'RECRUITER'] },
          },
          select,
          orderBy: { createdAt: 'desc' },
        });
      } else {
        throw queryErr;
      }
    }

    sendSuccess(res, { employees });
  } catch (err) {
    next(err);
  }
};

export const updateEmployeeUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      sendError(res, 'Employee ID is required', 400);
      return;
    }

    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, email: true, fullName: true },
    });

    if (!targetUser) {
      sendError(res, 'Employee not found', 404);
      return;
    }

    // Privilege escalation protection
    if (req.user?.role === 'SUB_ADMIN') {
      if (targetUser.role === 'SUPER_ADMIN' || targetUser.role === 'ADMIN') {
        sendError(res, 'Forbidden: Sub-Admin cannot modify Administrator accounts.', 403, 'PRIVILEGE_ESCALATION_BLOCKED');
        return;
      }
      if (req.body.role === 'SUPER_ADMIN' || req.body.role === 'ADMIN') {
        sendError(res, 'Forbidden: Sub-Admin cannot grant Administrator roles.', 403, 'PRIVILEGE_ESCALATION_BLOCKED');
        return;
      }
      if (req.body.role === 'RECRUITER' || req.body.role === 'FREELANCE_RECRUITER') {
        sendError(res, 'Forbidden: Sub-Admin accounts cannot assign recruiter roles.', 403, 'SUB_ADMIN_CANNOT_CREATE_RECRUITER');
        return;
      }
    }

    const schema = z.object({
      fullName: z.string().trim().min(2).max(120).optional(),
      email: z.string().trim().email().toLowerCase().optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      role: z.enum(['ADMIN', 'SUPER_ADMIN', 'SUB_ADMIN', 'TEAM_LEADER', 'RECRUITER', 'FREELANCE_RECRUITER']).optional(),
      department: z.string().trim().optional(),
      designation: z.string().trim().optional(),
      isActive: z.boolean().optional(),
    });

    const parsed = schema.parse(req.body);

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(parsed.fullName ? { fullName: parsed.fullName } : {}),
        ...(parsed.email ? { email: parsed.email } : {}),
        ...(parsed.phone !== undefined ? { phone: parsed.phone } : {}),
        ...(parsed.role ? { role: parsed.role as any } : {}),
        ...(parsed.isActive !== undefined ? { isActive: parsed.isActive } : {}),
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phone: true,
        isActive: true,
      },
    });

    await logAudit({
      req,
      action: 'UPDATE_EMPLOYEE',
      module: 'USERS',
      entity: 'User',
      entityId: id,
      oldValue: targetUser,
      newValue: updated,
    });

    sendSuccess(res, { employee: updated }, 'Employee updated successfully');
  } catch (err) {
    next(err);
  }
};

export const deleteEmployeeUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      sendError(res, 'Employee ID is required', 400);
      return;
    }

    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, email: true, fullName: true },
    });

    if (!targetUser) {
      sendError(res, 'Employee not found', 404);
      return;
    }

    if (req.user?.role === 'SUB_ADMIN' && (targetUser.role === 'SUPER_ADMIN' || targetUser.role === 'ADMIN')) {
      sendError(res, 'Forbidden: Sub-Admin cannot delete Administrator accounts.', 403, 'PRIVILEGE_ESCALATION_BLOCKED');
      return;
    }

    // Unassign candidates and delete user
    await prisma.$transaction(async (tx) => {
      await tx.candidate.updateMany({ where: { createdById: id }, data: { createdById: null } });
      await tx.candidate.updateMany({ where: { ownerRecruiterId: id }, data: { ownerRecruiterId: null } });
      await tx.candidate.updateMany({ where: { sourcingRecruiterId: id }, data: { sourcingRecruiterId: null } });
      await tx.candidate.updateMany({ where: { archivedById: id }, data: { archivedById: null } });
      await tx.candidate.updateMany({ where: { teamLeaderId: id }, data: { teamLeaderId: null } });
      await tx.candidate.updateMany({ where: { userId: id }, data: { userId: null } });
      await tx.candidateActivity.updateMany({ where: { userId: id }, data: { userId: null } });
      await tx.candidateTimeline.updateMany({ where: { userId: id }, data: { userId: null } });
      await tx.refreshToken.deleteMany({ where: { userId: id } });
      await tx.notification.deleteMany({ where: { userId: id } });
      await tx.recruiterPermission.deleteMany({ where: { recruiterId: id } });
      await tx.user.delete({ where: { id } });
    });

    await logAudit({
      req,
      action: 'DELETE_EMPLOYEE',
      module: 'USERS',
      entity: 'User',
      entityId: id,
      oldValue: targetUser,
    });

    sendSuccess(res, { deleted: true, id }, 'Employee deleted successfully');
  } catch (err) {
    next(err);
  }
};
