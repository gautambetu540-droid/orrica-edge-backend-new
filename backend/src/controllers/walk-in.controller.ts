import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { sendDynamicEmail } from '../services/email.service';
import { logCandidateTimeline } from '../services/timeline.service';
import { formatCandidateGreetingName, formatCandidateGreeting } from '../utils/nameFormatter';
import { formatWalkInDate, formatReadableInterviewDate } from '../utils/dateFormatter';
import { logAudit } from '../services/audit.service';

export interface DecodedTokenPayload {
  candidateId: string;
  jobId?: string;
  applicationId?: string;
  sessionId?: string;
}

/**
 * Parses walk-in confirmation token supporting both structured JSON and legacy base64/UUID formats.
 */
export function parseWalkInToken(rawToken: string): DecodedTokenPayload {
  let candidateId = rawToken;
  let jobId: string | undefined;
  let applicationId: string | undefined;
  let sessionId: string | undefined;

  if (rawToken.startsWith('wic_')) {
    const part = rawToken.slice(4);
    try {
      const decoded = Buffer.from(part, 'base64url').toString('utf8');
      if (decoded.startsWith('{') && decoded.endsWith('}')) {
        const parsed = JSON.parse(decoded);
        if (parsed.c) candidateId = parsed.c;
        if (parsed.j) jobId = parsed.j;
        if (parsed.a) applicationId = parsed.a;
        if (parsed.s) sessionId = parsed.s;
      } else if (/^[0-9a-fA-F-]{36}$/.test(decoded) || /^[A-Za-z0-9_-]+$/.test(decoded)) {
        candidateId = decoded;
      } else {
        candidateId = part.split('_')[0] || part;
      }
    } catch {
      candidateId = part.split('_')[0] || part;
    }
  } else if (rawToken.startsWith('tok_')) {
    candidateId = rawToken.slice(4);
  }

  return { candidateId, jobId, applicationId, sessionId };
}

/**
 * Public candidate details lookup by confirmation token
 * GET /api/v1/walk-in/confirm/:token
 */
