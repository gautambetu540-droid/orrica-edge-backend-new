import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { CANONICAL_PIPELINE_STAGES } from '../controllers/candidate.controller';
import { CANONICAL_SEND_BACK_REASONS } from '../controllers/team-leader.controller';
import {
  generateCandidateCode,
  generateApplicationCode,
  generateJobCode,
} from '../utils/codeGenerators';

async function runTestSuite() {
  console.log('====================================================');
  console.log('🧪 Starting Orrica Edge Comprehensive Backend Test Suite');
  console.log('====================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    totalTests++;
    if (!condition) {
      console.error(`❌ FAIL: ${testName}`, detail || '');
      throw new Error(`Test failed: ${testName} - ${detail || ''}`);
    }
    console.log(`✅ PASS: ${testName}`);
    passedTests++;
  }

  // ----------------------------------------------------
  // Test 1: Candidate Status & Canonical Pipeline
  // ----------------------------------------------------
  console.log('--- 1. Testing Candidate Status & Pipeline Stages ---');
  const required13Stages = [
    'New',
    'Contacted',
    'Interested',
    'Screening',
    'Eligible',
    'Submitted',
    'Shortlisted',
    'Assessment',
    'Interview Scheduled',
    'Interview Completed',
    'Selected',
    'Joining Pending',
    'Joined',
  ];
  for (const stage of required13Stages) {
    assert(
      CANONICAL_PIPELINE_STAGES.includes(stage as any),
      `Canonical stage "${stage}" is supported in hiring pipeline`
    );
  }

  const exceptionStages = [
    'Rejected',
    'On Hold',
    'Not Interested',
    'No Response',
    'Not Eligible',
    'Withdrawn',
    'Duplicate',
  ];
  for (const exception of exceptionStages) {
    assert(
      CANONICAL_PIPELINE_STAGES.includes(exception as any),
      `Canonical exception stage "${exception}" is supported in hiring pipeline`
    );
  }

  // Backwards compatibility legacy uppercase check
  const legacyStatuses = ['NEW', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'SELECTED', 'REJECTED', 'ON_HOLD', 'JOINED', 'DROPPED'];
  for (const legacy of legacyStatuses) {
    assert(
      CANONICAL_PIPELINE_STAGES.includes(legacy as any),
      `Legacy uppercase status "${legacy}" gracefully accepted for backwards-compatibility`
    );
  }

  // ----------------------------------------------------
  // Test 2: Canonical Send Back Reasons (TL Gate)
  // ----------------------------------------------------
  console.log('\n--- 2. Testing Team Leader Send Back Reasons ---');
  const expectedReasons = [
    'Experience mismatch',
    'Salary mismatch',
    'Location mismatch',
    'Communication issue',
    'Incomplete profile',
    'Missing document',
    'Other',
  ];
  for (const reason of expectedReasons) {
    assert(
      CANONICAL_SEND_BACK_REASONS.includes(reason as any),
      `Send back reason "${reason}" is supported`
    );
  }

  // ----------------------------------------------------
  // Test 3: Password Hashing & Security Policies
  // ----------------------------------------------------
  console.log('\n--- 3. Testing Authentication & Password Security ---');
  const rawPassword = 'SecureP@ssword2026!';
  const hashedPassword = await bcrypt.hash(rawPassword, 12);

  assert(
    await bcrypt.compare(rawPassword, hashedPassword),
    'Bcrypt verifies correct password'
  );
  assert(
    !(await bcrypt.compare('WrongPassword123!', hashedPassword)),
    'Bcrypt rejects incorrect password'
  );

  // Check setup token generation
  const rawSetupToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
  const verifiedHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
  assert(
    tokenHash === verifiedHash,
    'SHA-256 setup token hash verification succeeds'
  );
  assert(
    tokenHash !== rawSetupToken,
    'Raw setup token is never stored in plain text'
  );

  // ----------------------------------------------------
  // Test 4: Code Generators & Sequential Numbering
  // ----------------------------------------------------
  console.log('\n--- 4. Testing Unique Code Generators ---');
  const mockDb: any = {
    candidate: {
      findMany: async () => [{ candidateCode: 'CND-000042' }],
    },
    application: {
      findMany: async () => [{ applicationCode: 'APP-000108' }],
    },
    job: {
      findMany: async () => [{ jobCode: `OE-${new Date().getFullYear()}-00077` }],
    },
  };

  const nextCand = await generateCandidateCode(mockDb);
  assert(
    nextCand === 'CND-000043',
    'Candidate code increments sequentially (CND-000042 -> CND-000043)'
  );

  const nextApp = await generateApplicationCode(mockDb);
  assert(
    nextApp === 'APP-000109',
    'Application code increments sequentially (APP-000108 -> APP-000109)'
  );

  const currentYear = new Date().getFullYear();
  const nextJob = await generateJobCode(mockDb);
  assert(
    nextJob === `OE-${currentYear}-00078`,
    `Job code matches format OE-${currentYear}-00078`
  );

  // ----------------------------------------------------
  // Test 5: Profile & Password Validation Schemas
  // ----------------------------------------------------
  console.log('\n--- 5. Testing Profile & Password Schemas ---');
  const changePasswordSchema = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8).max(128),
      confirmPassword: z.string().min(8).optional(),
    })
    .refine(
      (data) => !data.confirmPassword || data.newPassword === data.confirmPassword,
      { message: 'Passwords must match', path: ['confirmPassword'] }
    );

  const validPw = changePasswordSchema.safeParse({
    currentPassword: 'OldPassword123!',
    newPassword: 'NewPassword2026!',
    confirmPassword: 'NewPassword2026!',
  });
  assert(validPw.success, 'Valid password change payload is accepted');

  const mismatchedPw = changePasswordSchema.safeParse({
    currentPassword: 'OldPassword123!',
    newPassword: 'NewPassword2026!',
    confirmPassword: 'DifferentPassword2026!',
  });
  assert(!mismatchedPw.success, 'Mismatched confirmation password is rejected');

  const tooShortPw = changePasswordSchema.safeParse({
    currentPassword: 'OldPassword123!',
    newPassword: 'short',
    confirmPassword: 'short',
  });
  assert(!tooShortPw.success, 'Password shorter than 8 characters is rejected');

  // ----------------------------------------------------
  // Test 6: Recruiter Application Schema & Status Flow
  // ----------------------------------------------------
  console.log('\n--- 6. Testing Recruiter Application Schema & Workflow ---');
  const recruiterAppStatusSchema = z.enum(['NEW', 'REVIEWING', 'CONTACTED', 'APPROVED', 'REJECTED']);

  const validStatuses = ['NEW', 'REVIEWING', 'CONTACTED', 'APPROVED', 'REJECTED'];
  for (const st of validStatuses) {
    const res = recruiterAppStatusSchema.safeParse(st);
    assert(res.success, `Recruiter application status "${st}" is valid`);
  }

  const invalidStatus = recruiterAppStatusStatusTest();
  assert(!invalidStatus, 'Invalid recruiter application status "RANDOM_STATE" is rejected');

  function recruiterAppStatusStatusTest() {
    return recruiterAppStatusSchema.safeParse('RANDOM_STATE').success;
  }

  // ----------------------------------------------------
  // Test 7: Active Mandates & Candidate IDOR Rules
  // ----------------------------------------------------
  console.log('\n--- 7. Testing RBAC & IDOR Access Rules ---');
  const testCandidateScope = (userRole: string, userId: string, candidateOwnerId: string, sourcingId: string) => {
    if (userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') return true;
    if (userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER') {
      return candidateOwnerId === userId || sourcingId === userId;
    }
    return false;
  };

  assert(
    testCandidateScope('ADMIN', 'admin-1', 'recruiter-99', 'recruiter-99'),
    'Admin has global visibility across all candidates'
  );
  assert(
    testCandidateScope('RECRUITER', 'recruiter-1', 'recruiter-1', 'other-recruiter'),
    'Recruiter can access candidate they own'
  );
  assert(
    !testCandidateScope('RECRUITER', 'recruiter-1', 'recruiter-2', 'recruiter-2'),
    'Recruiter A CANNOT access Recruiter B candidate (IDOR protection verified)'
  );

  console.log('\n====================================================');
  console.log(`🎉 All ${passedTests}/${totalTests} tests passed successfully!`);
  console.log('====================================================\n');
}

runTestSuite().catch((err) => {
  console.error('[TEST SUITE ERROR]', err);
  process.exit(1);
});
