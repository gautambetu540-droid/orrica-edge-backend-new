import { Resend } from 'resend';
import { prisma } from '../prisma/client';
import { compileEmailTemplate } from './templateEngine.service';

const resendApiKey = process.env.RESEND_API_KEY || '';
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const FROM_EMAIL = process.env.EMAIL_FROM || 'Orrica Edge <no-reply@orricaedge.com>';

export interface DispatchEmailPayload {
  templateKey: string;
  recipient: string;
  variables: Record<string, string>;
}

// Internal worker to compile dynamic template, send via Resend and record in EmailLog
const processEmailDispatch = async (payload: DispatchEmailPayload): Promise<void> => {
  const { templateKey, recipient, variables } = payload;

  try {
    // Compile template through dynamic engine (admin override -> in-memory cache -> default fallback)
    const compiled = await compileEmailTemplate(templateKey, variables);

    let messageId: string | undefined;

    if (resend) {
      const response = await resend.emails.send({
        from: FROM_EMAIL,
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
      console.log(`[EMAIL DISPATCH] To: ${recipient} | Key: ${templateKey} | Subject: ${compiled.subject}`);
    }

    // Persist email audit record
    await prisma.emailLog.create({
      data: {
        recipient,
        subject: compiled.subject,
        template: templateKey,
        status: 'SENT',
        messageId,
        payload: variables,
      },
    });
  } catch (err: any) {
    console.error(`[BACKGROUND EMAIL FAILED] To: ${recipient} | Error:`, err.message);

    try {
      await prisma.emailLog.create({
        data: {
          recipient,
          subject: `Failed: ${templateKey}`,
          template: templateKey,
          status: 'FAILED',
          error: err.message,
          payload: variables,
        },
      });
    } catch {
      // ignore secondary db error
    }
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
    processEmailDispatch({ templateKey, recipient, variables }).catch((err) => {
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
  interviewerName: string = 'Hiring Manager'
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
    interview_round: roundName,
    interview_date: dateStr,
    interview_time: timeStr,
    interviewer_name: interviewerName,
    meeting_link: meetingLink,
  });
};
