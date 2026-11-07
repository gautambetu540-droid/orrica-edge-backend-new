import { Resend } from 'resend';
import { prisma } from '../prisma/client';
import { compileEmailTemplate } from './templateEngine.service';
import { config } from '../config';

const resendApiKey = config.email.resendApiKey || process.env.RESEND_API_KEY || '';
const resend = resendApiKey ? new Resend(resendApiKey) : null;

export const RESEND_FROM_EMAIL = config.email.from;

/**
 * Sanitize email payload variables so credentials and secrets are NEVER logged in audit records.
 */
const sanitizePayload = (vars: Record<string, string>): Record<string, string> => {
  const sanitized = { ...vars };
  for (const key of Object.keys(sanitized)) {
    if (/password|token|secret/i.test(key) && key !== 'job_code' && key !== 'application_id' && key !== 'recruiter_id') {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
};

export interface DispatchEmailPayload {
  templateKey: string;
  recipient: string;
  variables: Record<string, string>;
  from?: string;
}

/**
 * Core dynamic email dispatcher that awaits template compilation, provider transmission,
 * and records the audit log in prisma.emailLog.
 * Rejects if provider returns an error so controllers can handle email-provider failures.
 */
export const sendDynamicEmail = async (
  payload: DispatchEmailPayload
): Promise<{ success: boolean; messageId?: string }> => {
  const { templateKey, recipient, variables } = payload;
  // Centralized sender configuration strictly enforced to authorized sending domain update.orricaedge.com
  const fromAddress = RESEND_FROM_EMAIL;

  // Hard assertion: Never dispatch with root domain orricaedge.com
  if (fromAddress.includes('@orricaedge.com') && !fromAddress.includes('@update.orricaedge.com')) {
    throw new Error(
      `[FATAL SENDER DOMAIN ERROR] Outbound email sender "${fromAddress}" is blocked. Cannot send from root orricaedge.com; must use update.orricaedge.com.`
    );
  }

  try {
    // Compile template through dynamic engine (admin override -> in-memory cache -> default fallback)
    const compiled = await compileEmailTemplate(templateKey, variables);

    let messageId: string | undefined;

    if (resend) {
      const response = await resend.emails.send({
        from: fromAddress,
        to: recipient,
        subject: compiled.subject,
        html: compiled.html,
        text: compiled.plainText,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }
      messageId = response.data?.id;
    } else {
      // Local development simulation
      messageId = `sim-${Date.now()}`;
      console.log(`[EMAIL DISPATCH] To: ${recipient} | From: ${fromAddress} | Key: ${templateKey} | Subject: ${compiled.subject}`);
    }

    // Persist email audit record (sanitized)
    try {
      await prisma.emailLog.create({
        data: {
          recipient,
          subject: compiled.subject,
          template: templateKey,
          status: 'SENT',
          messageId,
          payload: sanitizePayload(variables),
        },
      });
    } catch (logErr: any) {
      console.warn('[EMAIL AUDIT LOG WARNING]:', logErr?.message);
    }

    return { success: true, messageId };
  } catch (err: any) {
    console.error(`[EMAIL DISPATCH FAILED] To: ${recipient} | Error:`, err.message);

    try {
      await prisma.emailLog.create({
        data: {
          recipient,
          subject: `Failed: ${templateKey}`,
          template: templateKey,
          status: 'FAILED',
          error: err.message,
          payload: sanitizePayload(variables),
        },
      });
    } catch {
      // ignore secondary db error
    }

    throw err;
  }
};

/**
 * High-performance non-blocking email dispatcher.
 * Queues the dynamic template compilation & Resend send in the event loop.
 */
export const dispatchEmail = (
  templateKey: string,
  recipient: string,
  variables: Record<string, string>
): void => {
  setImmediate(() => {
    sendDynamicEmail({ templateKey, recipient, variables }).catch((err) => {
      console.error('[UNCAUGHT EMAIL QUEUE ERROR]:', err);
    });
  });
};

// -------------------------------------------------------------
// CONVENIENCE ASYNC DISPATCHERS (Used across ATS & controllers)
// -------------------------------------------------------------

export const sendApplicationReceivedEmailAsync = (
  candidateName: string,
  candidateEmail: string,
  jobTitle: string,
  jobCode: string = 'OE-2026',
  jobLocation: string = 'India',
  applicationId: string = 'APP-01'
) => {
  dispatchEmail('APPLICATION_RECEIVED', candidateEmail, {
    candidate_name: candidateName,
    candidate_email: candidateEmail,
    job_title: jobTitle,
    job_code: jobCode,
    job_location: jobLocation,
    application_id: applicationId,
  });
};

export const sendInterviewScheduledEmailAsync = (
  candidateName: string,
  candidateEmail: string,
  jobTitle: string,
  roundName: string,
  scheduledAt: Date,
  meetingLink: string = '',
  interviewerName: string = 'Hiring Manager',
  companyName: string = 'Orrica Edge Partner'
) => {
  const dateStr = scheduledAt.toLocaleDateString('en-IN', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const timeStr = scheduledAt.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  dispatchEmail('INTERVIEW_SCHEDULED', candidateEmail, {
    candidate_name: candidateName,
    candidate_email: candidateEmail,
    job_title: jobTitle,
    company_name: companyName,
    client_name: companyName,
    interview_round: roundName,
    interview_date: dateStr,
    interview_time: timeStr,
    interviewer_name: interviewerName,
    meeting_link: meetingLink,
  });
};
