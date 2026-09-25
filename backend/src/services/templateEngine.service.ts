import { prisma } from '../prisma/client';
import { cache } from '../utils/cache';

export interface DefaultTemplateDefinition {
  templateKey: string;
  name: string;
  category: 'Candidate' | 'Recruiter' | 'Client' | 'System';
  subject: string;
  htmlBody: string;
  plainText: string;
  variables: string[];
}

// -------------------------------------------------------------
// DEFAULT PRODUCTION TEMPLATES DICTIONARY
// (Fallback guarantee if database record is missing or reset)
// -------------------------------------------------------------

export const DEFAULT_TEMPLATES: Record<string, DefaultTemplateDefinition> = {
  APPLICATION_RECEIVED: {
    templateKey: 'APPLICATION_RECEIVED',
    name: 'Candidate Application Received',
    category: 'Candidate',
    subject: 'Application Received: {{job_title}} — Orrica Edge',
    htmlBody: `
      <h2>Application Received</h2>
      <p>Dear <strong>{{candidate_name}}</strong>,</p>
      <p>Thank you for applying for the position of <strong>{{job_title}}</strong> ({{job_code}}) based in <strong>{{job_location}}</strong>.</p>
      <p>Your resume and application details have been safely registered under Application ID: <strong>{{application_id}}</strong>. Our recruitment team will review your qualifications against our client's hiring benchmarks.</p>
      <div style="background-color: #f8fafc; border-left: 4px solid #f97316; padding: 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 0; font-weight: bold; color: #0f172a;">What's next?</p>
        <p style="margin: 4px 0 0 0; font-size: 14px; color: #64748b;">If your profile matches the client's requirements, a recruiter will reach out for the initial screening or assessment round.</p>
      </div>
      <p>We appreciate your interest in building your career through Orrica Edge.</p>
    `,
    plainText:
      'Dear {{candidate_name}}, Thank you for applying for {{job_title}} ({{job_code}}). Application ID: {{application_id}}. Our recruitment team is reviewing your profile.',
    variables: [
      'candidate_name',
      'candidate_email',
      'job_title',
      'job_code',
      'job_location',
      'application_id',
      'support_email',
    ],
  },

  INTERVIEW_SCHEDULED: {
    templateKey: 'INTERVIEW_SCHEDULED',
    name: 'Interview Scheduled',
    category: 'Candidate',
    subject: 'Interview Scheduled: {{interview_round}} for {{job_title}} — Orrica Edge',
    htmlBody: `
      <h2>Interview Invitation</h2>
      <p>Dear <strong>{{candidate_name}}</strong>,</p>
      <p>Congratulations! You have been shortlisted for an interview round for the <strong>{{job_title}}</strong> position.</p>
      <div style="background-color: #f1f5f9; border: 1px solid #e2e8f0; padding: 18px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 4px 0;"><strong>Round:</strong> {{interview_round}}</p>
        <p style="margin: 4px 0;"><strong>Date:</strong> {{interview_date}}</p>
        <p style="margin: 4px 0;"><strong>Time:</strong> {{interview_time}}</p>
        <p style="margin: 4px 0;"><strong>Interviewer:</strong> {{interviewer_name}}</p>
        {{#if meeting_link}}
        <p style="margin: 12px 0 4px 0;">
          <a href="{{meeting_link}}" style="background-color: #f97316; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Join Video Interview</a>
        </p>
        {{/if}}
      </div>
      <p>Please make sure you are in a quiet room with good network connectivity and your camera enabled.</p>
      <p>If you need to reschedule, please contact your recruiter at {{support_email}} at least 4 hours in advance.</p>
    `,
    plainText:
      'Dear {{candidate_name}}, Your interview for {{job_title}} is scheduled on {{interview_date}} at {{interview_time}}. Meeting link: {{meeting_link}}.',
    variables: [
      'candidate_name',
      'job_title',
      'interview_round',
      'interview_date',
      'interview_time',
      'interviewer_name',
      'meeting_link',
      'support_email',
    ],
  },

  APPLICATION_SHORTLISTED: {
    templateKey: 'APPLICATION_SHORTLISTED',
    name: 'Application Shortlisted',
    category: 'Candidate',
    subject: 'Great News! Your profile is shortlisted for {{job_title}}',
    htmlBody: `
      <h2>Profile Shortlisted</h2>
      <p>Dear <strong>{{candidate_name}}</strong>,</p>
      <p>We are delighted to share that your application for <strong>{{job_title}}</strong> has successfully passed the initial evaluation.</p>
      <p>Our team is coordinating with <strong>{{company_name}}</strong> to finalize the interview round. Your dedicated talent partner is <strong>{{recruiter_name}}</strong>.</p>
      <p>Keep your contact phone active for the interview briefing.</p>
    `,
    plainText:
      'Dear {{candidate_name}}, You have been shortlisted for {{job_title}}. Our recruiter {{recruiter_name}} will contact you shortly.',
    variables: ['candidate_name', 'job_title', 'company_name', 'recruiter_name', 'dashboard_url'],
  },

  APPLICATION_REJECTED: {
    templateKey: 'APPLICATION_REJECTED',
    name: 'Application Not Selected',
    category: 'Candidate',
    subject: 'Update regarding your application for {{job_title}}',
    htmlBody: `
      <h2>Application Status Update</h2>
      <p>Dear <strong>{{candidate_name}}</strong>,</p>
      <p>Thank you for taking the time to apply for <strong>{{job_title}}</strong> and participating in our evaluation process.</p>
      <p>After careful review of all submissions against the current client requirements, we have decided to proceed with other candidates whose experience more closely matches the specific parameters of this role.</p>
      <p>Your resume remains active in our talent network, and our recruiters will reach out as soon as a relevant opportunity emerges that matches your skills.</p>
      <p>We wish you every success in your career journey.</p>
    `,
    plainText:
      'Dear {{candidate_name}}, Thank you for applying for {{job_title}}. We have decided to move forward with other candidates, but your profile remains in our talent network for future roles.',
    variables: ['candidate_name', 'job_title', 'support_email'],
  },

  CANDIDATE_WELCOME: {
    templateKey: 'CANDIDATE_WELCOME',
    name: 'Candidate Welcome & Onboarding',
    category: 'Candidate',
    subject: 'Welcome to Orrica Edge — Accelerate Your Career',
    htmlBody: `
      <h2>Welcome to Orrica Edge</h2>
      <p>Dear <strong>{{candidate_name}}</strong>,</p>
      <p>Welcome to the Orrica Edge Career Community! Your candidate account has been created successfully.</p>
      <p>You can now browse verified job openings, track application statuses, take assessments, and prepare for interviews using our Career & Industry Insights.</p>
      <p><a href="{{dashboard_url}}" style="background-color: #f97316; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Access Candidate Portal</a></p>
    `,
    plainText: 'Welcome {{candidate_name}}! Your Orrica Edge account is active. Visit {{dashboard_url}}',
    variables: ['candidate_name', 'candidate_email', 'dashboard_url'],
  },

  RECRUITER_APPROVED: {
    templateKey: 'RECRUITER_APPROVED',
    name: 'Recruiter Partner Approved',
    category: 'Recruiter',
    subject: 'Your Orrica Edge Recruiter Partner Account is Approved!',
    htmlBody: `
      <h2>Partner Account Activated</h2>
      <p>Dear <strong>{{recruiter_name}}</strong>,</p>
      <p>Congratulations! Your recruiter partnership application has been approved by the Orrica Edge management team.</p>
      <p>You now have access to open mandates, candidate submission pipeline, automated ATS screening, and payout tracking.</p>
      <p><a href="{{dashboard_url}}" style="background-color: #f97316; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Open Recruiter Workspace</a></p>
    `,
    plainText: 'Dear {{recruiter_name}}, your Orrica Edge recruiter partner account is approved. Access: {{dashboard_url}}',
    variables: ['recruiter_name', 'recruiter_email', 'dashboard_url'],
  },

  CLIENT_WELCOME: {
    templateKey: 'CLIENT_WELCOME',
    name: 'Corporate Client Onboarding',
    category: 'Client',
    subject: 'Welcome to Orrica Edge Talent Solutions — {{company_name}}',
    htmlBody: `
      <h2>Welcome to Enterprise Hiring</h2>
      <p>Dear <strong>{{client_name}}</strong>,</p>
      <p>Welcome to Orrica Edge! We are thrilled to partner with <strong>{{company_name}}</strong> for your strategic hiring and staffing requirements.</p>
      <p>Your dedicated account manager will connect with you to review active requisitions, job descriptions, and customized screening benchmarks.</p>
    `,
    plainText: 'Welcome {{client_name}} from {{company_name}} to Orrica Edge Recruitment Solutions.',
    variables: ['client_name', 'company_name', 'support_email'],
  },

  PASSWORD_RESET: {
    templateKey: 'PASSWORD_RESET',
    name: 'Password Reset Request',
    category: 'System',
    subject: 'Reset Your Orrica Edge Password',
    htmlBody: `
      <h2>Password Reset Request</h2>
      <p>Hello <strong>{{user_name}}</strong>,</p>
      <p>We received a request to reset your password for your Orrica Edge account ({{user_email}}).</p>
      <p>Click the secure button below to set a new password. This link is valid for 60 minutes.</p>
      <p><a href="{{reset_url}}" style="background-color: #f97316; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Reset Password</a></p>
      <p style="color: #64748b; font-size: 13px;">If you did not request this, you can safely ignore this email.</p>
    `,
    plainText: 'Reset password for {{user_email}}: {{reset_url}}',
    variables: ['user_name', 'user_email', 'reset_url'],
  },
};

