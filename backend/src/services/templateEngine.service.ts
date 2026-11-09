import { prisma } from '../prisma/client';
import { cache } from '../utils/cache';
import { config } from '../config';
import { wrapWithSkyBlueLayout } from './emailLayout.service';

export interface DefaultTemplateDefinition {
  templateKey: string;
  name: string;
  category: 'Candidate' | 'Recruiter' | 'Client' | 'System';
  subject: string;
  htmlBody: string;
  plainText: string;
  variables: string[];
}

export const DEFAULT_TEMPLATES: Record<string, DefaultTemplateDefinition> = {
  WALK_IN_INVITATION: {
    templateKey: 'WALK_IN_INVITATION',
    name: 'Walk-in Interview Invitation',
    category: 'Candidate',
    subject: 'Walk-in Interview Invitation – {{job_title}}{{#if company_name}} at {{company_name}}{{/if}}',
    htmlBody:
      '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Walk-in Interview Invitation</h2>' +
      '<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p>' +
      '<p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:#1E293B;">You have been invited to attend a walk-in interview session for the position of <strong>{{job_title}}</strong>{{#if company_name}} at <strong>{{company_name}}</strong>{{/if}}.</p>' +
      '<div style="background-color:#F8FAFC;border:1px solid #E0F2FE;padding:18px;border-radius:10px;margin:20px 0;font-size:13.5px;line-height:1.6;color:#1E293B;">' +
      '{{#if company_name}}<p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Company:</strong> {{company_name}}</p>{{/if}}' +
      '<p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Date:</strong> {{walk_in_date}}</p>' +
      '<p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Reporting Time:</strong> {{reporting_time}}</p>' +
      '<p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Venue:</strong> {{venue_name}}</p>' +
      '<p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Address:</strong> {{venue_address}}</p>' +
      '<p style="margin:4px 0;font-size:13.5px;"><strong style="color:#1E293B;">Google Maps:</strong> <a href="{{google_maps_link}}" target="_blank" style="color:#0284C7;font-size:13.5px;text-decoration:none;font-weight:600;">View Location on Maps</a></p>' +
      '</div>' +
      '<div style="background-color:#F0F9FF;border:1px solid #BAE6FD;border-left:4px solid #0EA5E9;padding:14px 16px;margin:18px 0;border-radius:6px;">' +
      '<p style="margin:0;font-weight:700;color:#0C4A6E;font-size:13px;">Instructions:</p>' +
      '<p style="margin:4px 0 0;font-size:13px;line-height:1.5;color:#0C4A6E;">{{instructions}}</p>' +
      '</div>' +
      '<p style="font-size:14px;margin:18px 0 12px;color:#1E293B;font-weight:500;">Please indicate your availability using the options below:</p>' +
      '<div style="margin:22px 0;">' +
      '<a href="{{confirm_url}}" style="background-color:#0284C7;color:#FFFFFF;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;margin-right:10px;font-size:13px;line-height:1.2;box-shadow:0 2px 4px rgba(2,132,199,0.25);">Confirm Attendance</a>' +
      '<a href="{{reschedule_url}}" style="background-color:#F0F9FF;color:#0284C7;border:1px solid #BAE6FD;padding:11px 20px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;margin-right:10px;font-size:13px;line-height:1.2;">Request Another Date</a>' +
      '<a href="{{not_interested_url}}" style="background-color:#F1F5F9;color:#64748B;border:1px solid #CBD5E1;padding:11px 20px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:13px;line-height:1.2;">Not Interested</a>' +
      '</div>' +
      '<p style="font-size:11.5px;color:#64748B;margin-top:18px;">If the buttons above do not open, please copy and paste this link: <a href="{{confirmation_url}}" style="color:#0284C7;word-break:break-all;font-size:11.5px;">{{confirmation_url}}</a></p>',
    plainText: 'Dear {{candidate_name}}, You have been invited to attend a walk-in interview session for {{job_title}}{{#if company_name}} at {{company_name}}{{/if}} on {{walk_in_date}} at {{reporting_time}}. Venue: {{venue_name}}, {{venue_address}}. Please indicate your availability: {{confirmation_url}}',
    variables: ['candidate_name', 'candidate_email', 'job_title', 'job_id', 'walk_in_date', 'walkin_date', 'reporting_time', 'walk_in_time', 'venue_name', 'venue_address', 'google_maps_link', 'instructions', 'candidate_instructions', 'confirmation_url', 'confirmation_link', 'confirm_url', 'reschedule_url', 'not_interested_url'],
  },
  WALK_IN_CONFIRMED_ACK: {
    templateKey: 'WALK_IN_CONFIRMED_ACK',
    name: 'Walk-in Attendance Confirmed Acknowledgement',
    category: 'Candidate',
    subject: 'Attendance Confirmed | Walk-in Interview – {{job_title}}',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Attendance Confirmed</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Your attendance has been successfully confirmed for the walk-in interview for <strong>{{job_title}}</strong>{{#if company_name}} at <strong>{{company_name}}</strong>{{/if}}.</p><div style="background-color:#F8FAFC;border:1px solid #E0F2FE;padding:18px;border-radius:8px;margin:20px 0;font-size:13.5px;line-height:1.6;color:#1E293B;"><p style="margin:0 0 8px;font-weight:700;color:#0C4A6E;">Interview Details</p>{{#if company_name}}<p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Company:</strong> {{company_name}}</p>{{/if}}<p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Date:</strong> {{walk_in_date}}</p><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Reporting Time:</strong> {{reporting_time}}</p><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Venue:</strong> {{venue_name}}</p><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Address:</strong> {{venue_address}}</p><p style="margin:4px 0;font-size:13.5px;"><strong style="color:#1E293B;">Google Maps:</strong> <a href="{{google_maps_link}}" target="_blank" style="color:#0284C7;font-size:13.5px;text-decoration:none;font-weight:600;">View Location on Maps</a></p></div><div style="background-color:#F0F9FF;border:1px solid #BAE6FD;border-left:4px solid #0EA5E9;padding:14px;margin:16px 0;border-radius:6px;"><p style="margin:0 0 6px;font-weight:700;color:#0C4A6E;font-size:13px;">Important Instructions:</p><ul style="margin:0;padding-left:18px;font-size:12.5px;color:#0C4A6E;line-height:1.6;"><li>Please arrive 15 minutes before your reporting time.</li><li>Carry two printed copies of your resume.</li><li>Carry your original government-issued photo ID.</li><li>Carry relevant academic certificates.</li><li>Mention &ldquo;Orrica Edge LLP&rdquo; at the top of your resume.</li><li>Follow the venue-specific registration instructions.</li></ul></div><div style="background-color:#FFFBEB;border:1px solid #FEF3C7;border-left:4px solid #F59E0B;padding:14px;margin:16px 0;border-radius:6px;"><p style="margin:0 0 4px;font-weight:700;color:#92400E;font-size:12.5px;">Candidate Declaration:</p><p style="margin:0;font-size:12px;line-height:1.5;color:#78350F;">Orrica Edge LLP does not charge candidates for recruitment or interview opportunities. Candidates should not pay recruitment or interview charges to Orrica Edge LLP.</p></div><p style="font-size:13.5px;line-height:1.6;color:#1E293B;margin:16px 0 6px;">Best of luck with your interview! The team looks forward to welcoming you.</p>',
    plainText: 'Dear {{candidate_name}},\n\nYour attendance has been successfully confirmed for the walk-in interview for {{job_title}}.\n\nInterview Details\nDate: {{walk_in_date}}\nReporting Time: {{reporting_time}}\nVenue: {{venue_name}}\nAddress: {{venue_address}}\nGoogle Maps: {{google_maps_link}}\n\nImportant Instructions:\n• Please arrive 15 minutes before your reporting time.\n• Carry two printed copies of your resume.\n• Carry your original government-issued photo ID.\n• Carry relevant academic certificates.\n• Mention “Orrica Edge LLP” at the top of your resume.\n• Follow the venue-specific registration instructions.\n\nCandidate Declaration:\nOrrica Edge LLP does not charge candidates for recruitment or interview opportunities. Candidates should not pay recruitment or interview charges to Orrica Edge LLP.\n\nBest of luck with your interview! The team looks forward to welcoming you at the office.\n\nRegards,\nTeam Orrica Edge LLP',
    variables: ['candidate_name', 'job_title', 'job_id', 'walk_in_date', 'reporting_time', 'venue_name', 'venue_address', 'google_maps_link', 'instructions'],
  },
  WALK_IN_RESCHEDULE_ACK: {
    templateKey: 'WALK_IN_RESCHEDULE_ACK',
    name: 'Walk-in Reschedule Request Acknowledgement',
    category: 'Candidate',
    subject: 'Reschedule Request Received: {{job_title}} Walk-in',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Reschedule Request Received</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">We have received your request to reschedule your walk-in interview for <strong>{{job_title}}</strong>.</p><div style="background-color:#F8FAFC;border:1px solid #E0F2FE;padding:18px;border-radius:8px;margin:20px 0;font-size:13.5px;line-height:1.6;color:#1E293B;"><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Preferred Date:</strong> {{preferred_date}}</p><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Your Comments:</strong> {{comments}}</p></div><p style="font-size:13.5px;line-height:1.6;color:#1E293B;">Our recruitment team is reviewing your requested date and will contact you shortly with an updated schedule.</p>',
    plainText: 'Dear {{candidate_name}}, We received your request to reschedule your walk-in interview for {{job_title}} to {{preferred_date}}. Our recruitment team will contact you shortly with an updated schedule.',
    variables: ['candidate_name', 'job_title', 'job_id', 'preferred_date', 'comments'],
  },
  WALK_IN_NOT_INTERESTED_ACK: {
    templateKey: 'WALK_IN_NOT_INTERESTED_ACK',
    name: 'Walk-in Not Interested Acknowledgement',
    category: 'Candidate',
    subject: 'Walk-in Interview Response: {{job_title}}',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Response Received</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Thank you for letting us know that you are not interested in attending the walk-in interview for <strong>{{job_title}}</strong>.</p><p style="font-size:13.5px;line-height:1.6;color:#1E293B;">We have updated your response for this session. Your profile remains active in our talent network for future opportunities matching your background.</p>',
    plainText: 'Dear {{candidate_name}}, Thank you for letting us know you are not interested in attending the walk-in interview for {{job_title}}. Your profile remains active in our talent network for future opportunities.',
    variables: ['candidate_name', 'job_title', 'job_id'],
  },
  WALK_IN_SCHEDULE_UPDATED: {
    templateKey: 'WALK_IN_SCHEDULE_UPDATED',
    name: 'Walk-in Schedule Changed & Reconfirmation Required',
    category: 'Candidate',
    subject: 'Schedule Changed — Reconfirmation Required: {{job_title}} Walk-in',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Walk-in Schedule Updated</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Please be advised that the scheduled walk-in interview details for <strong>{{job_title}}</strong> have been updated.</p><div style="background-color:#F8FAFC;border:1px solid #E0F2FE;padding:18px;border-radius:8px;margin:20px 0;font-size:13.5px;line-height:1.6;color:#1E293B;"><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Updated Date:</strong> {{walk_in_date}}</p><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Reporting Time:</strong> {{reporting_time}}</p><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Venue:</strong> {{venue_name}}</p><p style="margin:4px 0;font-size:13.5px;color:#1E293B;"><strong>Address:</strong> {{venue_address}}</p><p style="margin:4px 0;font-size:13.5px;"><strong style="color:#1E293B;">Google Maps:</strong> <a href="{{google_maps_link}}" target="_blank" style="color:#0284C7;font-size:13.5px;text-decoration:none;font-weight:600;">View Location</a></p></div><p style="font-size:13.5px;margin:18px 0 12px;color:#1E293B;font-weight:500;">Because details have changed, please reconfirm your availability below:</p><div style="margin:20px 0;"><a href="{{confirm_url}}" style="background-color:#0284C7;color:#FFFFFF;padding:11px 20px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;margin-right:10px;font-size:13px;line-height:1.2;">Confirm Updated Date</a><a href="{{reschedule_url}}" style="background-color:#F0F9FF;color:#0284C7;border:1px solid #BAE6FD;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;margin-right:10px;font-size:13px;line-height:1.2;">Request Another Date</a><a href="{{not_interested_url}}" style="background-color:#F1F5F9;color:#64748B;border:1px solid #CBD5E1;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:13px;line-height:1.2;">Not Interested</a></div>',
    plainText: 'Dear {{candidate_name}}, The walk-in interview schedule for {{job_title}} has been updated to {{walk_in_date}} at {{reporting_time}}. Please reconfirm your attendance: {{confirmation_url}}',
    variables: ['candidate_name', 'job_title', 'job_id', 'walk_in_date', 'reporting_time', 'venue_name', 'venue_address', 'google_maps_link', 'confirmation_url', 'confirm_url', 'reschedule_url', 'not_interested_url'],
  },
  WALK_IN_RESCHEDULE_APPROVED: {
    templateKey: 'WALK_IN_RESCHEDULE_APPROVED',
    name: 'Walk-in Reschedule Approved',
    category: 'Candidate',
    subject: 'Reschedule Approved: Walk-in Interview for {{job_title}} on {{walk_in_date}}',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Reschedule Request Approved</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Your request to reschedule the walk-in interview for <strong>{{job_title}}</strong> has been approved by the recruitment team.</p><div style="background-color:#F8FAFC;border:1px solid #E0F2FE;padding:18px;border-radius:8px;margin:20px 0;font-size:13.5px;line-height:1.6;color:#1E293B;"><p style="margin:4px 0;"><strong>Approved Date:</strong> {{walk_in_date}}</p><p style="margin:4px 0;"><strong>Reporting Time:</strong> {{reporting_time}}</p><p style="margin:4px 0;"><strong>Venue:</strong> {{venue_name}}</p><p style="margin:4px 0;"><strong>Address:</strong> {{venue_address}}</p></div><p style="font-size:13.5px;line-height:1.6;color:#1E293B;">We look forward to meeting you for your interview. Please arrive on time with your required documents.</p>',
    plainText: 'Dear {{candidate_name}}, Your reschedule request for {{job_title}} has been approved for {{walk_in_date}} at {{reporting_time}}. Venue: {{venue_name}}, {{venue_address}}.',
    variables: ['candidate_name', 'job_title', 'job_id', 'walk_in_date', 'reporting_time', 'venue_name', 'venue_address'],
  },

  APPLICATION_RECEIVED: {
    templateKey: 'APPLICATION_RECEIVED',
    name: 'Candidate Application Received',
    category: 'Candidate',
    subject: 'Application Received: {{job_title}} — Orrica Edge',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Application Received</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Thank you for applying for the position of <strong>{{job_title}}</strong> ({{job_code}}) based in <strong>{{job_location}}</strong>.</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Your resume and application details have been safely registered under Application ID: <strong>{{application_id}}</strong>. Our recruitment team will review your qualifications against our client\'s hiring benchmarks.</p><div style="background-color:#F0F9FF;border:1px solid #BAE6FD;border-left:4px solid #0EA5E9;padding:16px;margin:20px 0;border-radius:6px;"><p style="margin:0;font-weight:700;color:#0C4A6E;">What\'s next?</p><p style="margin:4px 0 0;font-size:13px;color:#0C4A6E;line-height:1.5;">If your profile matches the client\'s requirements, a recruiter will reach out for the initial screening or assessment round.</p></div><p style="font-size:13.5px;line-height:1.6;color:#1E293B;">We appreciate your interest in building your career through Orrica Edge.</p>',
    plainText: 'Dear {{candidate_name}}, Thank you for applying for {{job_title}} ({{job_code}}). Application ID: {{application_id}}. Our recruitment team is reviewing your profile.',
    variables: ['candidate_name', 'candidate_email', 'job_title', 'job_code', 'job_location', 'application_id', 'support_email'],
  },

  INTERVIEW_SCHEDULED: {
    templateKey: 'INTERVIEW_SCHEDULED',
    name: 'Interview Scheduled',
    category: 'Candidate',
    subject: 'Interview Scheduled: {{interview_round}} for {{job_title}}{{#if company_name}} at {{company_name}}{{/if}} — Orrica Edge',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Interview Invitation</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Congratulations! You have been shortlisted for an interview round for the <strong>{{job_title}}</strong> position.</p><div style="background-color:#F8FAFC;border:1px solid #E0F2FE;padding:18px;border-radius:8px;margin:20px 0;font-size:13.5px;line-height:1.6;color:#1E293B;"><p style="margin:4px 0;"><strong>Round:</strong> {{interview_round}}</p><p style="margin:4px 0;"><strong>Date:</strong> {{interview_date}}</p><p style="margin:4px 0;"><strong>Time:</strong> {{interview_time}}</p><p style="margin:4px 0;"><strong>Interviewer:</strong> {{interviewer_name}}</p>{{#if meeting_link}}<p style="margin:14px 0 4px;"><a href="{{meeting_link}}" style="background-color:#0284C7;color:#FFFFFF;padding:11px 22px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:13px;line-height:1.2;">Join Video Interview</a></p>{{/if}}</div><p style="font-size:13.5px;line-height:1.6;color:#1E293B;">Please make sure you are in a quiet room with good network connectivity and your camera enabled.</p><p style="font-size:13px;line-height:1.6;color:#64748B;">If you need to reschedule, please contact your recruiter at {{support_email}} at least 4 hours in advance.</p>',
    plainText: 'Dear {{candidate_name}}, Your interview for {{job_title}}{{#if company_name}} at {{company_name}}{{/if}} is scheduled on {{interview_date}} at {{interview_time}}. Meeting link: {{meeting_link}}.',
    variables: ['candidate_name', 'job_title', 'company_name', 'client_name', 'interview_round', 'interview_date', 'interview_time', 'interviewer_name', 'meeting_link', 'support_email'],
  },

  APPLICATION_SHORTLISTED: {
    templateKey: 'APPLICATION_SHORTLISTED',
    name: 'Application Shortlisted',
    category: 'Candidate',
    subject: 'Great News! Your profile is shortlisted for {{job_title}}',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Profile Shortlisted</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">We are delighted to share that your application for <strong>{{job_title}}</strong> has successfully passed the initial evaluation.</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Our team is coordinating with <strong>{{company_name}}</strong> to finalize the interview round. Your dedicated talent partner is <strong>{{recruiter_name}}</strong>.</p><p style="font-size:13.5px;line-height:1.6;color:#1E293B;">Keep your contact phone active for the interview briefing.</p>',
    plainText: 'Dear {{candidate_name}}, You have been shortlisted for {{job_title}}. Our recruiter {{recruiter_name}} will contact you shortly.',
    variables: ['candidate_name', 'job_title', 'company_name', 'recruiter_name', 'dashboard_url'],
  },

  APPLICATION_REJECTED: {
    templateKey: 'APPLICATION_REJECTED',
    name: 'Application Not Selected',
    category: 'Candidate',
    subject: 'Update regarding your application for {{job_title}}',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Application Status Update</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Thank you for taking the time to apply for <strong>{{job_title}}</strong> and participating in our evaluation process.</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">After careful review of all submissions against the current client requirements, we have decided to proceed with other candidates whose experience more closely matches the specific parameters of this role.</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Your resume remains active in our talent network, and our recruiters will reach out as soon as a relevant opportunity emerges that matches your skills.</p><p style="font-size:13.5px;line-height:1.6;color:#1E293B;">We wish you every success in your career journey.</p>',
    plainText: 'Dear {{candidate_name}}, Thank you for applying for {{job_title}}. We have decided to move forward with other candidates, but your profile remains in our talent network for future roles.',
    variables: ['candidate_name', 'job_title', 'support_email'],
  },

  CANDIDATE_WELCOME: {
    templateKey: 'CANDIDATE_WELCOME',
    name: 'Candidate Welcome & Onboarding',
    category: 'Candidate',
    subject: 'Welcome to Orrica Edge — Accelerate Your Career',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Welcome to Orrica Edge</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Welcome to the Orrica Edge Career Community! Your candidate account has been created successfully.</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 20px;color:#1E293B;">You can now browse verified job openings, track application statuses, take assessments, and prepare for interviews using our Career &amp; Industry Insights.</p><p style="margin:22px 0;"><a href="{{dashboard_url}}" style="background-color:#0284C7;color:#FFFFFF;padding:11px 22px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:13.5px;line-height:1.2;">Access Candidate Portal</a></p>',
    plainText: 'Welcome {{candidate_name}}! Your Orrica Edge account is active. Visit {{dashboard_url}}',
    variables: ['candidate_name', 'candidate_email', 'dashboard_url'],
  },

  RECRUITER_WELCOME: {
    templateKey: 'RECRUITER_WELCOME',
    name: 'Recruiter Account Welcome & Password Setup',
    category: 'Recruiter',
    subject: 'Welcome to Orrica Edge — Activate Your Recruiter Account ({{recruiter_id}})',
    htmlBody:
      '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Welcome to Orrica Edge</h2>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{recruiter_name}}</strong>,</p>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Your recruiter partner account has been approved and activated on the Orrica Edge Recruitment Platform.</p>' +
      '<div style="background-color:#F8FAFC;border:1px solid #E0F2FE;border-radius:8px;padding:18px;margin:20px 0;">' +
      '<h3 style="margin:0 0 12px;color:#0C4A6E;font-size:14.5px;font-weight:700;">Account Details</h3>' +
      '<table style="width:100%;border-collapse:collapse;">' +
      '<tr><td style="padding:6px 0;color:#64748B;width:150px;font-size:13.5px;"><strong>Recruiter ID:</strong></td><td style="padding:6px 0;font-family:monospace;font-size:13.5px;color:#0C4A6E;font-weight:600;">{{recruiter_id}}</td></tr>' +
      '<tr><td style="padding:6px 0;color:#64748B;font-size:13.5px;"><strong>Registered Email:</strong></td><td style="padding:6px 0;font-size:13.5px;color:#1E293B;font-weight:600;">{{recruiter_email}}</td></tr>' +
      '</table>' +
      '</div>' +
      '<p style="margin:20px 0 12px;font-size:13.5px;color:#1E293B;">To access your workspace, please set your secure account password using the link below:</p>' +
      '<p style="margin:24px 0;text-align:center;">' +
      '<a href="{{setup_url}}" style="background-color:#0284C7;color:#FFFFFF;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:14px;line-height:1.2;">Set Password &amp; Activate Account</a>' +
      '</p>' +
      '<div style="background-color:#F0F9FF;border:1px solid #BAE6FD;border-left:4px solid #0EA5E9;padding:14px 16px;margin:20px 0;border-radius:6px;">' +
      '<p style="margin:0;font-size:12.5px;color:#0C4A6E;line-height:1.5;">' +
      '<strong>Security Notice:</strong> For your protection, passwords are never transmitted via email. This secure activation link expires in 24 hours.' +
      '</p>' +
      '</div>' +
      '<p style="font-size:12.5px;color:#64748B;line-height:1.6;margin-top:18px;">' +
      'Direct Setup Link: <a href="{{setup_url}}" style="color:#0284C7;word-break:break-all;">{{setup_url}}</a><br>' +
      'After setting your password, you can sign in directly at: <a href="{{login_url}}" style="color:#0284C7;text-decoration:none;font-weight:600;">{{login_url}}</a>' +
      '</p>',
    plainText:
      'Welcome {{recruiter_name}}!\n\n' +
      'Your recruiter account on the Orrica Edge platform has been activated.\n\n' +
      'ACCOUNT DETAILS:\n' +
      '- Recruiter ID: {{recruiter_id}}\n' +
      '- Email: {{recruiter_email}}\n\n' +
      'For security reasons, passwords are never transmitted via email.\n' +
      'Click the secure link below to set your password and activate your account (valid for 24 hours):\n' +
      '{{setup_url}}\n\n' +
      'Login page: {{login_url}}\n\n' +
      'Regards,\nOrrica Edge Talent Solutions',
    variables: ['recruiter_id', 'recruiter_name', 'recruiter_email', 'setup_url', 'login_url', 'support_email'],
  },

  RECRUITER_APPROVED: {
    templateKey: 'RECRUITER_APPROVED',
    name: 'Recruiter Partner Approved',
    category: 'Recruiter',
    subject: 'Your Orrica Edge Recruiter Partner Account is Approved!',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Partner Account Activated</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{recruiter_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Congratulations! Your recruiter partnership application has been approved by the Orrica Edge management team.</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 20px;color:#1E293B;">You now have access to open mandates, candidate submission pipeline, automated ATS screening, and payout tracking.</p><p style="margin:22px 0;"><a href="{{dashboard_url}}" style="background-color:#0284C7;color:#FFFFFF;padding:11px 22px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:13.5px;line-height:1.2;">Open Recruiter Workspace</a></p>',
    plainText: 'Dear {{recruiter_name}}, your Orrica Edge recruiter partner account is approved. Access: {{dashboard_url}}',
    variables: ['recruiter_name', 'recruiter_email', 'dashboard_url'],
  },

  CLIENT_WELCOME: {
    templateKey: 'CLIENT_WELCOME',
    name: 'Corporate Client Onboarding',
    category: 'Client',
    subject: 'Welcome to Orrica Edge Talent Solutions — {{company_name}}',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Welcome to Enterprise Hiring</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{client_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Welcome to Orrica Edge! We are thrilled to partner with <strong>{{company_name}}</strong> for your strategic hiring and staffing requirements.</p><p style="font-size:13.5px;line-height:1.6;color:#1E293B;">Your dedicated account manager will connect with you to review active requisitions, job descriptions, and customized screening benchmarks.</p>',
    plainText: 'Welcome {{client_name}} from {{company_name}} to Orrica Edge Recruitment Solutions.',
    variables: ['client_name', 'company_name', 'support_email'],
  },

  EMPLOYEE_WELCOME: {
    templateKey: 'EMPLOYEE_WELCOME',
    name: 'Employee Account Welcome & Credentials',
    category: 'System',
    subject: 'Welcome to Orrica Edge — Your Employee Account Credentials',
    htmlBody:
      '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Welcome to the Orrica Edge Team</h2>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{employee_name}}</strong>,</p>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Your employee account (<strong>{{role}}</strong>) has been created on the Orrica Edge Platform.</p>' +
      '<div style="background-color:#F8FAFC;border:1px solid #E0F2FE;border-radius:8px;padding:18px;margin:20px 0;">' +
      '<h3 style="margin:0 0 12px;color:#0C4A6E;font-size:14.5px;font-weight:700;">Your Login Credentials</h3>' +
      '<table style="width:100%;border-collapse:collapse;">' +
      '<tr><td style="padding:6px 0;color:#64748B;width:150px;font-size:13.5px;"><strong>Role:</strong></td><td style="padding:6px 0;font-size:13.5px;color:#0C4A6E;font-weight:600;">{{role}}</td></tr>' +
      '<tr><td style="padding:6px 0;color:#64748B;font-size:13.5px;"><strong>Login Email:</strong></td><td style="padding:6px 0;font-size:13.5px;color:#1E293B;font-weight:600;">{{employee_email}}</td></tr>' +
      '<tr><td style="padding:6px 0;color:#64748B;font-size:13.5px;"><strong>Temporary Password:</strong></td><td style="padding:6px 0;"><code style="background-color:#F0F9FF;color:#0284C7;border:1px solid #BAE6FD;padding:4px 10px;border-radius:6px;font-size:14.5px;font-weight:700;letter-spacing:0.5px;display:inline-block;">{{temporary_password}}</code></td></tr>' +
      '</table>' +
      '</div>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:16px 0 12px;color:#1E293B;">You can sign in immediately using the link below. For security purposes, you will be required to set a new permanent password on your first login.</p>' +
      '<p style="margin:24px 0;text-align:center;">' +
      '<a href="{{login_url}}" style="background-color:#0284C7;color:#FFFFFF;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:14px;line-height:1.2;">Sign In to Orrica Edge</a>' +
      '</p>' +
      '<p style="font-size:12.5px;color:#64748B;line-height:1.6;">' +
      'Direct Login URL: <a href="{{login_url}}" style="color:#0284C7;text-decoration:none;font-weight:600;">{{login_url}}</a>' +
      '</p>',
    plainText:
      'Welcome {{employee_name}}!\n\n' +
      'Your employee account ({{role}}) has been created on the Orrica Edge Platform.\n\n' +
      'LOGIN CREDENTIALS:\n' +
      '- Role: {{role}}\n' +
      '- Login Email: {{employee_email}}\n' +
      '- Temporary Password: {{temporary_password}}\n\n' +
      'Sign in here: {{login_url}}\n\n' +
      'Note: You will be required to change your password upon your first login.\n\n' +
      'Regards,\nOrrica Edge Administration Team',
    variables: ['employee_name', 'employee_email', 'role', 'temporary_password', 'login_url', 'support_email'],
  },

  PASSWORD_RESET: {
    templateKey: 'PASSWORD_RESET',
    name: 'Password Reset Request',
    category: 'System',
    subject: 'Reset Your Orrica Edge Password',
    htmlBody: '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Password Reset Request</h2><p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Hello <strong>{{user_name}}</strong>,</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">We received a request to reset your password for your Orrica Edge account ({{user_email}}).</p><p style="font-size:13.5px;line-height:1.6;margin:0 0 20px;color:#1E293B;">Click the secure button below to set a new password. This link is valid for 60 minutes.</p><p style="margin:22px 0;"><a href="{{reset_url}}" style="background-color:#0284C7;color:#FFFFFF;padding:11px 22px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:13.5px;line-height:1.2;">Reset Password</a></p><p style="color:#64748B;font-size:12.5px;line-height:1.5;">If you did not request this, you can safely ignore this email.</p>',
    plainText: 'Reset password for {{user_email}}: {{reset_url}}',
    variables: ['user_name', 'user_email', 'reset_url'],
  },

  OTP_VERIFICATION: {
    templateKey: 'OTP_VERIFICATION',
    name: 'OTP & Account Verification',
    category: 'System',
    subject: 'Your Orrica Edge Verification Code: {{otp_code}}',
    htmlBody:
      '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Security Verification Code</h2>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Hello <strong>{{user_name}}</strong>,</p>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">Use the one-time verification code below to verify your account or complete your sign-in to Orrica Edge:</p>' +
      '<div style="background-color:#F0F9FF;border:1px solid #BAE6FD;border-radius:8px;padding:22px;margin:24px 0;text-align:center;">' +
      '<div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#0284C7;font-family:monospace;">{{otp_code}}</div>' +
      '<p style="margin:8px 0 0;font-size:12.5px;color:#64748B;">This verification code expires in {{expiry_minutes}} minutes.</p>' +
      '</div>' +
      '<p style="font-size:12.5px;color:#64748B;line-height:1.5;">' +
      'If you did not request this code, someone may have entered your email by mistake. You can safely ignore this message.' +
      '</p>',
    plainText: 'Your Orrica Edge verification code is: {{otp_code}}. It expires in {{expiry_minutes}} minutes. Do not share this code with anyone.',
    variables: ['user_name', 'user_email', 'otp_code', 'expiry_minutes'],
  },

  ASSESSMENT_INVITATION: {
    templateKey: 'ASSESSMENT_INVITATION',
    name: 'Candidate Assessment Invitation',
    category: 'Candidate',
    subject: 'Assessment Invitation: {{assessment_title}} for {{job_title}} — Orrica Edge',
    htmlBody:
      '<h2 style="font-size:18px;margin:0 0 16px;color:#0C4A6E;font-weight:700;">Skill Assessment Invitation</h2>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;color:#1E293B;">Dear <strong>{{candidate_name}}</strong>,</p>' +
      '<p style="font-size:13.5px;line-height:1.6;margin:0 0 16px;color:#1E293B;">You have been invited to complete an online skill assessment for the role of <strong>{{job_title}}</strong>{{#if company_name}} at <strong>{{company_name}}</strong>{{/if}}.</p>' +
      '<div style="background-color:#F8FAFC;border:1px solid #E0F2FE;border-radius:8px;padding:18px;margin:20px 0;">' +
      '<h3 style="margin:0 0 12px;color:#0C4A6E;font-size:14.5px;font-weight:700;">Assessment Overview</h3>' +
      '<table style="width:100%;border-collapse:collapse;">' +
      '<tr><td style="padding:6px 0;color:#64748B;width:150px;font-size:13.5px;"><strong>Assessment:</strong></td><td style="padding:6px 0;font-size:13.5px;color:#0C4A6E;font-weight:600;">{{assessment_title}}</td></tr>' +
      '<tr><td style="padding:6px 0;color:#64748B;font-size:13.5px;"><strong>Time Limit:</strong></td><td style="padding:6px 0;font-size:13.5px;color:#0C4A6E;font-weight:600;">{{time_limit}} minutes</td></tr>' +
      '<tr><td style="padding:6px 0;color:#64748B;font-size:13.5px;"><strong>Deadline:</strong></td><td style="padding:6px 0;font-size:13.5px;color:#0C4A6E;font-weight:600;">{{expiry_date}}</td></tr>' +
      '</table>' +
      '</div>' +
      '<p style="margin:24px 0;text-align:center;">' +
      '<a href="{{assessment_url}}" style="background-color:#0284C7;color:#FFFFFF;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:14px;line-height:1.2;">Start Online Assessment</a>' +
      '</p>' +
      '<div style="background-color:#F0F9FF;border:1px solid #BAE6FD;border-left:4px solid #0EA5E9;padding:14px 16px;margin:20px 0;border-radius:6px;">' +
      '<p style="margin:0 0 6px;font-weight:700;color:#0C4A6E;font-size:13px;">Guidelines before you begin:</p>' +
      '<ul style="margin:0;padding-left:18px;font-size:12.5px;color:#0C4A6E;line-height:1.6;">' +
      '<li>Ensure an uninterrupted, stable internet connection.</li>' +
      '<li>Take the assessment on a laptop or desktop computer for optimal experience.</li>' +
      '<li>The timer will start as soon as you begin the test.</li>' +
      '</ul>' +
      '</div>' +
      '<p style="font-size:12.5px;color:#64748B;line-height:1.6;">' +
      'Direct Link: <a href="{{assessment_url}}" style="color:#0284C7;word-break:break-all;">{{assessment_url}}</a>' +
      '</p>',
    plainText: 'Dear {{candidate_name}}, You have been invited to complete the {{assessment_title}} assessment for {{job_title}}. Duration: {{time_limit}} mins. Start here: {{assessment_url}}',
    variables: ['candidate_name', 'job_title', 'company_name', 'assessment_title', 'time_limit', 'expiry_date', 'assessment_url'],
  },
};

export const wrapHtmlEmail = (contentHtml: string, preheader?: string): string => {
  return wrapWithSkyBlueLayout({ contentHtml, preheader });
};

/**
 * Evaluates Handlebars-style conditional blocks {{#if var}}...{{else}}...{{/if}}
 * and {{#unless var}}...{{/unless}} safely.
 */
export const evaluateConditionalBlocks = (
  templateText: string,
  variables: Record<string, any>
): string => {
  if (!templateText) return '';

  let result = templateText;
  const ifRegex = /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;

  // Multi-pass resolution for nested conditionals (up to 10 passes)
  let passes = 0;
  while (ifRegex.test(result) && passes < 10) {
    passes++;
    result = result.replace(ifRegex, (_match, varName, ifBranch, elseBranch) => {
      const val = variables[varName];
      const isTruthy = Boolean(
        val !== undefined &&
        val !== null &&
        String(val).trim().length > 0 &&
        String(val).trim().toLowerCase() !== 'false' &&
        String(val).trim().toLowerCase() !== 'null' &&
        String(val).trim().toLowerCase() !== 'undefined'
      );
      return isTruthy ? (ifBranch || '') : (elseBranch || '');
    });
  }

  // Support {{#unless var}}...{{/unless}}
  const unlessRegex = /\{\{#unless\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/unless\}\}/g;
  let unlessPasses = 0;
  while (unlessRegex.test(result) && unlessPasses < 10) {
    unlessPasses++;
    result = result.replace(unlessRegex, (_match, varName, body) => {
      const val = variables[varName];
      const isFalsy =
        val === undefined ||
        val === null ||
        String(val).trim().length === 0 ||
        String(val).trim().toLowerCase() === 'false';
      return isFalsy ? (body || '') : '';
    });
  }

  return result;
};

/**
 * Strips any leftover unparsed template syntax to guarantee
 * that raw directives like {{#if ...}} or {{/if}} are never sent to recipients.
 */
export const stripRawTemplateSyntax = (text: string): string => {
  if (!text) return '';
  return text
    .replace(/\{\{#[^}]*\}\}/g, '')
    .replace(/\{\{\/[^}]*\}\}/g, '')
    .replace(/\{\{else\}\}/g, '')
    .replace(/\{\{\s*[\w.]+\s*\}\}/g, '');
};

/**
 * Validates that no unparsed template tags remain in the final rendered content.
 */
export const validateRenderedEmail = (rendered: string): { valid: boolean; leftoverTags: string[] } => {
  if (!rendered) return { valid: true, leftoverTags: [] };
  const leftovers = rendered.match(/\{\{[^}]+\}\}/g) || [];
  return {
    valid: leftovers.length === 0,
    leftoverTags: leftovers,
  };
};

export const interpolateVariables = (
  templateText: string,
  variables: Record<string, string>
): string => {
  if (!templateText) return '';

  // 1. Evaluate conditional {{#if}} blocks first
  let rendered = evaluateConditionalBlocks(templateText, variables);

  // 2. Interpolate standard variables {{var_name}}
  rendered = rendered.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, token) => {
    if (Object.prototype.hasOwnProperty.call(variables, token)) {
      const val = variables[token];
      return val !== undefined && val !== null ? String(val) : '';
    }
    return '';
  });

  // 3. Post-render cleanup: ensure no raw syntax or unresolved placeholders leak
  return stripRawTemplateSyntax(rendered);
};

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
  const rawCompanyName = (variables.company_name || variables.client_name || '').trim();
  const isGenericOrrica = ['orrica edge', 'orrica edge llp', 'orrica edge partner', 'orrica'].includes(rawCompanyName.toLowerCase());
  const companyName = isGenericOrrica ? '' : rawCompanyName;

  const rawRecruiterName = (variables.recruiter_name || variables.fullName || variables.name || '').trim();
  const safeRecruiterName = (rawRecruiterName && !rawRecruiterName.toLowerCase().includes('sample dashboard'))
    ? rawRecruiterName
    : 'Recruiter';

  const rawCandidateName = (variables.candidate_name || variables.fullName || variables.name || '').trim();
  const safeCandidateName = (rawCandidateName && !rawCandidateName.toLowerCase().includes('sample dashboard'))
    ? rawCandidateName
    : 'Candidate';

  const rawUserName = (variables.user_name || variables.fullName || variables.name || '').trim();
  const safeUserName = (rawUserName && !rawUserName.toLowerCase().includes('sample dashboard'))
    ? rawUserName
    : (safeRecruiterName !== 'Recruiter' ? safeRecruiterName : 'there');

  const enrichedVars: Record<string, string> = {
    support_email: config.email.supportEmail || 'info@orricaedge.com',
    dashboard_url: 'https://orricaedge.com',
    walkin_date: variables.walk_in_date || variables.walkin_date || '',
    walk_in_date: variables.walk_in_date || variables.walkin_date || '',
    reporting_time: variables.reporting_time || variables.walk_in_time || '',
    walk_in_time: variables.reporting_time || variables.walk_in_time || '',
    candidate_instructions: variables.instructions || variables.candidate_instructions || '',
    instructions: variables.instructions || variables.candidate_instructions || '',
    confirmation_link: variables.confirmation_url || variables.confirmation_link || '',
    confirmation_url: variables.confirmation_url || variables.confirmation_link || '',
    ...variables,
    company_name: companyName,
    client_name: companyName,
    recruiter_name: safeRecruiterName,
    candidate_name: safeCandidateName,
    user_name: safeUserName,
  };

  const cacheKey = `email_tpl:${templateKey}`;
  let template = cache.get<any>(cacheKey);

  if (!template) {
    try {
      template = await prisma.emailTemplate.findUnique({
        where: { templateKey },
      });

      if (template) {
        cache.set(cacheKey, template, 300);
      }
    } catch (err: any) {
      console.warn(`[TEMPLATE ENGINE] DB lookup failed for ${templateKey}:`, err.message);
    }
  }

  if (!template || !template.isActive) {
    const defaultTpl = DEFAULT_TEMPLATES[templateKey];
    if (defaultTpl) {
      template = defaultTpl;
    } else {
      template = {
        templateKey,
        subject: `Notification from Orrica Edge — ${templateKey}`,
        htmlBody: '<p>Hello {{candidate_name}},</p><p>You have a new update regarding your recruitment application.</p>',
        plainText: `Notification regarding ${templateKey}`,
      };
    }
  } else if (templateKey.startsWith('WALK_IN_') || (templateKey === 'RECRUITER_WELCOME' && template.htmlBody && template.htmlBody.includes('temporary_password'))) {
    const canonicalTpl = DEFAULT_TEMPLATES[templateKey];
    if (canonicalTpl) {
      template = {
        ...template,
        subject: canonicalTpl.subject,
        htmlBody: canonicalTpl.htmlBody,
        plainText: canonicalTpl.plainText,
        variables: canonicalTpl.variables,
      };
      cache.set(cacheKey, template, 300);
      prisma.emailTemplate
        .update({
          where: { templateKey },
          data: {
            subject: canonicalTpl.subject,
            htmlBody: canonicalTpl.htmlBody,
            plainText: canonicalTpl.plainText,
            variables: canonicalTpl.variables,
          },
        })
        .catch((err) => console.warn('[TEMPLATE ENGINE] Auto-heal sync error:', err.message));
    }
  }

  const interpolatedSubject = interpolateVariables(template.subject, enrichedVars);
  const interpolatedHtmlContent = interpolateVariables(template.htmlBody, enrichedVars);
  const interpolatedPlainText = interpolateVariables(template.plainText || '', enrichedVars);

  // Apply consistent SKY BLUE email layout wrapper
  const fullHtml = interpolatedHtmlContent.includes('<!DOCTYPE') || interpolatedHtmlContent.includes('<html')
    ? interpolatedHtmlContent
    : wrapWithSkyBlueLayout({
        contentHtml: interpolatedHtmlContent,
        preheader: interpolatedSubject,
      });

  return {
    subject: interpolatedSubject,
    html: fullHtml,
    plainText: interpolatedPlainText,
    templateKey,
  };
};
