import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { sendDynamicEmail } from '../services/email.service';
import { logCandidateTimeline } from '../services/timeline.service';
import { formatCandidateGreetingName, formatCandidateGreeting } from '../utils/nameFormatter';
import { formatWalkInDate } from '../utils/dateFormatter';

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

    // Retrieve configured session details from job.hiringProcess
    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};

    // Format walk-in date using IST date formatter
    const rawDate = candidate.walkInDate || savedSession.date || savedSession.interviewDate;
    const dateInfo = formatWalkInDate(rawDate);
    const walkInDateStr = dateInfo.dateStr;

    const reportingTimeStr = (candidate.walkInTime || savedSession.reportingTime || '').trim();
    const venueNameStr = (savedSession.venueName || '').trim();
    const venueAddressStr = (savedSession.venueAddress || '').trim();
    let googleMapsLinkStr = (savedSession.googleMapsLink || '').trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }
    if (googleMapsLinkStr && !googleMapsLinkStr.startsWith('http://') && !googleMapsLinkStr.startsWith('https://')) {
      googleMapsLinkStr = '';
    }

    const instructionsStr = (savedSession.instructions || '').trim();
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
    const greetingName = formatCandidateGreetingName(candidate);

    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};
    const venueNameStr = (savedSession.venueName || '').trim();
    const venueAddressStr = (savedSession.venueAddress || '').trim();
    let googleMapsLinkStr = (savedSession.googleMapsLink || '').trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }
    if (googleMapsLinkStr && !googleMapsLinkStr.startsWith('http://') && !googleMapsLinkStr.startsWith('https://')) {
      googleMapsLinkStr = '';
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
    const jobs = await prisma.job.findMany({
      include: { client: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const sessions = jobs
      .map((job) => {
        const hp = (job.hiringProcess as any) || {};
        if (hp.walkInSession) {
          return {
            ...hp.walkInSession,
            jobId: job.id,
            jobTitle: job.title,
            clientName: job.client?.companyName,
          };
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
    const job = await prisma.job.findFirst({
      where: {
        OR: [
          { id: targetJobId },
          { jobCode: targetJobId },
        ],
      },
    });

    if (job) {
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

      const updatedHp = {
        ...existingHp,
        walkInSession: {
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
        },
      };

      await prisma.job.update({
        where: { id: job.id },
        data: {
          hiringProcess: updatedHp,
        },
      });
    }

    sendSuccess(res, {
      session: sessionData,
      message: 'Walk-in session details saved successfully.',
    });
  } catch (err) {
    next(err);
  }
};