// -------------------------------------------------------------
// RESPONSIVE HTML WRAPPER (INLINE CSS FOR EMAIL CLIENTS)
// -------------------------------------------------------------

export const wrapHtmlEmail = (contentHtml: string): string => {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Orrica Edge</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f8fafc; padding: 30px 10px;">
    <tr>
      <td align="center">
        <!-- Main Email Container -->
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          
          <!-- Header -->
          <tr>
            <td style="background-color: #0b1220; padding: 24px 32px; border-bottom: 3px solid #f97316;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <span style="font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">ORRICA <span style="color: #f97316;">EDGE</span></span>
                    <span style="display: block; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-top: 2px;">Recruitment • Staffing • Talent Solutions</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding: 32px; color: #334155; font-size: 15px; line-height: 1.6;">
              ${contentHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center;">
              <p style="margin: 0 0 8px 0; font-weight: 600; color: #475569;">Orrica Edge Recruitment Solutions</p>
              <p style="margin: 0 0 8px 0;">This email was sent from an unmonitored mailbox (<a href="mailto:no-reply@orricaedge.com" style="color: #f97316; text-decoration: none;">no-reply@orricaedge.com</a>).</p>
              <p style="margin: 0;">© ${new Date().getFullYear()} Orrica Edge. All rights reserved. • <a href="https://orricaedge.com/privacy" style="color: #64748b; text-decoration: underline;">Privacy Policy</a> • <a href="https://orricaedge.com" style="color: #f97316; text-decoration: none;">orricaedge.com</a></p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};

// -------------------------------------------------------------
// DYNAMIC VARIABLE INTERPOLATION ENGINE
// -------------------------------------------------------------

export const interpolateVariables = (
  templateText: string,
  variables: Record<string, string>
): string => {
  if (!templateText) return '';

  return templateText.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(variables, token)) {
      return variables[token] ?? '';
    }
    // Return empty string or fallback token
    return '';
  });
};

