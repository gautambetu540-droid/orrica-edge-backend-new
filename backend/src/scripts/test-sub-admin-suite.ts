import assert from 'node:assert';
import { maskPhone, maskEmail, maskCandidateForRole } from '../utils/masking';
import { ALLOWED_SUB_ADMIN_SECTIONS, ADMIN_ONLY_SECTIONS } from '../middlewares/auth.middleware';

console.log('--- Testing Sub-Admin Scoping, Masking, and Permissions ---');

// 1. Phone Masking: shows only the last 6 digits (••••543210)
const phone1 = '+91 9876543210';
const maskedPhone1 = maskPhone(phone1);
console.log('Phone masking output:', maskedPhone1);
assert(maskedPhone1.endsWith('543210'), 'Phone must end with last 6 digits');
assert(maskedPhone1.startsWith('••••'), 'Phone must start with 4 bullets');
assert.strictEqual(maskedPhone1, '••••543210');

const shortPhone = '12345';
assert.strictEqual(maskPhone(shortPhone), '••••12345');
assert.strictEqual(maskPhone(''), '');

// 2. Email Masking: shows first 2 characters + domain (ab•••••@gmail.com)
const email1 = 'gautam@example.com';
const maskedEmail1 = maskEmail(email1);
console.log('Email masking output:', maskedEmail1);
assert.strictEqual(maskedEmail1, 'ga•••••@example.com');

const singleCharEmail = 'a@test.com';
assert.strictEqual(maskEmail(singleCharEmail), 'a•••••@test.com');
assert.strictEqual(maskEmail(''), '');

// 3. Mask Candidate For Role
const candidate = {
  id: 'cand-1',
  fullName: 'John Doe',
  phone: '9876543210',
  email: 'johndoe@gmail.com',
  status: 'New',
};

const forAdmin = maskCandidateForRole(candidate, 'ADMIN');
assert.strictEqual(forAdmin.phone, '9876543210', 'Admin must see unmasked phone');
assert.strictEqual(forAdmin.email, 'johndoe@gmail.com', 'Admin must see unmasked email');

const forRecruiter = maskCandidateForRole(candidate, 'RECRUITER');
assert.strictEqual(forRecruiter.phone, '9876543210', 'Recruiter must see unmasked phone');
assert.strictEqual(forRecruiter.email, 'johndoe@gmail.com', 'Recruiter must see unmasked email');

const forSubAdmin = maskCandidateForRole(candidate, 'SUB_ADMIN');
assert.strictEqual(forSubAdmin.phone, '••••543210', 'Sub-admin must see masked phone');
assert.strictEqual(forSubAdmin.email, 'jo•••••@gmail.com', 'Sub-admin must see masked email');

// 4. Section permissions rules
assert.deepStrictEqual(
  ALLOWED_SUB_ADMIN_SECTIONS,
  ['candidates', 'recruiters', 'jobs', 'interviews', 'walkins', 'reports']
);

for (const adminOnly of ADMIN_ONLY_SECTIONS) {
  assert(!ALLOWED_SUB_ADMIN_SECTIONS.includes(adminOnly as any), `${adminOnly} must never be allowed for Sub-Admin`);
}

console.log('🎉 All Sub-Admin Unit Tests Passed Successfully!');

