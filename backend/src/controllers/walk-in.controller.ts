import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { sendDynamicEmail } from '../services/email.service';
import { logCandidateTimeline } from '../services/timeline.service';

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

    // Token format: wic_<base64url> or wic_<candidateId>_<hashOrCode> or <candidateId> or candidateCode
    let candidateId = rawToken;
    if (rawToken.startsWith('wic_')) {
      const part = rawToken.slice(4);
      try {
        const decoded = Buffer.from(part, 'base64url').toString('utf8');
        if (/^[0-9a-fA-F-]{36}$/.test(decoded) || /^[A-Za-z0-9_-]+$/.test(decoded)) {
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
          take: 1,
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Walk-in invitation not found or link has expired', 404);
      return;
    }

    const application = candidate.applications?.[0];
    const job = application?.job;

    // Public sanitized payload
    sendSuccess(res, {
      candidate: {
        id: candidate.id,
        candidateCode: candidate.candidateCode,
        fullName: candidate.fullName,
        email: candidate.email,
        walkInStatus: candidate.walkInStatus,
        walkInResponse: candidate.walkInResponse,
        walkInDate: candidate.walkInDate,
        walkInTime: candidate.walkInTime,
      },
      jobTitle: job?.title || 'Walk-in Interview Candidate',
      jobCode: job?.jobCode || 'OE-WALK',
      clientName: job?.client?.companyName || 'Orrica Edge Partner',
      session: {
        id: 'session-' + candidate.id,
        date: candidate.walkInDate?.toISOString().slice(0, 10),
        reportingTime: candidate.walkInTime || '10:00 AM',
        venueName: 'Orrica Edge Corporate Tower — Hub 4',
        venueAddress: 'Floor 4, Block B, DLF Cyber City, Phase II, Gurugram, Haryana 122002',
        googleMapsLink: 'https://maps.google.com/?q=DLF+Cyber+City+Gurugram',
        instructions: 'Please bring 2 copies of your updated resume and government photo ID. Arrive in business formals.',
      },
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

    // Token format: wic_<base64url> or wic_<candidateId>_<hashOrCode> or <candidateId> or candidateCode
    let candidateId = rawToken;
    if (rawToken.startsWith('wic_')) {
      const part = rawToken.slice(4);
      try {
        const decoded = Buffer.from(part, 'base64url').toString('utf8');
        if (/^[0-9a-fA-F-]{36}$/.test(decoded) || /^[A-Za-z0-9_-]+$/.test(decoded)) {
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
          take: 1,
        },
      },
    });

    if (!candidate) {
      sendError(res, 'Walk-in invitation not found', 404);
      return;
    }

    const application = candidate.applications?.[0];
    const job = application?.job;
    const jobTitle = job?.title || 'Walk-in Interview';
    const jobId = job?.jobCode || job?.id || 'OE-WALK';

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
      newWalkInStatus = 'RESCHEDULED';
      newWalkInResponse = 'SPECIFIC_DATE';
      timelineAction = 'Candidate Requested Reschedule';
      templateKey = 'WALK_IN_RESCHEDULE_ACK';
    } else if (action === 'NOT_INTERESTED') {
      newWalkInStatus = 'CANCELLED';
      newWalkInResponse = 'NOT_INTERESTED';
      timelineAction = 'Candidate Not Interested';
      templateKey = 'WALK_IN_NOT_INTERESTED_ACK';
    }

    const updated = await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        walkInStatus: newWalkInStatus,
        walkInResponse: newWalkInResponse,
        feedback: comment || reason || candidate.feedback,
      },
    });

    // Record CandidateActivity
    await prisma.candidateActivity.create({
      data: {
        candidateId: candidate.id,
        action: `WALK_IN_${action}`,
        notes: `Candidate self-selected ${action}. ${comment || reason || ''}`.trim(),
        metadata: {
          action,
          preferredDate,
          reason,
          comment,
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
      remarks: `Candidate submitted self-confirmation: ${action}. ${comment || ''}`.trim(),
    });

    // Send acknowledgement email if candidate has email
    if (candidate.email && candidate.email.includes('@')) {
      const walkInDateStr = candidate.walkInDate ? candidate.walkInDate.toISOString().slice(0, 10) : '';
      try {
        await sendDynamicEmail({
          templateKey,
          recipient: candidate.email,
          variables: {
            candidate_name: candidate.fullName || candidate.name || 'Candidate',
            candidate_email: candidate.email,
            job_title: jobTitle,
            job_id: jobId,
            walk_in_date: walkInDateStr,
            walkin_date: walkInDateStr,
            reporting_time: candidate.walkInTime || '10:00 AM',
            venue_name: 'Orrica Edge Corporate Tower — Hub 4',
            venue_address: 'Floor 4, Block B, DLF Cyber City, Phase II, Gurugram, Haryana 122002',
            google_maps_link: 'https://maps.google.com/?q=DLF+Cyber+City+Gurugram',
            preferred_date: preferredDate || '',
            comments: comment || reason || '',
          },
        });
      } catch (mailErr: any) {
        console.warn('[SELF-CONFIRMATION ACK EMAIL WARN]:', mailErr.message);
      }
    }

    sendSuccess(res, {
      candidate: updated,
      message: `Response recorded successfully for ${action}.`,
    });
  } catch (err) {
    next(err);
  }
};