// -------------------------------------------------------------
// COMPILE EMAIL TEMPLATE
// (DB Override -> In-Memory Cache -> DEFAULT_TEMPLATES Fallback)
// -------------------------------------------------------------

export interface CompiledEmail {
  subject: string;
  html: string;
  plainText: string;
  templateKey: string;
}

export const compileEmailTemplate = async (
  templateKey: string,
  variables: Record<string, string>
): Promise<CompiledEmail> => {
  // Inject common global variables if missing
  const enrichedVars: Record<string, string> = {
    company_name: 'Orrica Edge',
    support_email: 'no-reply@orricaedge.com',
    dashboard_url: 'https://orricaedge.com',
    ...variables,
  };

  const cacheKey = `email_tpl:${templateKey}`;
  let template = cache.get<any>(cacheKey);

  if (!template) {
    try {
      // 1. Check database for admin-created or edited template
      template = await prisma.emailTemplate.findUnique({
        where: { templateKey },
      });

      if (template) {
        cache.set(cacheKey, template, 300); // Cache for 5 mins
      }
    } catch (err: any) {
      console.warn(`[TEMPLATE ENGINE] DB lookup failed for ${templateKey}:`, err.message);
    }
  }

  // 2. Fallback to hardcoded DEFAULT_TEMPLATES if not in DB or marked inactive
  if (!template || !template.isActive) {
    const defaultTpl = DEFAULT_TEMPLATES[templateKey];
    if (defaultTpl) {
      template = defaultTpl;
    } else {
      // Emergency generic fallback
      template = {
        templateKey,
        subject: `Notification from Orrica Edge — ${templateKey}`,
        htmlBody: `<p>Hello {{candidate_name}},</p><p>You have a new update regarding your recruitment application.</p>`,
        plainText: `Notification regarding ${templateKey}`,
      };
    }
  }

  // 3. Interpolate Subject & Body
  const interpolatedSubject = interpolateVariables(template.subject, enrichedVars);
  const interpolatedHtmlContent = interpolateVariables(template.htmlBody, enrichedVars);
  const interpolatedPlainText = interpolateVariables(template.plainText || '', enrichedVars);

  // 4. Wrap with responsive Orrica Edge email styling
  const fullHtml = wrapHtmlEmail(interpolatedHtmlContent);

  return {
    subject: interpolatedSubject,
    html: fullHtml,
    plainText: interpolatedPlainText,
    templateKey,
  };
};
