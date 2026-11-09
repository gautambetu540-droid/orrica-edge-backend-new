import { Resend } from 'resend';
import { config } from '../config';

const resendApiKey = config.email.resendApiKey || process.env.RESEND_API_KEY || '';
const resend = resendApiKey ? new Resend(resendApiKey) : null;

export const FORM_RECIPIENT_EMAIL =
  config.email.formRecipientEmail || process.env.FORM_RECIPIENT_EMAIL || 'sudhanshu@orricaedge.com';

export const FORM_CC_EMAIL = config.email.formCcEmail || process.env.FORM_CC_EMAIL || undefined;

export const RESEND_FROM_EMAIL = config.email.from;
export const MAIL_FROM = RESEND_FROM_EMAIL;

if (RESEND_FROM_EMAIL.includes('@orricaedge.com') && !RESEND_FROM_EMAIL.includes('@update.orricaedge.com')) {
  throw new Error(
    `[FATAL SENDER DOMAIN ERROR] Form email sender "${RESEND_FROM_EMAIL}" is blocked. Cannot send from root orricaedge.com; must use update.orricaedge.com.`
  );
}

export const RESPONSE_TIME_TEXT =
  config.email.responseTimeText || process.env.RESPONSE_TIME_TEXT || 'within 4 business hours';

/**
 * Escape HTML special characters in visitor text before interpolating into HTML emails.
 */
export const escapeHtml = (str: string | number | null | undefined): string => {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

/**
 * Strip CR and LF characters to prevent email header injection attacks.
 */
export const sanitizeHeader = (str: string | null | undefined): string => {
  if (!str) return '';
  return String(str).replace(/[\r\n]+/g, ' ').trim();
};

/**
 * Format timestamp in Indian Standard Time (IST).
 */
export const formatIstTimestamp = (date: Date = new Date()): string => {
  try {
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'medium',
      hour12: true,
    }) + ' IST';
  } catch {
    return date.toISOString() + ' (UTC)';
  }
};

export interface ContactEmailData {
  fullName: string;
  email: string;
  phone: string;
  category: string;
  subject?: string;
  message: string;
  source?: string;
  sourcePageUrl?: string;
}

export interface EmployerEmailData {
  fullName: string;
  companyName: string;
  workEmail: string;
  phone: string;
  jobTitle: string;
  openings: number;
  location?: string;
  workMode?: string;
  jobType?: string;
  targetExperience?: string;
  additionalDetails?: string;
  source?: string;
  sourcePageUrl?: string;
}

/**
 * Send Contact Inquiry notification to Orrica Edge team + auto-reply to visitor.
 */
