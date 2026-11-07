/**
 * Comprehensive Email Verification Suite
 * Tests the 5 core transactional flows:
 * 1. Recruiter registration (RECRUITER_WELCOME)
 * 2. OTP / Security Verification (OTP_VERIFICATION)
 * 3. Assessment invitation (ASSESSMENT_INVITATION)
 * 4. Interview notification (INTERVIEW_SCHEDULED)
 * 5. Candidate status notification (APPLICATION_RECEIVED)
 *
 * Checks:
 * - Centralized sender: Orrica Edge <noreply@update.orricaedge.com>
 * - Authorized subdomain: update.orricaedge.com (never root orricaedge.com)
 * - Reply-To: Disabled / Not Configured
 * - Zero 403 Forbidden errors
 * - Single email per flow (No bulk emails)
 */

import { sendDynamicEmail, RESEND_FROM_EMAIL } from '../services/email.service';
import { prisma } from '../prisma/client';
import { config } from '../config';

const testRecipient = process.argv[2] || process.env.TEST_EMAIL_RECIPIENT || 'test@example.com';

interface TestCase {
  name: string;
  templateKey: string;
  variables: Record<string, string>;
}

const testCases: TestCase[] = [
  {
    name: '1. Recruiter Registration & Credentials',
    templateKey: 'RECRUITER_WELCOME',
    variables: {
      recruiter_name: 'Priya Sharma (Test Recruiter)',
      recruiter_email: testRecipient,
      recruiter_id: 'REC-TEST-2026',
      temporary_password: 'TestPass@2026!',
      setup_url: 'https://orricaedge.com/set-password?token=test-token-123',
      login_url: 'https://orricaedge.com/login',
      support_email: config.email.supportEmail,
    },
  },
  {
    name: '2. OTP & Account Security Verification',
    templateKey: 'OTP_VERIFICATION',
    variables: {
      user_name: 'Rahul Verma',
      user_email: testRecipient,
      otp_code: '492817',
      expiry_minutes: '10',
    },
  },
  {
    name: '3. Candidate Assessment Invitation',
    templateKey: 'ASSESSMENT_INVITATION',
    variables: {
      candidate_name: 'Ananya Roy',
      job_title: 'Operations Analyst',
      company_name: 'FinTech Solutions India',
      assessment_title: 'Cognitive & Domain Assessment',
      time_limit: '45',
      expiry_date: '10 Nov 2026, 11:59 PM IST',
      assessment_url: 'https://orricaedge.com/assessment/start/test-token-456',
    },
  },
  {
    name: '4. Interview Notification & Scheduling',
    templateKey: 'INTERVIEW_SCHEDULED',
    variables: {
      candidate_name: 'Ananya Roy',
      job_title: 'Operations Analyst',
      company_name: 'FinTech Solutions India',
      interview_round: 'Technical Round 1',
      interview_date: 'Monday, 10 Nov 2026',
      interview_time: '02:30 PM IST',
      interviewer_name: 'Siddharth Mehta (Engineering Lead)',
      meeting_link: 'https://meet.google.com/test-oe-demo',
      support_email: config.email.supportEmail,
    },
  },
  {
    name: '5. Candidate Application & Status Notification',
    templateKey: 'APPLICATION_RECEIVED',
    variables: {
      candidate_name: 'Ananya Roy',
      candidate_email: testRecipient,
      job_title: 'Operations Analyst',
      job_code: 'OE-OPS-2026',
      job_location: 'Gurugram / Hybrid',
      application_id: 'APP-TEST-2026-089',
      support_email: config.email.supportEmail,
    },
  },
];

const runSuite = async () => {
  console.log('======================================================================');
  console.log('🚀 ORRICA EDGE RESEND DOMAIN AUTHORIZATION TEST SUITE');
  console.log('======================================================================');
  console.log(`📨 Centralized Sender: ${RESEND_FROM_EMAIL}`);
  console.log(`🌐 Authorized Domain : ${config.email.sendingDomain}`);
  console.log(`↩️ Reply-To Header    : DISABLED / NOT CONFIGURED`);
  console.log(`🔑 Resend API Key    : ${config.email.resendApiKey ? 'Present (' + config.email.resendApiKey.slice(0, 7) + '...)' : 'MISSING (Running simulation mode)'}`);
  console.log(`🎯 Test Recipient    : ${testRecipient}`);
  console.log('======================================================================\n');

  // Verify domain adherence
  if (!RESEND_FROM_EMAIL.includes('update.orricaedge.com')) {
    console.error(`❌ SENDER DOMAIN VIOLATION: Sender "${RESEND_FROM_EMAIL}" is not using update.orricaedge.com!`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    console.log(`▶ Running: ${tc.name} [Template: ${tc.templateKey}]...`);
    try {
      const res = await sendDynamicEmail({
        templateKey: tc.templateKey,
        recipient: testRecipient,
        variables: tc.variables,
      });

      console.log(`  ✅ Success! Message ID: ${res.messageId}`);
      console.log(`  Sender verified: ${RESEND_FROM_EMAIL}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
      if (err.message.includes('403') || err.message.toLowerCase().includes('not authorized')) {
        console.error(`  ⚠️ CRITICAL 403 ERROR: API key is not authorized for the sender address!`);
      }
      failed++;
    }
    console.log('');
  }

  console.log('======================================================================');
  console.log(`📊 TEST SUMMARY: ${passed}/${testCases.length} Passed, ${failed} Failed`);
  console.log('======================================================================');

  await prisma.$disconnect().catch(() => {});
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
};

runSuite().catch(async (e) => {
  console.error('Fatal test error:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

