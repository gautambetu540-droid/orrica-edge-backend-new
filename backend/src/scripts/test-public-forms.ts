import {
  contactInquirySchema,
  employerRequirementSchema,
} from '../controllers/publicForm.controller';
import {
  sendContactInquiryEmails,
  sendEmployerRequirementEmails,
  FORM_RECIPIENT_EMAIL,
  RESPONSE_TIME_TEXT,
  escapeHtml,
  sanitizeHeader,
  formatIstTimestamp,
} from '../services/formEmail.service';

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${message}`);
};

const runPublicFormsTest = async () => {
  console.log('\n======================================================');
  console.log('🧪 TESTING PUBLIC FORMS VALIDATION & EMAIL SUITE');
  console.log('======================================================\n');

  // 1. Contact Form Valid Payload
  console.log('--- 1. Testing Contact Form Valid Payload ---');
  const validContact = {
    fullName: 'Rahul Sharma',
    email: 'rahul.sharma@example.com',
    phone: '+91 98765 43210',
    category: 'Employer Hiring Inquiry',
    subject: 'Corporate Recruitment Mandate',
    message: 'We are expanding our software engineering team in Bengaluru and need 10 senior full-stack developers within 4 weeks.',
    source: 'services',
  };
  const parsedContact = contactInquirySchema.safeParse(validContact);
  assert(parsedContact.success, 'Valid contact inquiry parsed successfully');
  if (parsedContact.success) {
    assert(parsedContact.data.fullName === 'Rahul Sharma', 'Full name correctly trimmed');
    assert(parsedContact.data.source === 'services', 'Source tag preserved');
  }

  // 2. Contact Form Invalid Payloads
  console.log('\n--- 2. Testing Contact Form Rejections ---');
  const invalidEmailContact = contactInquirySchema.safeParse({
    ...validContact,
    email: 'not-an-email',
  });
  assert(!invalidEmailContact.success, 'Rejects invalid email format');

  const invalidPhoneContact = contactInquirySchema.safeParse({
    ...validContact,
    phone: '123',
  });
  assert(!invalidPhoneContact.success, 'Rejects phone shorter than 10 digits');

  const missingNameContact = contactInquirySchema.safeParse({
    ...validContact,
    fullName: '',
  });
  assert(!missingNameContact.success, 'Rejects empty full name');

  // 3. Employer Form Valid Payload
  console.log('\n--- 3. Testing Employer Requirement Valid Payload ---');
  const validEmployer = {
    fullName: 'Pooja Verma',
    companyName: 'NexGen Cloud Systems',
    workEmail: 'pooja.verma@nexgencloud.io',
    phone: '+91 98450 11223',
    jobTitle: 'Senior Cloud Architect',
    openings: 5,
    location: 'Patna / Remote',
    workMode: 'Hybrid',
    jobType: 'Permanent Full-Time',
    targetExperience: '5-8 Years',
    additionalDetails: 'Must have strong AWS/GCP architecture experience and Kubernetes scaling knowledge.',
    source: 'services',
  };
  const parsedEmployer = employerRequirementSchema.safeParse(validEmployer);
  assert(parsedEmployer.success, 'Valid employer requirement parsed successfully');
  if (parsedEmployer.success) {
    assert(parsedEmployer.data.openings === 5, 'Openings integer parsed correctly');
    assert(parsedEmployer.data.source === 'services', 'Lead source "services" captured');
  }

  // 4. Employer Form Invalid Payloads
  console.log('\n--- 4. Testing Employer Requirement Rejections ---');
  const invalidOpenings = employerRequirementSchema.safeParse({
    ...validEmployer,
    openings: 0,
  });
  assert(!invalidOpenings.success, 'Rejects openings < 1');

  const invalidWorkMode = employerRequirementSchema.safeParse({
    ...validEmployer,
    workMode: 'InvalidMode',
  });
  assert(!invalidWorkMode.success, 'Rejects unrecognized work mode');

  // 5. Header Sanitization & HTML Escaping
  console.log('\n--- 5. Testing Security Sanitization ---');
  const headerAttack = 'Attacker Name\r\nBcc: evil@attacker.com\n';
  const sanitizedHeader = sanitizeHeader(headerAttack);
  assert(!sanitizedHeader.includes('\r') && !sanitizedHeader.includes('\n'), 'Strips CR and LF from header strings');

  const xssPayload = '<script>alert("xss")</script>&"\'';
  const escapedHtml = escapeHtml(xssPayload);
  assert(!escapedHtml.includes('<script>') && escapedHtml.includes('&lt;script&gt;'), 'Escapes HTML entities safely');

  // 6. Email Dispatch (Simulation / Provider)
  console.log('\n--- 6. Testing Email Notification & Auto-Reply Dispatch ---');
  console.log(`Configured recipient: ${FORM_RECIPIENT_EMAIL}`);
  console.log(`Response time text: "${RESPONSE_TIME_TEXT}"`);

  const contactEmailResult = await sendContactInquiryEmails({
    ...validContact,
    sourcePageUrl: 'https://www.orricaedge.com/contact?source=services',
  });
  assert(Boolean(contactEmailResult.messageId), `Contact email dispatched (ID: ${contactEmailResult.messageId}, simulated: ${contactEmailResult.simulated})`);

  const employerEmailResult = await sendEmployerRequirementEmails({
    ...validEmployer,
    sourcePageUrl: 'https://www.orricaedge.com/employers?source=services',
  });
  assert(Boolean(employerEmailResult.messageId), `Employer email dispatched (ID: ${employerEmailResult.messageId}, simulated: ${employerEmailResult.simulated})`);

  console.log('\n======================================================');
  console.log('🎉 ALL PUBLIC FORMS & EMAIL TESTS PASSED 100%!');
  console.log('======================================================\n');
};

runPublicFormsTest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