export const sendContactInquiryEmails = async (
  data: ContactEmailData
): Promise<{ messageId?: string; simulated: boolean }> => {
  const timestamp = formatIstTimestamp();
  const safeFullName = sanitizeHeader(data.fullName);
  const safeCategory = sanitizeHeader(data.category);
  const safeEmail = sanitizeHeader(data.email);
  const safeSubject = sanitizeHeader(data.subject);

  const teamSubject = `[Orrica Edge] New Inquiry - ${safeCategory} - ${safeFullName}`;

  const teamHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #F0F9FF; margin: 0; padding: 24px; color: #1E293B; }
    .card { max-width: 620px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E0F2FE; box-shadow: 0 4px 16px rgba(12,74,110,0.06); }
    .header { background: linear-gradient(135deg, #0284C7 0%, #0EA5E9 100%); padding: 28px 32px; color: #ffffff; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
    .header p { margin: 6px 0 0; font-size: 13px; opacity: 0.95; color: #E0F2FE; }
    .body { padding: 32px; }
    .table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 14px; }
    .table td { padding: 12px 14px; border-bottom: 1px solid #F0F9FF; vertical-align: top; }
    .label { font-weight: 600; color: #64748B; width: 34%; }
    .val { color: #1E293B; font-weight: 500; word-break: break-word; }
    .source-tag { display: inline-block; padding: 4px 10px; background: #F0F9FF; color: #0284C7; font-weight: 700; border-radius: 6px; font-size: 12px; border: 1px solid #BAE6FD; }
    .message-box { background: #F8FAFC; border: 1px solid #E0F2FE; border-radius: 12px; padding: 16px; margin-top: 8px; white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: #1E293B; }
    .footer { padding: 18px 32px; background: #F0F9FF; border-top: 1px solid #E0F2FE; font-size: 12px; color: #64748B; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>New Website Inquiry</h1>
      <p>Submitted on ${escapeHtml(timestamp)}</p>
    </div>
    <div class="body">
      <table class="table">
        <tr>
          <td class="label">Inquiry Category</td>
          <td class="val"><strong style="color: #2563eb;">${escapeHtml(data.category)}</strong></td>
        </tr>
        <tr>
          <td class="label">Full Name</td>
          <td class="val"><strong>${escapeHtml(data.fullName)}</strong></td>
        </tr>
        <tr>
          <td class="label">Email Address</td>
          <td class="val"><a href="mailto:${escapeHtml(data.email)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(data.email)}</a></td>
        </tr>
        <tr>
          <td class="label">Phone Number</td>
          <td class="val"><a href="tel:${escapeHtml(data.phone)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(data.phone)}</a></td>
        </tr>
        ${data.subject ? `<tr><td class="label">Subject</td><td class="val">${escapeHtml(data.subject)}</td></tr>` : ''}
        <tr>
          <td class="label">Lead Source</td>
          <td class="val"><span class="source-tag">${escapeHtml(data.source || 'direct')}</span></td>
        </tr>
        ${data.sourcePageUrl ? `<tr><td class="label">Source Page</td><td class="val"><a href="${escapeHtml(data.sourcePageUrl)}" style="color: #64748b; font-size: 12px;">${escapeHtml(data.sourcePageUrl)}</a></td></tr>` : ''}
      </table>

      <div style="font-weight: 600; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">Message Content</div>
      <div class="message-box">${escapeHtml(data.message)}</div>
    </div>
    <div class="footer">
      Orrica Edge LLP &bull; Automated Inquiry Notification System
    </div>
  </div>
</body>
</html>
`;

  const teamText = `
[ORRICA EDGE] NEW WEBSITE INQUIRY
----------------------------------------
Submitted: ${timestamp}
Category: ${data.category}
Name: ${data.fullName}
Email: ${data.email}
Phone: ${data.phone}
${data.subject ? `Subject: ${data.subject}\n` : ''}Source: ${data.source || 'direct'}
Source Page: ${data.sourcePageUrl || 'N/A'}

Message:
${data.message}
----------------------------------------
`;

  let messageId: string | undefined;
  let simulated = false;

  if (resend) {
    const response = await resend.emails.send({
      from: MAIL_FROM,
      to: [FORM_RECIPIENT_EMAIL],
      ...(FORM_CC_EMAIL ? { cc: [FORM_CC_EMAIL] } : {}),
      subject: teamSubject,
      html: teamHtml,
      text: teamText,
    });

    if (response.error) {
      throw new Error(`Resend provider error: ${response.error.message}`);
    }
    messageId = response.data?.id;
  } else {
    simulated = true;
    messageId = `sim-contact-${Date.now()}`;
    console.log(`[EMAIL SIMULATION - CONTACT INQUIRY] Dispatched to: ${FORM_RECIPIENT_EMAIL} | Subject: ${teamSubject}`);
  }

  // Auto-reply to visitor (non-blocking)
  sendVisitorContactAutoReply(data, safeFullName, safeEmail).catch((err) => {
    console.warn('[AUTO-REPLY WARNING] Failed to send contact auto-reply:', err?.message || err);
  });

  return { messageId, simulated };
};

/**
 * Send auto-reply to the visitor for contact form.
 */
const sendVisitorContactAutoReply = async (
  data: ContactEmailData,
  safeFullName: string,
  safeEmail: string
) => {
  if (!resend) return;

  const autoReplySubject = `Thank you for contacting Orrica Edge [Ref: Inquiry]`;
  const autoReplyHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #F0F9FF; margin: 0; padding: 24px; color: #1E293B; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E0F2FE; box-shadow: 0 4px 16px rgba(12,74,110,0.06); }
    .header { background: linear-gradient(135deg, #0284C7 0%, #0EA5E9 100%); padding: 24px 28px; color: #ffffff; }
    .header h2 { margin: 0; font-size: 19px; }
    .body { padding: 28px; line-height: 1.6; font-size: 14px; color: #1E293B; }
    .summary-box { background: #F8FAFC; border: 1px solid #E0F2FE; border-radius: 10px; padding: 14px 18px; margin: 18px 0; font-size: 13px; }
    .notice { background: #F0F9FF; border: 1px solid #BAE6FD; border-left: 4px solid #0EA5E9; padding: 12px 16px; margin: 18px 0; font-size: 13px; color: #0C4A6E; border-radius: 6px; }
    .footer { padding: 16px 28px; background: #F0F9FF; border-top: 1px solid #E0F2FE; font-size: 12px; color: #64748B; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h2>Orrica Edge &bull; Inquiry Received</h2>
    </div>
    <div class="body">
      <p>Hello <strong>${escapeHtml(safeFullName)}</strong>,</p>
      <p>Thank you for reaching out to Orrica Edge. We have successfully received your inquiry regarding <strong>${escapeHtml(data.category)}</strong>.</p>
      <p>Our team will review your message and connect with you <strong>${escapeHtml(RESPONSE_TIME_TEXT)}</strong>.</p>
      
      <div class="summary-box">
        <strong>Summary of Your Submission:</strong><br/>
        Category: ${escapeHtml(data.category)}<br/>
        Phone: ${escapeHtml(data.phone)}<br/>
        ${data.subject ? `Subject: ${escapeHtml(data.subject)}<br/>` : ''}
      </div>

      <div class="notice">
        <strong>Important Notice:</strong> Orrica Edge never charges candidates any application, registration, or placement fees. All recruitment services for job seekers are 100% free.
      </div>

      <p>Warm regards,<br/><strong>Orrica Edge Talent &amp; Advisory Team</strong><br/><a href="https://www.orricaedge.com" style="color: #0284C7; text-decoration: none;">www.orricaedge.com</a></p>
    </div>
    <div class="footer">
      &copy; 2026 Orrica Edge LLP. All rights reserved.
    </div>
  </div>
</body>
</html>
`;

  await resend.emails.send({
    from: MAIL_FROM,
    to: [safeEmail],
    subject: autoReplySubject,
    html: autoReplyHtml,
    text: `Hello ${safeFullName},\n\nThank you for reaching out to Orrica Edge. We have received your inquiry regarding ${data.category}.\n\nOur team will review your message and get back to you ${RESPONSE_TIME_TEXT}.\n\nImportant: Orrica Edge never charges candidates any application or placement fees.\n\nWarm regards,\nOrrica Edge Team\nhttps://www.orricaedge.com`,
  });
};

/**
 * Send Employer Requirement notification to Orrica Edge team + auto-reply to employer.
 */
export const sendEmployerRequirementEmails = async (
  data: EmployerEmailData
): Promise<{ messageId?: string; simulated: boolean }> => {
  const timestamp = formatIstTimestamp();
  const safeFullName = sanitizeHeader(data.fullName);
  const safeCompanyName = sanitizeHeader(data.companyName);
  const safeWorkEmail = sanitizeHeader(data.workEmail);
  const safeJobTitle = sanitizeHeader(data.jobTitle);

  const teamSubject = `[Orrica Edge] New Hiring Requirement - ${safeCompanyName} - ${safeJobTitle}`;

  const teamHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #F0F9FF; margin: 0; padding: 24px; color: #1E293B; }
    .card { max-width: 620px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E0F2FE; box-shadow: 0 4px 16px rgba(12,74,110,0.06); }
    .header { background: linear-gradient(135deg, #0284C7 0%, #0EA5E9 100%); padding: 28px 32px; color: #ffffff; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
    .header p { margin: 6px 0 0; font-size: 13px; opacity: 0.95; color: #E0F2FE; }
    .body { padding: 32px; }
    .table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 14px; }
    .table td { padding: 12px 14px; border-bottom: 1px solid #F0F9FF; vertical-align: top; }
    .label { font-weight: 600; color: #64748B; width: 34%; }
    .val { color: #1E293B; font-weight: 500; word-break: break-word; }
    .source-tag { display: inline-block; padding: 4px 10px; background: #F0F9FF; color: #0284C7; font-weight: 700; border-radius: 6px; font-size: 12px; border: 1px solid #BAE6FD; }
    .message-box { background: #F8FAFC; border: 1px solid #E0F2FE; border-radius: 12px; padding: 16px; margin-top: 8px; white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: #1E293B; }
    .footer { padding: 18px 32px; background: #F0F9FF; border-top: 1px solid #E0F2FE; font-size: 12px; color: #64748B; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>New Hiring Mandate Requirement</h1>
      <p>Submitted on ${escapeHtml(timestamp)}</p>
    </div>
    <div class="body">
      <table class="table">
        <tr>
          <td class="label">Company Name</td>
          <td class="val"><strong style="color: #2563eb; font-size: 15px;">${escapeHtml(data.companyName)}</strong></td>
        </tr>
        <tr>
          <td class="label">Job Title / Role</td>
          <td class="val"><strong>${escapeHtml(data.jobTitle)}</strong></td>
        </tr>
        <tr>
          <td class="label">Target Openings</td>
          <td class="val"><strong style="color: #0f172a;">${escapeHtml(data.openings)} positions</strong></td>
        </tr>
        <tr>
          <td class="label">Contact Person</td>
          <td class="val">${escapeHtml(data.fullName)}</td>
        </tr>
        <tr>
          <td class="label">Work Email</td>
          <td class="val"><a href="mailto:${escapeHtml(data.workEmail)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(data.workEmail)}</a></td>
        </tr>
        <tr>
          <td class="label">Phone Number</td>
          <td class="val"><a href="tel:${escapeHtml(data.phone)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(data.phone)}</a></td>
        </tr>
        ${data.location ? `<tr><td class="label">Location</td><td class="val">${escapeHtml(data.location)}</td></tr>` : ''}
        ${data.workMode ? `<tr><td class="label">Work Mode</td><td class="val">${escapeHtml(data.workMode)}</td></tr>` : ''}
        ${data.jobType ? `<tr><td class="label">Engagement Type</td><td class="val">${escapeHtml(data.jobType)}</td></tr>` : ''}
        ${data.targetExperience ? `<tr><td class="label">Experience Level</td><td class="val">${escapeHtml(data.targetExperience)}</td></tr>` : ''}
        <tr>
          <td class="label">Lead Source</td>
          <td class="val"><span class="source-tag">${escapeHtml(data.source || 'direct')}</span></td>
        </tr>
        ${data.sourcePageUrl ? `<tr><td class="label">Source Page</td><td class="val"><a href="${escapeHtml(data.sourcePageUrl)}" style="color: #64748b; font-size: 12px;">${escapeHtml(data.sourcePageUrl)}</a></td></tr>` : ''}
      </table>

      ${data.additionalDetails ? `
        <div style="font-weight: 600; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">Additional Mandate Details</div>
        <div class="message-box">${escapeHtml(data.additionalDetails)}</div>
      ` : ''}
    </div>
    <div class="footer">
      Orrica Edge LLP &bull; Enterprise Talent Acquisition Mandate Notification
    </div>
  </div>
</body>
</html>
`;

  const teamText = `
[ORRICA EDGE] NEW HIRING MANDATE REQUIREMENT
----------------------------------------
Submitted: ${timestamp}
Company: ${data.companyName}
Role: ${data.jobTitle}
Openings: ${data.openings}
Contact Person: ${data.fullName}
Work Email: ${data.workEmail}
Phone: ${data.phone}
Location: ${data.location || 'N/A'}
Work Mode: ${data.workMode || 'N/A'}
Job Type: ${data.jobType || 'N/A'}
Target Experience: ${data.targetExperience || 'N/A'}
Source: ${data.source || 'direct'}
Source Page: ${data.sourcePageUrl || 'N/A'}

Additional Details:
${data.additionalDetails || 'N/A'}
----------------------------------------
`;

  let messageId: string | undefined;
  let simulated = false;

  if (resend) {
    const response = await resend.emails.send({
      from: MAIL_FROM,
      to: [FORM_RECIPIENT_EMAIL],
      ...(FORM_CC_EMAIL ? { cc: [FORM_CC_EMAIL] } : {}),
      subject: teamSubject,
      html: teamHtml,
      text: teamText,
    });

    if (response.error) {
      throw new Error(`Resend provider error: ${response.error.message}`);
    }
    messageId = response.data?.id;
  } else {
    simulated = true;
    messageId = `sim-employer-${Date.now()}`;
    console.log(`[EMAIL SIMULATION - EMPLOYER REQUIREMENT] Dispatched to: ${FORM_RECIPIENT_EMAIL} | Subject: ${teamSubject}`);
  }

  // Auto-reply to employer (non-blocking)
  sendVisitorEmployerAutoReply(data, safeFullName, safeWorkEmail).catch((err) => {
    console.warn('[AUTO-REPLY WARNING] Failed to send employer auto-reply:', err?.message || err);
  });

  return { messageId, simulated };
};

/**
 * Send auto-reply to the employer contact person.
 */
const sendVisitorEmployerAutoReply = async (
  data: EmployerEmailData,
  safeFullName: string,
  safeWorkEmail: string
) => {
  if (!resend) return;

  const autoReplySubject = `Hiring Requirement Received - Orrica Edge Enterprise Talent Desk`;
  const autoReplyHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #F0F9FF; margin: 0; padding: 24px; color: #1E293B; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E0F2FE; box-shadow: 0 4px 16px rgba(12,74,110,0.06); }
    .header { background: linear-gradient(135deg, #0284C7 0%, #0EA5E9 100%); padding: 24px 28px; color: #ffffff; }
    .header h2 { margin: 0; font-size: 19px; }
    .body { padding: 28px; line-height: 1.6; font-size: 14px; color: #1E293B; }
    .summary-box { background: #F8FAFC; border: 1px solid #E0F2FE; border-radius: 10px; padding: 14px 18px; margin: 18px 0; font-size: 13px; }
    .notice { background: #F0F9FF; border: 1px solid #BAE6FD; border-left: 4px solid #0EA5E9; padding: 12px 16px; margin: 18px 0; font-size: 13px; color: #0C4A6E; border-radius: 6px; }
    .footer { padding: 16px 28px; background: #F0F9FF; border-top: 1px solid #E0F2FE; font-size: 12px; color: #64748B; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h2>Orrica Edge &bull; Mandate Received</h2>
    </div>
    <div class="body">
      <p>Dear <strong>${escapeHtml(safeFullName)}</strong>,</p>
      <p>Thank you for submitting your hiring requirement for <strong>${escapeHtml(data.companyName)}</strong>. We have received your mandate details for the <strong>${escapeHtml(data.jobTitle)}</strong> role.</p>
      <p>An Orrica Edge Enterprise Practice Lead will review your specifications and contact you <strong>${escapeHtml(RESPONSE_TIME_TEXT)}</strong> to calibrate the mandate and share candidate pipeline timelines.</p>
      
      <div class="summary-box">
        <strong>Mandate Overview:</strong><br/>
        Company: ${escapeHtml(data.companyName)}<br/>
        Role: ${escapeHtml(data.jobTitle)}<br/>
        Target Openings: ${escapeHtml(data.openings)}<br/>
        ${data.location ? `Location: ${escapeHtml(data.location)}<br/>` : ''}
        ${data.workMode ? `Work Mode: ${escapeHtml(data.workMode)}<br/>` : ''}
      </div>

      <div class="notice">
        <strong>Integrity &amp; Candidate Policy:</strong> Orrica Edge strictly adheres to ethical recruitment standards. We never charge candidates any application or placement fees.
      </div>

      <p>Warm regards,<br/><strong>Orrica Edge Enterprise Talent Desk</strong><br/><a href="https://www.orricaedge.com" style="color: #0284C7; text-decoration: none;">www.orricaedge.com</a></p>
    </div>
    <div class="footer">
      &copy; 2026 Orrica Edge LLP. All rights reserved.
    </div>
  </div>
</body>
</html>
`;

  await resend.emails.send({
    from: MAIL_FROM,
    to: [safeWorkEmail],
    subject: autoReplySubject,
    html: autoReplyHtml,
    text: `Dear ${safeFullName},\n\nThank you for submitting your hiring requirement for ${data.companyName} (${data.jobTitle}).\n\nAn Orrica Edge Practice Lead will contact you ${RESPONSE_TIME_TEXT} to discuss the candidate pipeline.\n\nImportant: Orrica Edge never charges candidates any application or placement fees.\n\nWarm regards,\nOrrica Edge Enterprise Talent Desk\nhttps://www.orricaedge.com`,
  });
};
