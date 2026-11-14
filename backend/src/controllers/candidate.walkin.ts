import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { sendDynamicEmail } from '../services/email.service';
import { formatCandidateGreetingName, formatCandidateGreeting } from '../utils/nameFormatter';
import { formatWalkInDate, formatReadableInterviewDate } from '../utils/dateFormatter';
import { findWalkInLocationById } from './walk-in.controller';
import { logCandidateTimeline } from '../services/timeline.service';
import { logAudit } from '../services/audit.service';

export const resendWalkInEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;

    if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
      sendError(res, 'Candidate identifier is required', 400);
      return;
    }

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
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
      sendError(res, 'Candidate not found', 404);
      return;
    }

    // Role-based candidate access verification
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;
    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      const isAuthorized =
        Boolean(currentUserId) &&
        (candidate.sourcingRecruiterId === currentUserId ||
          candidate.ownerRecruiterId === currentUserId ||
          candidate.createdById === currentUserId ||
          (Array.isArray(candidate.assignedRecruiterIds) && (candidate.assignedRecruiterIds as string[]).includes(currentUserId!)) ||
          (candidate.applications || []).some((app: any) => app.recruiterId === currentUserId) ||
          (Array.isArray(candidate.tags) && (candidate.tags as string[]).includes(`assignedRecruiter:${currentUserId}`)));
      if (!isAuthorized) {
        sendError(res, 'You are not authorized to resend walk-in emails to this candidate.', 403);
        return;
      }
    }

    // Email validation
    if (!candidate.email || !candidate.email.trim() || !candidate.email.includes('@')) {
      sendError(res, 'Candidate does not have a valid email address configured.', 400);
      return;
    }

    // Match exact application based on body jobId/applicationId or candidate targetJobId
    let application: any = null;
    if (req.body?.applicationId && candidate.applications.length > 0) {
      application = candidate.applications.find((app) => app.id === req.body.applicationId);
    }
    if (!application && req.body?.jobId && candidate.applications.length > 0) {
      const targetJobId = String(req.body.jobId);
      application = candidate.applications.find(
        (app) => app.jobId === targetJobId || app.job?.id === targetJobId || app.job?.jobCode === targetJobId
      );
    }
    if (!application && (candidate as any).targetJobId && candidate.applications.length > 0) {
      application = candidate.applications.find(
        (app) => app.jobId === (candidate as any).targetJobId || app.job?.id === (candidate as any).targetJobId
      );
    }
    if (!application) {
      application = candidate.applications?.[0] || null;
    }

    const job = application?.job;

    // Verify candidate alignment with target job if specified
    if (req.body?.jobId && job) {
      const targetJobId = String(req.body.jobId);
      const isAligned = candidate.applications.some(
        (app) => app.jobId === targetJobId || app.job?.id === targetJobId || app.job?.jobCode === targetJobId
      );
      if (!isAligned && candidate.applications.length > 0) {
        sendError(res, 'Candidate is not aligned with the specified walk-in job opening.', 400);
        return;
      }
    }

    // Resolve saved session details from body or job.hiringProcess.walkInSession
    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};

    // Walk-in session validation
    const rawDate = req.body?.walkInDate || candidate.walkInDate || savedSession.date || savedSession.interviewDate;
    const dateInfo = formatWalkInDate(rawDate);
    if (!dateInfo.dateStr) {
      sendError(res, 'Candidate does not have an active walk-in session or scheduled date. The Admin must save session details before sending invitations.', 400);
      return;
    }

    const reportingTimeStr = (req.body?.reportingTime || candidate.walkInTime || savedSession.reportingTime || '').trim();
    const venueNameStr = (req.body?.venueName || savedSession.venueName || '').trim();
    const venueAddressStr = (req.body?.venueAddress || savedSession.venueAddress || '').trim();
    let googleMapsLinkStr = (req.body?.googleMapsLink || savedSession.googleMapsLink || '').trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }

    const instructionsStr = (req.body?.instructions || savedSession.instructions || '').trim();

    // Enforce required walk-in session details
    if (!reportingTimeStr || !venueNameStr || !venueAddressStr) {
      sendError(res, 'Walk-in session details are incomplete. The Admin must save session details (venue name, complete address, and reporting time) before sending invitations.', 400);
      return;
    }

    // Enforce valid Google Maps link
    if (!googleMapsLinkStr || (!googleMapsLinkStr.startsWith('http://') && !googleMapsLinkStr.startsWith('https://'))) {
      sendError(res, 'A valid Google Maps destination URL is required for the walk-in session directions.', 400);
      return;
    }

    // Idempotency: Prevent accidental duplicate emails within 15 seconds
    const recentActivity = await prisma.candidateActivity.findFirst({
      where: {
        candidateId: candidate.id,
        action: 'WALK_IN_EMAIL_RESENT',
        createdAt: { gte: new Date(Date.now() - 15 * 1000) },
      },
    });

    if (recentActivity) {
      sendSuccess(res, {
        candidateId: candidate.id,
        candidateName: candidate.fullName,
        recipient: candidate.email,
        dispatched: true,
        cooldown: true,
        message: 'Walk-in confirmation email was recently dispatched to ' + candidate.email + '. (Cooldown active)',
      });
      return;
    }

    const jobTitle = req.body?.jobTitle || job?.title || 'Walk-in Interview Candidate';
    const rawClientName = (req.body?.clientName || req.body?.companyName || job?.client?.companyName || '').trim();
    const clientName = (rawClientName && !['orrica edge', 'orrica edge partner', 'orrica edge llp', 'orrica'].includes(rawClientName.toLowerCase())) ? rawClientName : '';
    const walkInDateStr = dateInfo.dateStr;
    const greetingName = formatCandidateGreetingName(candidate);
    const selectedSessionId = (req.body?.sessionId || req.body?.locationId || (candidate as any).walkInSessionId || savedSession.id || '').trim();

    // Encode structured token containing exact candidate, job, application, and session signature
    const tokenPayload = {
      c: candidate.id,
      j: job?.id,
      a: application?.id,
      s: selectedSessionId || savedSession.id,
    };
    const token = 'wic_' + Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');

    const frontendBase = (process.env.FRONTEND_URL || 'https://orricaedge.com').replace(/\/+$/, '');
    const confirmationUrl = frontendBase + '/walk-in/confirm/' + encodeURIComponent(token);
    const confirmUrl = confirmationUrl + '?action=confirm';
    const rescheduleUrl = confirmationUrl + '?action=reschedule';
    const notInterestedUrl = confirmationUrl + '?action=not_interested';

    const variables: Record<string, string> = {
      candidate_name: greetingName,
      candidate_greeting: formatCandidateGreeting(candidate),
      candidate_email: candidate.email,
      job_title: jobTitle,
      client_name: clientName,
      walk_in_date: walkInDateStr,
      walkin_date: walkInDateStr,
      walk_in_date_formatted: dateInfo.displayDate,
      interview_date: dateInfo.displayDate,
      reporting_time: reportingTimeStr,
      walk_in_time: reportingTimeStr,
      venue_name: venueNameStr,
      venue_address: venueAddressStr,
      google_maps_link: googleMapsLinkStr,
      instructions: instructionsStr,
      candidate_instructions: instructionsStr,
      confirmation_url: confirmationUrl,
      confirmation_link: confirmationUrl,
      confirm_url: confirmUrl,
      reschedule_url: rescheduleUrl,
      not_interested_url: notInterestedUrl,
    };

    let dispatchResult: { success: boolean; messageId?: string };
    try {
      dispatchResult = await sendDynamicEmail({
        templateKey: 'WALK_IN_INVITATION',
        recipient: candidate.email,
        variables,
      });
    } catch (providerErr: any) {
      console.error('[WALK-IN RESEND EMAIL FAILED] Candidate ' + candidate.id + ':', providerErr);
      sendError(res, 'Email provider failed to dispatch confirmation email: ' + (providerErr.message || 'Provider transmission error'), 502);
      return;
    }

    const recruiterId = req.user?.role === 'RECRUITER' ? req.user.userId : null;
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        userId: req.user?.userId || null,
        recruiterId,
        action: 'WALK_IN_EMAIL_RESENT',
        notes: 'Walk-in confirmation email dispatched to ' + candidate.email + ' for ' + jobTitle + ' (' + walkInDateStr + ').',
        metadata: {
          recipient: candidate.email,
          jobId: job?.id,
          applicationId: application?.id,
          sessionId: selectedSessionId || savedSession.id,
          walkInDate: walkInDateStr,
          reportingTime: reportingTimeStr,
          venueName: venueNameStr,
          venueAddress: venueAddressStr,
          googleMapsLink: googleMapsLinkStr,
          messageId: dispatchResult.messageId,
          token,
        },
      },
    });

    await logCandidateTimeline({
      candidateId: candidate.id,
      userId: req.user?.userId || null,
      userName: req.user?.email || 'Recruiter',
      userRole: req.user?.role || 'ADMIN',
      action: 'Walk-in Confirmation Email Resent',
      newStatus: candidate.status,
      remarks: 'Walk-in confirmation email re-dispatched to ' + candidate.email + ' for ' + jobTitle + ' (' + walkInDateStr + ').',
    });

    sendSuccess(res, {
      candidateId: candidate.id,
      candidateName: candidate.fullName,
      recipient: candidate.email,
      dispatched: true,
      messageId: dispatchResult.messageId,
      walkInDate: walkInDateStr,
      reportingTime: reportingTimeStr,
      venueName: venueNameStr,
      venueAddress: venueAddressStr,
      message: 'Walk-in confirmation email sent successfully to ' + candidate.email + '.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Dispatch Initial Walk-in Invitation: POST /api/v1/candidates/:id/send-walk-in-invitation
 */
export const sendWalkInInvitation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
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
      sendError(res, 'Candidate not found', 404);
      return;
    }

    if (!candidate.email || !candidate.email.trim() || !candidate.email.includes('@')) {
      sendError(res, 'Candidate does not have a valid email address configured.', 400);
      return;
    }

    // Role-based candidate access verification
    const userRole = req.user?.role;
    const currentUserId = req.user?.userId;
    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      const isAuthorized =
        candidate.sourcingRecruiterId === currentUserId ||
        candidate.ownerRecruiterId === currentUserId ||
        candidate.createdById === currentUserId ||
        candidate.applications.some((app: any) => app.recruiterId === currentUserId);
      if (!isAuthorized) {
        sendError(res, 'You are not authorized to send walk-in invitations to this candidate.', 403);
        return;
      }
    }

    // Match application if available
    let application: any = null;
    if (req.body?.applicationId && candidate.applications.length > 0) {
      application = candidate.applications.find((app) => app.id === req.body.applicationId);
    }
    if (!application && req.body?.jobId && candidate.applications.length > 0) {
      const targetJobId = String(req.body.jobId);
      application = candidate.applications.find(
        (app) => app.jobId === targetJobId || app.job?.id === targetJobId || app.job?.jobCode === targetJobId
      );
    }
    if (!application && (candidate as any).targetJobId && candidate.applications.length > 0) {
      application = candidate.applications.find(
        (app) => app.jobId === (candidate as any).targetJobId || app.job?.id === (candidate as any).targetJobId
      );
    }
    if (!application) {
      application = candidate.applications?.[0] || null;
    }

    const job = application?.job;

    // Resolve saved session details from body or job.hiringProcess.walkInSession
    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};

    const rawDate = req.body?.walkInDate || candidate.walkInDate || savedSession.date || savedSession.interviewDate;
    const dateInfo = formatWalkInDate(rawDate);
    if (!dateInfo.dateStr) {
      sendError(res, 'A valid walk-in interview date is required.', 400);
      return;
    }

    const readableInterviewDate = formatReadableInterviewDate(rawDate) || dateInfo.displayDate;

    const selectedSessionId = (req.body?.sessionId || req.body?.locationId || '').trim();
    const targetSessionId = selectedSessionId || savedSession.id || '';
    let locationVenue: any = null;
    if (selectedSessionId) {
      locationVenue = await findWalkInLocationById(selectedSessionId);
    }

    const reportingTime = (
      req.body?.reportingTime ||
      req.body?.walkInTime ||
      candidate.walkInTime ||
      locationVenue?.defaultReportingTime ||
      savedSession.reportingTime ||
      '09:30 AM'
    ).trim();

    const venueNameStr = (
      req.body?.venueName ||
      locationVenue?.venueName ||
      locationVenue?.locationName ||
      savedSession.venueName ||
      ''
    ).trim();

    const venueAddressStr = (
      req.body?.venueAddress ||
      locationVenue?.venueAddress ||
      savedSession.venueAddress ||
      ''
    ).trim();

    let googleMapsLinkStr = (
      req.body?.googleMapsLink ||
      locationVenue?.googleMapsLink ||
      savedSession.googleMapsLink ||
      ''
    ).trim();

    if (!googleMapsLinkStr && venueAddressStr) {
      googleMapsLinkStr = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venueAddressStr);
    }

    const instructionsStr = (req.body?.instructions || savedSession.instructions || '').trim();

    // Enforce required walk-in session details
    if (!reportingTime || !venueNameStr || !venueAddressStr) {
      sendError(res, 'Walk-in session details are incomplete. Please provide a valid venue name, complete address, and reporting time.', 400);
      return;
    }

    // Persist walk-in schedule if updated
    const targetWalkInDate = new Date(dateInfo.dateStr + 'T12:00:00Z');
    const updatedCandidate = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        walkInDate: targetWalkInDate,
        walkInTime: reportingTime,
        walkInStatus: candidate.walkInStatus || 'EXPECTED',
      },
    });

    const jobTitle = req.body?.jobTitle || job?.title || 'Walk-in Interview Candidate';
    const rawClientName = (req.body?.clientName || req.body?.companyName || job?.client?.companyName || '').trim();
    const clientName = (rawClientName && !['orrica edge', 'orrica edge partner', 'orrica edge llp', 'orrica'].includes(rawClientName.toLowerCase())) ? rawClientName : '';
    const walkInDateStr = dateInfo.dateStr;
    const greetingName = formatCandidateGreetingName(candidate);

    // Encode structured token containing exact candidate, job, application, and session signature
    const tokenPayload = {
      c: candidate.id,
      j: job?.id,
      a: application?.id,
      s: targetSessionId || savedSession.id,
    };
    const token = 'wic_' + Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');

    const frontendBase = (process.env.FRONTEND_URL || 'https://orricaedge.com').replace(/\/+$/, '');
    const confirmationUrl = frontendBase + '/walk-in/confirm/' + encodeURIComponent(token);
    const confirmUrl = confirmationUrl + '?action=confirm';
    const rescheduleUrl = confirmationUrl + '?action=reschedule';
    const notInterestedUrl = confirmationUrl + '?action=not_interested';

    const variables: Record<string, string> = {
      candidate_name: greetingName,
      candidate_greeting: formatCandidateGreeting(candidate),
      candidate_email: candidate.email,
      job_title: jobTitle,
      client_name: clientName,
      company_name: clientName,
      walk_in_date: readableInterviewDate,
      walkin_date: readableInterviewDate,
      walk_in_date_formatted: readableInterviewDate,
      interview_date: readableInterviewDate,
      reporting_time: reportingTime,
      walk_in_time: reportingTime,
      venue_name: venueNameStr,
      venue_address: venueAddressStr,
      google_maps_link: googleMapsLinkStr,
      instructions: instructionsStr,
      candidate_instructions: instructionsStr,
      confirmation_url: confirmationUrl,
      confirmation_link: confirmationUrl,
      confirm_url: confirmUrl,
      reschedule_url: rescheduleUrl,
      not_interested_url: notInterestedUrl,
    };

    let dispatchResult: { success: boolean; messageId?: string };
    try {
      dispatchResult = await sendDynamicEmail({
        templateKey: 'WALK_IN_INVITATION',
        recipient: candidate.email,
        variables,
      });
    } catch (providerErr: any) {
      console.error('[WALK-IN INVITATION EMAIL FAILED] Candidate ' + candidate.id + ':', providerErr);

      // Audit Log for Failed Attempt
      try {
        await logAudit({
          req,
          action: 'WALK_IN_INVITATION_FAILED',
          module: 'WALK_IN_INVITATIONS',
          entity: 'Candidate',
          entityId: candidate.id,
          newValue: {
            candidateId: candidate.id,
            candidateCode: candidate.candidateCode,
            candidateName: candidate.fullName,
            candidateEmail: candidate.email,
            interviewDate: readableInterviewDate,
            walkInDate: walkInDateStr,
            venueName: venueNameStr,
            venueAddress: venueAddressStr,
            reportingTime,
            instructions: instructionsStr || null,
            sentBy: req.user?.role === 'RECRUITER' || req.user?.role === 'FREELANCE_RECRUITER' ? 'Recruiter' : 'Admin',
            senderRole: req.user?.role || 'ADMIN',
            senderUserId: req.user?.userId || null,
            senderName: req.user?.email || 'User',
            deliveryStatus: 'FAILED',
            errorDetails: providerErr.message || 'Email dispatch failed',
            timestamp: new Date().toISOString(),
          },
        });
      } catch (auditErr: any) {
        console.warn('[AUDIT LOG FAILED ATTEMPT ERROR]:', auditErr.message);
      }

      sendError(res, 'Email provider failed to dispatch invitation email: ' + (providerErr.message || 'Provider transmission error'), 502);
      return;
    }

    const recruiterId = req.user?.role === 'RECRUITER' ? req.user.userId : null;
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        userId: req.user?.userId || null,
        recruiterId,
        action: 'WALK_IN_INVITATION_SENT',
        notes: 'Walk-in invitation sent to ' + candidate.email + ' for ' + jobTitle + ' (' + readableInterviewDate + ').',
        metadata: {
          recipient: candidate.email,
          jobId: job?.id,
          applicationId: application?.id,
          sessionId: targetSessionId || savedSession.id,
          walkInDate: walkInDateStr,
          interviewDate: readableInterviewDate,
          reportingTime,
          venueName: venueNameStr,
          venueAddress: venueAddressStr,
          googleMapsLink: googleMapsLinkStr,
          instructions: instructionsStr,
          messageId: dispatchResult.messageId,
          token,
        },
      },
    });

    await logCandidateTimeline({
      candidateId: candidate.id,
      userId: req.user?.userId || null,
      userName: req.user?.email || 'Recruiter',
      userRole: req.user?.role || 'ADMIN',
      action: 'Walk-in Invitation Sent',
      newStatus: updatedCandidate.status,
      remarks: 'Walk-in invitation dispatched to ' + candidate.email + ' for ' + jobTitle + ' (' + readableInterviewDate + ').',
    });

    // Audit Log for Successful Invitation
    try {
      await logAudit({
        req,
        action: 'WALK_IN_INVITATION_SENT',
        module: 'WALK_IN_INVITATIONS',
        entity: 'Candidate',
        entityId: candidate.id,
        newValue: {
          candidateId: candidate.id,
          candidateCode: candidate.candidateCode,
          candidateName: candidate.fullName,
          candidateEmail: candidate.email,
          interviewDate: readableInterviewDate,
          walkInDate: walkInDateStr,
          venueName: venueNameStr,
          venueAddress: venueAddressStr,
          reportingTime,
          instructions: instructionsStr || null,
          sentBy: req.user?.role === 'RECRUITER' || req.user?.role === 'FREELANCE_RECRUITER' ? 'Recruiter' : 'Admin',
          senderRole: req.user?.role || 'ADMIN',
          senderUserId: req.user?.userId || null,
          senderName: req.user?.email || 'User',
          deliveryStatus: 'SENT',
          messageId: dispatchResult.messageId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (auditErr: any) {
      console.warn('[AUDIT LOG SUCCESSFUL INVITATION ERROR]:', auditErr.message);
    }

    sendSuccess(res, {
      candidateId: candidate.id,
      candidateName: candidate.fullName,
      recipient: candidate.email,
      dispatched: true,
      messageId: dispatchResult.messageId,
      walkInDate: walkInDateStr,
      interviewDate: readableInterviewDate,
      reportingTime,
      venueName: venueNameStr,
      venueAddress: venueAddressStr,
      message: 'Walk-in invitation sent successfully to ' + candidate.email + '.',
    });
  } catch (err) {
    next(err);
  }
};

export const approveWalkInReschedule = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const identifier = req.params.id;
    const { approvedDate, approvedTime } = req.body;

    const candidate = await prisma.candidate.findFirst({
      where: {
        OR: [
          { id: identifier },
          { candidateCode: identifier },
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
      sendError(res, 'Candidate not found', 404);
      return;
    }

    const rawDate = approvedDate || candidate.walkInDate || new Date();
    const dateInfo = formatWalkInDate(rawDate);
    const newWalkInDate = new Date(dateInfo.dateStr + 'T12:00:00Z');
    const newWalkInTime = approvedTime || candidate.walkInTime || '10:00 AM';

    const updated = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        walkInDate: newWalkInDate,
        walkInTime: newWalkInTime,
        walkInStatus: 'CONFIRMED',
        walkInResponse: 'COMING_TODAY',
      },
    });

    const application = candidate.applications?.[0];
    const job = application?.job;
    const jobTitle = job?.title || 'Walk-in Interview Candidate';
    const dateStr = dateInfo.dateStr;
    const greetingName = formatCandidateGreetingName(candidate);

    const hiringProcess = (job?.hiringProcess as any) || {};
    const savedSession = hiringProcess.walkInSession || {};
    const venueNameStr = (savedSession.venueName || '').trim();
    const venueAddressStr = (savedSession.venueAddress || '').trim();

    if (candidate.email && candidate.email.includes('@')) {
      try {
        await sendDynamicEmail({
          templateKey: 'WALK_IN_RESCHEDULE_APPROVED',
          recipient: candidate.email,
          variables: {
            candidate_name: greetingName,
            candidate_greeting: formatCandidateGreeting(candidate),
            candidate_email: candidate.email,
            job_title: jobTitle,
            walk_in_date: dateStr,
            walkin_date: dateStr,
            walk_in_date_formatted: dateInfo.displayDate,
            reporting_time: newWalkInTime,
            venue_name: venueNameStr,
            venue_address: venueAddressStr,
          },
        });
      } catch (emailErr: any) {
        console.warn('[RESCHEDULE APPROVAL EMAIL WARNING]:', emailErr.message);
      }
    }

    const recruiterId = req.user?.role === 'RECRUITER' ? req.user.userId : null;
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        userId: req.user?.userId || null,
        recruiterId,
        action: 'WALK_IN_RESCHEDULE_APPROVED',
        notes: 'Walk-in reschedule request approved for ' + dateStr + ' at ' + newWalkInTime + '.',
        metadata: {
          approvedDate: dateStr,
          approvedTime: newWalkInTime,
        },
      },
    });

    await logCandidateTimeline({
      candidateId: candidate.id,
      userId: req.user?.userId || null,
      userName: req.user?.email || 'Recruiter',
      userRole: req.user?.role || 'ADMIN',
      action: 'Walk-in Reschedule Approved',
      newStatus: updated.status,
      remarks: 'Walk-in reschedule approved for ' + dateStr + ' at ' + newWalkInTime + '.',
    });

    sendSuccess(res, {
      candidate: updated,
      message: 'Reschedule approved for ' + dateStr + '.',
    });
  } catch (err) {
    next(err);
  }
};