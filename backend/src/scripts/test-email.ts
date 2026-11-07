import { sendDynamicEmail, RESEND_FROM_EMAIL } from '../services/email.service';
import { prisma } from '../prisma/client';
import { config } from '../config';

const testRecipient = process.argv[2] || process.env.TEST_EMAIL_RECIPIENT || 'test@example.com';

console.log(`=======================================================`);
console.log(`🧪 Testing Email Delivery to: ${testRecipient}`);
console.log(`🔑 RESEND_API_KEY: ${process.env.RESEND_API_KEY ? 'Present (length ' + process.env.RESEND_API_KEY.length + ')' : 'MISSING (running in simulation mode)'}`);
console.log(`📨 SENDER (FROM): ${RESEND_FROM_EMAIL}`);
console.log(`↩️ REPLY-TO: DISABLED / NOT CONFIGURED`);
console.log(`🌐 FRONTEND_URL: ${process.env.FRONTEND_URL || 'Default (https://orricaedge.com)'}`);
console.log(`=======================================================`);

sendDynamicEmail({
  templateKey: 'EMPLOYEE_WELCOME',
  recipient: testRecipient,
  variables: {
    employee_name: 'Test Administrator',
    employee_email: testRecipient,
    role: 'Sub-Admin',
    temporary_password: 'TestPassword@2026!',
    login_url: `${(process.env.FRONTEND_URL || 'https://orricaedge.com').replace(/\/+$/, '')}/login`,
    support_email: config.email.supportEmail,
  },
})
  .then(async (res) => {
    console.log('✅ TEST EMAIL DISPATCH SUCCEEDED!');
    console.log('Message ID / Status:', res.messageId);
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('❌ TEST EMAIL DISPATCH FAILED:', err.message);
    await prisma.$disconnect();
    process.exit(1);
  });