export const getWalkInConfirmation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawToken = req.params.token;
    if (!rawToken) {
      sendError(res, 'Token is required', 400);
      return;
    }

    const { candidateId, jobId: tokenJobId, applicationId: tokenAppId, sessionId: tokenSessionId } = parseWalkInToken(rawToken);

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: candidateId },
          { candidateCode: candidateId },
          { id: rawToken },
          { candidateCode: rawToken },
        ],
      },
      include: {
        applications: {
          include: {
            job: {
              include: { client: true },
            },
          },
          orderBy: { appliedDate: 'desc' },
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Walk-in invitation not found or link has expired', 404);
      return;
    }

    // Match exact application based on token signature or candidate activity history
    let application: any = null;
    if (tokenAppId && candidate.applications.length > 0) {
      application = candidate.applications.find((app) => app.id === tokenAppId);
    }
    if (!application && tokenJobId && candidate.applications.length > 0) {
      application = candidate.applications.find(
        (app) => app.jobId === tokenJobId || app.job?.id === tokenJobId || app.job?.jobCode === tokenJobId
      );
    }
    if (!application && (candidate as any).targetJobId && candidate.applications.length > 0) {
      application = candidate.applications.find(
        (app) => app.jobId === (candidate as any).targetJobId || app.job?.id === (candidate as any).targetJobId
      );
    }
    if (!application && candidate.applications.length > 1) {
      const recentActivity = await prisma.candidateActivity.findFirst({
        where: {
          candidateId: candidate.id,
          action: { in: ['WALK_IN_INVITATION_SENT', 'WALK_IN_EMAIL_RESENT', 'WALK_IN_SCHEDULED'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (recentActivity?.metadata) {
        const meta = recentActivity.metadata as any;
        if (meta.jobId) {
          application = candidate.applications.find(
            (app) => app.jobId === meta.jobId || app.job?.id === meta.jobId
          );
        }
      }
    }
    if (!application) {
      application = candidate.applications?.[0] || null;
    }

    const job = application?.job;
    const greetingName = formatCandidateGreetingName(candidate);

    // 1. Fetch latest candidate activity to get the ACTUAL invitation details dispatched
    const recentActivity = await prisma.candidateActivity.findFirst({
      where: {
        candidateId: candidate.id,
        action: { in: ['WALK_IN_INVITATION_SENT', 'WALK_IN_EMAIL_RESENT', 'WALK_IN_SCHEDULED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    const activityMeta = (recentActivity?.metadata as any) || {};

    // 2. Resolve target session / location ID
    const targetSessionId = tokenSessionId || activityMeta.sessionId || (candidate as any).walkInSessionId;
    let locationVenue: WalkInLocation | null = null;
    if (targetSessionId) {
      locationVenue = await findWalkInLocationById(targetSessionId);
    }

    // 3. Match job hiring process session ONLY if it genuinely matches targetSessionId
    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};
    const isSavedSessionMatch = Boolean(
      (savedSession.id && (savedSession.id === targetSessionId || savedSession.id === tokenSessionId)) ||
      (!locationVenue && !activityMeta.venueName)
    );

    // 4. Resolve venue details strictly from the selected session / invitation
    const venueNameStr = (
      locationVenue?.venueName ||
      locationVenue?.locationName ||
      activityMeta.venueName ||
      (isSavedSessionMatch ? savedSession.venueName : '') ||
      ''
    ).trim();

    const venueAddressStr = (
      locationVenue?.venueAddress ||
      activityMeta.venueAddress ||
      (isSavedSessionMatch ? savedSession.venueAddress : '') ||
      ''
    ).trim();

    let googleMapsLinkStr = (
      locationVenue?.googleMapsLink ||
      activityMeta.googleMapsLink ||
      (isSavedSessionMatch ? savedSession.googleMapsLink : '') ||
      ''
    ).trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }
    if (googleMapsLinkStr && !googleMapsLinkStr.startsWith('http://') && !googleMapsLinkStr.startsWith('https://')) {
      googleMapsLinkStr = '';
    }

    const reportingTimeStr = (
      activityMeta.reportingTime ||
      candidate.walkInTime ||
      locationVenue?.defaultReportingTime ||
      (isSavedSessionMatch ? savedSession.reportingTime : '') ||
      '09:30 AM'
    ).trim();

    const rawDate = candidate.walkInDate || activityMeta.walkInDate || (isSavedSessionMatch ? (savedSession.date || savedSession.interviewDate) : null);
    const dateInfo = formatWalkInDate(rawDate);
    const walkInDateStr = dateInfo.dateStr;

    const instructionsStr = (
      activityMeta.instructions ||
      locationVenue?.defaultInstructions ||
      (isSavedSessionMatch ? savedSession.instructions : '') ||
      ''
    ).trim();

    const venueConfigured = Boolean(venueNameStr && venueAddressStr);

    const sanitizedCandidate = {
      id: candidate.id,
      candidateCode: candidate.candidateCode,
      name: candidate.fullName || candidate.name,
      fullName: candidate.fullName,
      greetingName,
      email: candidate.email,
      walkInStatus: candidate.walkInStatus,
      walkInConfirmationStatus:
        candidate.walkInStatus === 'RESCHEDULE_REQUESTED'
          ? 'RESCHEDULE_REQUESTED'
          : candidate.walkInStatus === 'CONFIRMED'
          ? 'CONFIRMED'
          : candidate.walkInStatus === 'CANCELLED'
          ? 'NOT_INTERESTED'
          : 'CONFIRMATION_PENDING',
      walkInResponse: candidate.walkInResponse,
      walkInDate: walkInDateStr,
      walkInTime: reportingTimeStr,
      reportingTime: reportingTimeStr,
      venueName: venueNameStr,
      venueAddress: venueAddressStr,
      googleMapsLink: googleMapsLinkStr,
      candidateInstructions: instructionsStr,
      instructions: instructionsStr,
      venueConfigured,
      appliedPosition: job?.title || 'Walk-in Interview Candidate',
      targetJobTitle: job?.title || 'Walk-in Interview Candidate',
    };

    const sessionDetails = {
      id: savedSession.id || tokenSessionId || ('session-' + (job?.id || candidate.id)),
      date: walkInDateStr,
      interviewDate: walkInDateStr,
      weekday: dateInfo.weekday,
      longWeekday: dateInfo.longWeekday,
      displayDate: dateInfo.displayDate,
      reportingTime: reportingTimeStr,
      interviewStartTime: savedSession.interviewStartTime || '',
      interviewEndTime: savedSession.interviewEndTime || '',
      venueName: venueNameStr,
      venueAddress: venueAddressStr,
      googleMapsLink: googleMapsLinkStr,
      instructions: instructionsStr,
      candidateInstructions: instructionsStr,
      venueConfigured,
      clientName: job?.client?.companyName || 'Orrica Edge Partner',
    };

    const payload = {
      candidate: sanitizedCandidate,
      jobTitle: job?.title || 'Walk-in Interview Candidate',
      clientName: job?.client?.companyName || 'Orrica Edge Partner',
      session: sessionDetails,
      venueConfigured,
    };

    res.status(200).json({
      success: true,
      message: 'Success',
      ...payload,
      data: payload,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Public candidate self-confirmation action submission
 * POST /api/v1/walk-in/confirm/:token
 */
export const submitWalkInConfirmation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawToken = req.params.token;
    const { action, preferredDate, reason, comment } = req.body;

    if (!action || !['CONFIRM', 'RESCHEDULE', 'NOT_INTERESTED'].includes(action)) {
      sendError(res, 'Valid action (CONFIRM, RESCHEDULE, NOT_INTERESTED) is required', 400);
      return;
    }

    const { candidateId, jobId: tokenJobId, applicationId: tokenAppId, sessionId: tokenSessionId } = parseWalkInToken(rawToken);

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: candidateId },
          { candidateCode: candidateId },
          { id: rawToken },
          { candidateCode: rawToken },
        ],
      },
      include: {
        applications: {
          include: {
            job: {
              include: { client: true },
            },
          },
          orderBy: { appliedDate: 'desc' },
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Walk-in invitation not found', 404);
      return;
    }

    // Match exact application based on token signature or candidate activity history
    let application: any = null;
    if (tokenAppId && candidate.applications.length > 0) {
      application = candidate.applications.find((app) => app.id === tokenAppId);
    }
    if (!application && tokenJobId && candidate.applications.length > 0) {
      application = candidate.applications.find(
        (app) => app.jobId === tokenJobId || app.job?.id === tokenJobId || app.job?.jobCode === tokenJobId
      );
    }
    if (!application && (candidate as any).targetJobId && candidate.applications.length > 0) {
      application = candidate.applications.find(
        (app) => app.jobId === (candidate as any).targetJobId || app.job?.id === (candidate as any).targetJobId
      );
    }
    if (!application && candidate.applications.length > 1) {
      const recentActivity = await prisma.candidateActivity.findFirst({
        where: {
          candidateId: candidate.id,
          action: { in: ['WALK_IN_INVITATION_SENT', 'WALK_IN_EMAIL_RESENT', 'WALK_IN_SCHEDULED'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (recentActivity?.metadata) {
        const meta = recentActivity.metadata as any;
        if (meta.jobId) {
          application = candidate.applications.find(
            (app) => app.jobId === meta.jobId || app.job?.id === meta.jobId
          );
        }
      }
    }
    if (!application) {
      application = candidate.applications?.[0] || null;
    }

    const job = application?.job;
    const jobTitle = job?.title || 'Walk-in Interview';
    const rawClientName = (job?.client?.companyName || '').trim();
    const clientName = (rawClientName && !['orrica edge', 'orrica edge partner', 'orrica edge llp', 'orrica'].includes(rawClientName.toLowerCase())) ? rawClientName : '';
    const greetingName = formatCandidateGreetingName(candidate);

    // Resolve the exact walk-in invitation venue from recent candidate activity or location
    const recentActivity = await prisma.candidateActivity.findFirst({
      where: {
        candidateId: candidate.id,
        action: { in: ['WALK_IN_INVITATION_SENT', 'WALK_IN_EMAIL_RESENT', 'WALK_IN_SCHEDULED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    const activityMeta = (recentActivity?.metadata as any) || {};

    const targetSessionId = tokenSessionId || activityMeta.sessionId || (candidate as any).walkInSessionId;
    let locationVenue: WalkInLocation | null = null;
    if (targetSessionId) {
      locationVenue = await findWalkInLocationById(targetSessionId);
    }

    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};
    const isSavedSessionMatch = Boolean(
      (savedSession.id && (savedSession.id === targetSessionId || savedSession.id === tokenSessionId)) ||
      (!locationVenue && !activityMeta.venueName)
    );

    const venueNameStr = (
      locationVenue?.venueName ||
      locationVenue?.locationName ||
      activityMeta.venueName ||
      (isSavedSessionMatch ? savedSession.venueName : '') ||
      ''
    ).trim();

    const venueAddressStr = (
      locationVenue?.venueAddress ||
      activityMeta.venueAddress ||
      (isSavedSessionMatch ? savedSession.venueAddress : '') ||
      ''
    ).trim();

    let googleMapsLinkStr = (
      locationVenue?.googleMapsLink ||
      activityMeta.googleMapsLink ||
      (isSavedSessionMatch ? savedSession.googleMapsLink : '') ||
      ''
    ).trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }
    if (googleMapsLinkStr && !googleMapsLinkStr.startsWith('http://') && !googleMapsLinkStr.startsWith('https://')) {
      googleMapsLinkStr = '';
    }

    // Email Deduplication & Idempotent check
    const isAlreadyConfirmed = candidate.walkInStatus === 'CONFIRMED' || candidate.walkInResponse === 'COMING_TODAY';
    if (action === 'CONFIRM' && isAlreadyConfirmed) {
      const resultData = {
        candidate,
        alreadyConfirmed: true,
        message: 'Your attendance is already confirmed. We look forward to welcoming you at the interview.',
      };
      res.status(200).json({
        success: true,
        ...resultData,
        data: resultData,
      });
      return;
    }

    let newWalkInStatus = candidate.walkInStatus || 'EXPECTED';
    let newWalkInResponse = candidate.walkInResponse || 'NO_RESPONSE';
    let timelineAction = 'Walk-in Response';
    let templateKey = 'WALK_IN_CONFIRMED_ACK';

    if (action === 'CONFIRM') {
      newWalkInStatus = 'CONFIRMED';
      newWalkInResponse = 'COMING_TODAY';
      timelineAction = 'Candidate Confirmed Attendance';
      templateKey = 'WALK_IN_CONFIRMED_ACK';
    } else if (action === 'RESCHEDULE') {
      newWalkInStatus = 'RESCHEDULE_REQUESTED';
      newWalkInResponse = 'SPECIFIC_DATE';
      timelineAction = 'Candidate Requested Reschedule';
      templateKey = 'WALK_IN_RESCHEDULE_ACK';
    } else if (action === 'NOT_INTERESTED') {
      newWalkInStatus = 'CANCELLED';
      newWalkInResponse = 'NOT_INTERESTED';
      timelineAction = 'Candidate Not Interested';
      templateKey = 'WALK_IN_NOT_INTERESTED_ACK';
    }

    // Persist update (idempotent for repeated submissions)
    const updated = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        walkInStatus: newWalkInStatus,
        walkInResponse: newWalkInResponse,
        feedback: comment || reason || candidate.feedback,
        nextActionRemarks:
          action === 'RESCHEDULE' && preferredDate
            ? ('Candidate requested reschedule to ' + preferredDate + '. ' + (comment || '')).trim()
            : undefined,
      },
    });

    // Record CandidateActivity
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        action: 'WALK_IN_' + action,
        notes: ('Candidate submitted ' + action + '. ' + (comment || reason || '')).trim(),
        metadata: {
          action,
          preferredDate,
          reason,
          comment,
          jobId: job?.id,
          applicationId: application?.id,
          sessionId: savedSession?.id || tokenSessionId,
          submittedAt: new Date().toISOString(),
        },
      },
    });

    // Audit Timeline
    await logCandidateTimeline({
      candidateId: candidate.id,
      userId: null,
      userName: candidate.fullName,
      userRole: 'CANDIDATE',
      action: timelineAction,
      newStatus: updated.status,
      remarks: ('Candidate submitted self-confirmation: ' + action + '. ' + (comment || reason || '')).trim(),
    });

    // Send acknowledgement email if candidate has a valid email address
    if (candidate.email && candidate.email.includes('@')) {
      const dateInfo = formatWalkInDate(candidate.walkInDate || savedSession.date || savedSession.interviewDate);
      const walkInDateStr = dateInfo.dateStr;

      try {
        await sendDynamicEmail({
          templateKey,
          recipient: candidate.email,
          variables: {
            candidate_name: greetingName,
            candidate_greeting: formatCandidateGreeting(candidate),
            candidate_email: candidate.email,
            job_title: jobTitle,
            client_name: clientName,
            company_name: clientName,
            walk_in_date: walkInDateStr,
            walkin_date: walkInDateStr,
            reporting_time: candidate.walkInTime || savedSession.reportingTime || '09:30 AM',
            venue_name: venueNameStr,
            venue_address: venueAddressStr,
            google_maps_link: googleMapsLinkStr,
            preferred_date: preferredDate || '',
            comments: comment || reason || '',
          },
        });
      } catch (mailErr: any) {
        console.warn('[SELF-CONFIRMATION ACK EMAIL WARN]:', mailErr.message);
      }
    }

    const resultData = {
      candidate: updated,
      message: 'Response recorded successfully for ' + action + '.',
    };

    res.status(200).json({
      success: true,
      ...resultData,
      data: resultData,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin: Get active walk-in sessions
 * GET /api/v1/walk-in/sessions
 */
export const getWalkInSessions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit } = req.query;
    const pageNum = page ? Math.max(1, parseInt(page as string, 10) || 1) : undefined;
    const limitNum = limit ? Math.min(200, Math.max(1, parseInt(limit as string, 10) || 50)) : undefined;

    const jobs = await prisma.job.findMany({
      where: {
        status: { in: ['PUBLISHED', 'DRAFT', 'PAUSED'] },
      },
      include: { client: true },
      orderBy: { createdAt: 'desc' },
      ...(pageNum && limitNum ? { skip: (pageNum - 1) * limitNum, take: limitNum } : {}),
    });

    const sessions = jobs
      .map((job) => {
        const hp = (job.hiringProcess as any) || {};
        if (hp.walkInSession && hp.walkInSession.venueName && hp.walkInSession.venueAddress) {
          const s = {
            ...hp.walkInSession,
            jobId: job.id,
            jobCode: job.jobCode,
            jobTitle: job.title,
            clientName: job.client?.companyName,
          };
          // Filter out explicitly flagged mock test sessions
          const id = String(s.id || '').toLowerCase();
          if (id === 'dummy' || id === 'test-session') {
            return null;
          }
          return s;
        }
        return null;
      })
      .filter(Boolean);

    sendSuccess(res, { sessions });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin: Save or update walk-in session details
 * PUT /api/v1/walk-in/sessions/:id
 */
export const updateWalkInSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionIdOrJobId = req.params.id;
    const sessionData = req.body;

    if (!sessionData || !sessionData.venueName?.trim() || !sessionData.venueAddress?.trim()) {
      sendError(res, 'Venue name and address are required to save session details.', 400);
      return;
    }

    // Locate job by ID or jobId in sessionData
    const targetJobId = sessionData.jobId || sessionIdOrJobId;
    let job = await prisma.job.findFirst({
      where: {
        OR: [
          { id: targetJobId },
          { jobCode: targetJobId },
        ],
      },
    });

    if (!job) {
      const allJobs = await prisma.job.findMany({
        select: { id: true, jobCode: true, title: true, hiringProcess: true },
      });
      job = (allJobs.find((j) => {
        const hp = (j.hiringProcess as any) || {};
        return hp.walkInSession?.id === sessionIdOrJobId || hp.walkInSession?.id === sessionData.id;
      }) as any) || null;
    }

    if (!job) {
      sendError(res, 'Target job or walk-in session record not found in database.', 404);
      return;
    }

    const existingHp = (job.hiringProcess as any) || {};
    const rawDate = sessionData.date || sessionData.interviewDate;
    const dateInfo = formatWalkInDate(rawDate);

    let mapsUrl = (sessionData.googleMapsLink || '').trim();
    if (!mapsUrl && sessionData.venueAddress?.trim()) {
      mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(sessionData.venueAddress.trim());
    }
    if (mapsUrl && !mapsUrl.startsWith('http://') && !mapsUrl.startsWith('https://')) {
      mapsUrl = '';
    }

    const updatedSession = {
      id: sessionData.id || sessionIdOrJobId,
      jobId: job.id,
      date: dateInfo.dateStr,
      interviewDate: dateInfo.dateStr,
      reportingTime: sessionData.reportingTime || '09:30 AM',
      interviewStartTime: sessionData.interviewStartTime || '10:00 AM',
      interviewEndTime: sessionData.interviewEndTime || '02:00 PM',
      venueName: sessionData.venueName.trim(),
      venueAddress: sessionData.venueAddress.trim(),
      googleMapsLink: mapsUrl,
      instructions: sessionData.instructions || '',
      requiredDocuments: sessionData.requiredDocuments || [],
      status: sessionData.status || 'SCHEDULED',
      updatedAt: new Date().toISOString(),
    };

    const updatedHp = {
      ...existingHp,
      walkInSession: updatedSession,
    };

    await prisma.job.update({
      where: { id: job.id },
      data: {
        hiringProcess: updatedHp,
      },
    });

    try {
      await logAudit({
        req,
        action: 'UPDATE_WALK_IN_SESSION',
        module: 'WALK_IN_OPERATIONS',
        entity: 'Job',
        entityId: job.id,
        oldValue: existingHp.walkInSession || null,
        newValue: updatedSession,
      });
    } catch {}

    sendSuccess(res, {
      session: updatedSession,
      jobId: job.id,
      message: 'Walk-in session details saved successfully.',
    });
  } catch (err) {
    next(err);
  }
};



export function isFakeWalkInLocation(l: any): boolean {
  if (!l) return true;
  const id = String(l.id || '').toLowerCase();
  const name = String(l.locationName || l.venueName || '').toLowerCase();
  return (
    id === 'dummy' ||
    id === 'test-entry' ||
    id === 'loc-noida-hub' ||
    id === 'loc-gurugram-hub' ||
    name.includes('dummy location') ||
    name.includes('test entry')
  );
}

export interface WalkInLocation {
  id: string;
  locationName: string;
  city: string;
  companyName: string;
  venueName: string;
  venueAddress: string;
  googleMapsLink?: string;
  contactPersonName?: string;
  contactPersonPhone?: string;
  defaultReportingTime?: string;
  defaultInterviewStartTime?: string;
  defaultInterviewEndTime?: string;
  defaultInstructions?: string;
  defaultRequiredDocuments?: string[];
  dressCode?: string;
  weeklyOffDays?: string[];
  blockedDates?: string[];
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const OFFICIAL_HUBS: WalkInLocation[] = [
  {
    id: 'loc-indore-hub',
    locationName: 'Indore Walk-in Center',
    city: 'Indore',
    companyName: 'Orrica Edge LLP',
    venueName: 'Orrica Edge Indore Center',
    venueAddress: '4th Floor, Brilliant Solitaire, Scheme 78, Vijay Nagar, Indore, Madhya Pradesh 452010',
    googleMapsLink: 'https://maps.google.com/?q=Brilliant+Solitaire+Indore',
    defaultReportingTime: '09:30 AM',
    defaultInterviewStartTime: '10:00 AM',
    defaultInterviewEndTime: '04:00 PM',
    defaultInstructions: 'Carry 2 printed copies of resume and original Govt ID. Mention Orrica Edge LLP at the top.',
    isActive: true,
  },
  {
    id: 'loc-noida-center',
    locationName: 'Noida Walk-in Center',
    city: 'Noida',
    companyName: 'Orrica Edge LLP',
    venueName: 'Orrica Edge Noida Center',
    venueAddress: 'Tower B, Logix Cyber Park, Sector 62, Noida, Uttar Pradesh 201309',
    googleMapsLink: 'https://maps.google.com/?q=Logix+Cyber+Park+Noida',
    defaultReportingTime: '09:30 AM',
    defaultInterviewStartTime: '10:00 AM',
    defaultInterviewEndTime: '04:00 PM',
    defaultInstructions: 'Carry 2 printed copies of resume and original Govt ID. Mention Orrica Edge LLP at the top.',
    isActive: true,
  },
  {
    id: 'loc-gurugram-center',
    locationName: 'Gurugram Walk-in Center',
    city: 'Gurugram',
    companyName: 'Orrica Edge LLP',
    venueName: 'Orrica Edge Gurugram Hub',
    venueAddress: 'Tower B, 4th Floor, DLF Cyber City, Sector 25, Gurugram, Haryana 122002',
    googleMapsLink: 'https://maps.google.com/?q=DLF+Cyber+City+Gurugram',
    defaultReportingTime: '09:30 AM',
    defaultInterviewStartTime: '10:00 AM',
    defaultInterviewEndTime: '04:00 PM',
    defaultInstructions: 'Carry 2 printed copies of resume and original Govt ID. Mention Orrica Edge LLP at the top.',
    isActive: true,
  },
];


const DEFAULT_WALK_IN_LOCATIONS: WalkInLocation[] = OFFICIAL_HUBS;

let inMemoryLocations: WalkInLocation[] = [...DEFAULT_WALK_IN_LOCATIONS];


export async function findWalkInLocationById(locationIdOrCity?: string): Promise<WalkInLocation | null> {
  if (!locationIdOrCity) return null;
  const raw = String(locationIdOrCity).trim();
  const lower = raw.toLowerCase();

  // 1. Check stored locations in database/universalForm
  const stored = await getStoredLocations();
  const foundInStored =
    stored.find((l) => l.id === raw) ||
    stored.find((l) => l.city && l.city.toLowerCase() === lower) ||
    stored.find((l) => l.locationName && l.locationName.toLowerCase().includes(lower)) ||
    stored.find((l) => l.venueName && l.venueName.toLowerCase().includes(lower));
  if (foundInStored) return foundInStored;

  // 2. Check official hubs
  const foundInHubs =
    OFFICIAL_HUBS.find((l) => l.id === raw) ||
    OFFICIAL_HUBS.find((l) => l.city.toLowerCase() === lower) ||
    OFFICIAL_HUBS.find((l) => l.locationName.toLowerCase().includes(lower)) ||
    OFFICIAL_HUBS.find((l) => l.venueName.toLowerCase().includes(lower));
  if (foundInHubs) return foundInHubs;

  return null;
}

async function getStoredLocations(): Promise<WalkInLocation[]> {
  try {
    const record = await prisma.universalForm.findUnique({
      where: { slug: 'system-walk-in-locations' },
    });
    if (record && record.fields && typeof record.fields === 'object') {
      const f = record.fields as any;
      if (Array.isArray(f.locations)) {
        const cleaned = f.locations.filter((loc: WalkInLocation) => !isFakeWalkInLocation(loc));
        if (cleaned.length !== f.locations.length) {
          await saveStoredLocations(cleaned);
        }
        inMemoryLocations = cleaned;
        return inMemoryLocations;
      }
    }
  } catch (err: any) {
    console.warn('[WALK-IN LOCATIONS DB READ]:', err.message);
  }
  inMemoryLocations = inMemoryLocations.filter((loc) => !isFakeWalkInLocation(loc));
  return inMemoryLocations;
}

async function saveStoredLocations(locations: WalkInLocation[]): Promise<void> {
  inMemoryLocations = locations;
  try {
    await prisma.universalForm.upsert({
      where: { slug: 'system-walk-in-locations' },
      update: {
        fields: { locations } as any,
        updatedAt: new Date(),
      },
      create: {
        slug: 'system-walk-in-locations',
        name: 'System Walk-in Locations',
        description: 'Physical walk-in interview venues and hub locations',
        fields: { locations } as any,
        isActive: true,
      },
    });
  } catch (err: any) {
    console.warn('[WALK-IN LOCATIONS DB WRITE]:', err.message);
  }
}

/**
 * Get all walk-in locations
 * GET /api/v1/walk-in/locations
 */
export const getWalkInLocations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const locations = await getStoredLocations();
    sendSuccess(res, locations, 'Walk-in locations retrieved successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * Create a new walk-in location
 * POST /api/v1/walk-in/locations
 */
export const createWalkInLocation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = req.body;
    if (!data || !data.locationName?.trim() || !data.city?.trim() || !data.venueAddress?.trim()) {
      sendError(res, 'Location Name, City, and Complete Venue Address are required.', 400);
      return;
    }

    const currentLocations = await getStoredLocations();

    let mapsUrl = (data.googleMapsLink || '').trim();
    if (!mapsUrl && data.venueAddress?.trim()) {
      mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(data.venueAddress.trim());
    }

    const newLocation: WalkInLocation = {
      id: data.id || ('loc-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6)),
      locationName: data.locationName.trim(),
      city: data.city.trim(),
      companyName: (data.companyName || 'Orrica Partner Center').trim(),
      venueName: (data.venueName || data.locationName).trim(),
      venueAddress: data.venueAddress.trim(),
      googleMapsLink: mapsUrl,
      contactPersonName: (data.contactPersonName || '').trim(),
      contactPersonPhone: (data.contactPersonPhone || '').trim(),
      defaultReportingTime: data.defaultReportingTime || '09:30 AM',
      defaultInterviewStartTime: data.defaultInterviewStartTime || '10:00 AM',
      defaultInterviewEndTime: data.defaultInterviewEndTime || '02:00 PM',
      defaultInstructions: data.defaultInstructions || '',
      defaultRequiredDocuments: Array.isArray(data.defaultRequiredDocuments)
        ? data.defaultRequiredDocuments
        : ['Updated Resume (2 copies)', 'Government Photo ID', 'Educational Certificates'],
      dressCode: data.dressCode || 'Business Formal / Smart Casual',
      weeklyOffDays: Array.isArray(data.weeklyOffDays) ? data.weeklyOffDays : ['Sunday'],
      blockedDates: Array.isArray(data.blockedDates) ? data.blockedDates : [],
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const updatedList = [...currentLocations, newLocation];
    await saveStoredLocations(updatedList);

    sendSuccess(res, newLocation, 'Walk-in location created successfully.', 201);
  } catch (err) {
    next(err);
  }
};

/**
 * Update a walk-in location
 * PUT /api/v1/walk-in/locations/:id
 */
export const updateWalkInLocation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const locId = req.params.id;
    const data = req.body;

    const currentLocations = await getStoredLocations();
    const index = currentLocations.findIndex((l) => l.id === locId);

    if (index === -1) {
      sendError(res, 'Walk-in location not found.', 404);
      return;
    }

    let mapsUrl = data.googleMapsLink !== undefined ? String(data.googleMapsLink).trim() : currentLocations[index].googleMapsLink;
    if (!mapsUrl && data.venueAddress?.trim()) {
      mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(data.venueAddress.trim());
    }

    const updatedLocation: WalkInLocation = {
      ...currentLocations[index],
      locationName: data.locationName !== undefined ? data.locationName.trim() : currentLocations[index].locationName,
      city: data.city !== undefined ? data.city.trim() : currentLocations[index].city,
      companyName: data.companyName !== undefined ? data.companyName.trim() : currentLocations[index].companyName,
      venueName: data.venueName !== undefined ? data.venueName.trim() : currentLocations[index].venueName,
      venueAddress: data.venueAddress !== undefined ? data.venueAddress.trim() : currentLocations[index].venueAddress,
      googleMapsLink: mapsUrl,
      contactPersonName: data.contactPersonName !== undefined ? data.contactPersonName.trim() : currentLocations[index].contactPersonName,
      contactPersonPhone: data.contactPersonPhone !== undefined ? data.contactPersonPhone.trim() : currentLocations[index].contactPersonPhone,
      defaultReportingTime: data.defaultReportingTime !== undefined ? data.defaultReportingTime : currentLocations[index].defaultReportingTime,
      defaultInterviewStartTime: data.defaultInterviewStartTime !== undefined ? data.defaultInterviewStartTime : currentLocations[index].defaultInterviewStartTime,
      defaultInterviewEndTime: data.defaultInterviewEndTime !== undefined ? data.defaultInterviewEndTime : currentLocations[index].defaultInterviewEndTime,
      defaultInstructions: data.defaultInstructions !== undefined ? data.defaultInstructions : currentLocations[index].defaultInstructions,
      defaultRequiredDocuments: Array.isArray(data.defaultRequiredDocuments) ? data.defaultRequiredDocuments : currentLocations[index].defaultRequiredDocuments,
      dressCode: data.dressCode !== undefined ? data.dressCode : currentLocations[index].dressCode,
      weeklyOffDays: Array.isArray(data.weeklyOffDays) ? data.weeklyOffDays : currentLocations[index].weeklyOffDays,
      blockedDates: Array.isArray(data.blockedDates) ? data.blockedDates : currentLocations[index].blockedDates,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : currentLocations[index].isActive,
      updatedAt: new Date().toISOString(),
    };

    currentLocations[index] = updatedLocation;
    await saveStoredLocations(currentLocations);

    sendSuccess(res, updatedLocation, 'Walk-in location updated successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Deactivate or toggle status of walk-in location
 * PATCH /api/v1/walk-in/locations/:id/deactivate
 * PUT /api/v1/walk-in/locations/:id/deactivate
 */
export const deactivateWalkInLocation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const locId = req.params.id;
    const currentLocations = await getStoredLocations();
    const index = currentLocations.findIndex((l) => l.id === locId);

    if (index === -1) {
      sendError(res, 'Walk-in location not found.', 404);
      return;
    }

    const nextActive = req.body?.isActive !== undefined ? Boolean(req.body.isActive) : !currentLocations[index].isActive;
    currentLocations[index] = {
      ...currentLocations[index],
      isActive: nextActive,
      updatedAt: new Date().toISOString(),
    };

    await saveStoredLocations(currentLocations);

    sendSuccess(res, currentLocations[index], 'Walk-in location status updated successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * Delete walk-in location
 * DELETE /api/v1/walk-in/locations/:id
 */
export const deleteWalkInLocation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const locId = req.params.id;
    const currentLocations = await getStoredLocations();
    const filtered = currentLocations.filter((l) => l.id !== locId);

    const deletedItem = currentLocations.find((l) => l.id === locId) || null;
    await saveStoredLocations(filtered);

    try {
      await logAudit({
        req,
        action: 'DELETE_WALK_IN_LOCATION',
        module: 'WALK_IN_OPERATIONS',
        entity: 'WalkInLocation',
        entityId: locId,
        oldValue: deletedItem,
        newValue: { deletedLocationId: locId, locationName: deletedItem?.locationName },
      });
    } catch {}

    sendSuccess(res, { id: locId }, 'Walk-in location deleted successfully.');
  } catch (err) {
    next(err);
  }
};


/**
 * Admin: Delete a walk-in session from a job
 * DELETE /api/v1/walk-in/sessions/:id
 */
export const deleteWalkInSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionIdOrJobId = req.params.id;
    if (!sessionIdOrJobId) {
      sendError(res, 'Session ID or Job ID is required.', 400);
      return;
    }

    let job = await prisma.job.findFirst({
      where: {
        OR: [
          { id: sessionIdOrJobId },
          { jobCode: sessionIdOrJobId },
        ],
      },
    });

    if (!job) {
      const allJobs = await prisma.job.findMany({ take: 200 });
      job = allJobs.find((j) => {
        const hp = (j.hiringProcess as any) || {};
        return hp.walkInSession?.id === sessionIdOrJobId;
      }) || null;
    }

    if (!job) {
      sendError(res, 'Walk-in session not found.', 404);
      return;
    }

    const existingHp = (job.hiringProcess as any) || {};
    const oldSession = existingHp.walkInSession || null;

    const updatedHp = { ...existingHp };
    delete updatedHp.walkInSession;

    await prisma.job.update({
      where: { id: job.id },
      data: {
        hiringProcess: updatedHp,
      },
    });

    try {
      await logAudit({
        req,
        action: 'DELETE_WALK_IN_SESSION',
        module: 'WALK_IN_OPERATIONS',
        entity: 'Job',
        entityId: job.id,
        oldValue: oldSession,
        newValue: { deletedSessionId: sessionIdOrJobId, jobId: job.id, jobTitle: job.title },
      });
    } catch {}

    sendSuccess(res, { id: sessionIdOrJobId, jobId: job.id }, 'Walk-in session deleted successfully.');
  } catch (err) {
    next(err);
  }
};


/**
 * Admin/Recruiter: Reject candidate from active walk-in session.
 * Removes candidate from the active session participant list while strictly preserving master record,
 * resume, applications, and historical invitations.
 * POST /api/v1/walk-in/candidates/:id/reject
 */
export const rejectWalkInCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const candidateId = req.params.id;
    const { reason, jobId, sessionId } = req.body || {};
    const currentUserId = (req as any).user?.id || (req as any).user?.userId;
    const currentUserName = (req as any).user?.name || (req as any).user?.fullName || 'Authorized User';
    const currentUserRole = (req as any).user?.role || 'ADMIN';

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: candidateId },
          { candidateCode: candidateId },
        ],
      },
      include: {
        applications: {
          include: { job: true },
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Candidate not found', 404);
      return;
    }

    // 1. Update session-level walk-in status to REJECTED (Preserves master recruitment status)
    const updated = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        walkInStatus: 'REJECTED',
        walkInResponse: 'REJECTED',
        feedback: reason ? `[Walk-in Rejection]: ${reason}` : candidate.feedback,
      },
    });

    // 2. Remove candidate from active participant list of the walk-in session on the job
    const targetJobId = jobId || candidate.applications?.[0]?.jobId || candidate.applications?.[0]?.job?.id;
    if (targetJobId) {
      const job = await prisma.job.findUnique({ where: { id: targetJobId } });
      if (job && job.hiringProcess) {
        const hp = job.hiringProcess as any;
        if (hp.walkInSession && Array.isArray(hp.walkInSession.alignedCandidateIds)) {
          hp.walkInSession.alignedCandidateIds = hp.walkInSession.alignedCandidateIds.filter(
            (id: string) => id !== candidate.id && id !== candidate.candidateCode
          );
          await prisma.job.update({
            where: { id: job.id },
            data: { hiringProcess: hp },
          });
        }
      }
    }

    // 3. Record Activity and Timeline for complete auditability
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        action: 'WALK_IN_REJECTED',
        notes: `Candidate rejected from walk-in session. Reason: ${reason || 'Administrative rejection'}. By: ${currentUserName}`,
        metadata: {
          reason,
          sessionId,
          jobId: targetJobId,
          rejectedBy: currentUserId,
          rejectedByName: currentUserName,
          rejectedAt: new Date().toISOString(),
        },
      },
    });

    await logCandidateTimeline({
      candidateId: candidate.id,
      userId: currentUserId,
      userName: currentUserName,
      userRole: currentUserRole,
      action: 'Candidate Rejected from Walk-in Session',
      newStatus: candidate.status,
      remarks: `Candidate rejected from walk-in session. Master candidate record & resume preserved. Reason: ${reason || 'Administrative decision'}.`,
    });

    await logAudit({
      req,
      action: 'REJECT_WALK_IN_CANDIDATE',
      module: 'WALK_IN_MANAGEMENT',
      entity: 'Candidate',
      entityId: candidate.id,
      details: {
        candidateCode: candidate.candidateCode,
        candidateName: candidate.fullName,
        reason,
        jobId: targetJobId,
      },
    });

    sendSuccess(res, {
      candidate: updated,
      message: 'Candidate rejected from walk-in session. Master candidate record is preserved.',
    });
  } catch (err) {
    next(err);
  }
};
