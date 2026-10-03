import {
  generateCandidateCode,
  generateApplicationCode,
  generateJobCode,
} from '../utils/codeGenerators';
import { CANONICAL_SEND_BACK_REASONS } from '../controllers/team-leader.controller';
import { CANONICAL_PIPELINE_STAGES } from '../controllers/candidate.controller';

async function testRecruitmentOS() {
  console.log('--- Testing Recruitment OS Upgrade ---');

  // Test 1: Canonical Send Back Reasons
  console.log('1. Verifying Canonical Send Back Reasons:');
  const expectedReasons = [
    'Experience mismatch',
    'Salary mismatch',
    'Location mismatch',
    'Communication issue',
    'Incomplete profile',
    'Missing document',
    'Other',
  ];
  for (const r of expectedReasons) {
    if (!CANONICAL_SEND_BACK_REASONS.includes(r as any)) {
      throw new Error(`Missing expected send-back reason: ${r}`);
    }
  }
  console.log('   All 7 canonical send back reasons verified.');

  // Test 2: Canonical Pipeline Stages
  console.log('2. Verifying Canonical Pipeline Stages:');
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
  const exceptions = [
    'Rejected',
    'On Hold',
    'Not Interested',
    'No Response',
    'Not Eligible',
    'Withdrawn',
    'Duplicate',
  ];
  for (const s of [...required13Stages, ...exceptions]) {
    if (!CANONICAL_PIPELINE_STAGES.includes(s as any)) {
      throw new Error(`Missing canonical stage: ${s}`);
    }
  }
  console.log('   Canonical 13 stages and 7 exceptions verified.');

  // Test 3: Code Generators regex validation
  console.log('3. Verifying Code Generators format:');
  // Mock DB test or regex verification
  const candidateCodePattern = /^CND-\d{6}$/;
  const appCodePattern = /^APP-\d{6}$/;
  const currentYear = new Date().getFullYear();
  const jobCodePattern = new RegExp(`^OE-${currentYear}-\\d{5}$`);

  // Mock test with minimal mock
  const mockDb: any = {
    candidate: {
      findMany: async () => [{ candidateCode: 'CND-000183' }],
    },
    application: {
      findMany: async () => [{ applicationCode: 'APP-000937' }],
    },
    job: {
      findMany: async () => [{ jobCode: `OE-${currentYear}-00123` }],
    },
  };

  const nextCandCode = await generateCandidateCode(mockDb);
  console.log('   Generated Candidate Code:', nextCandCode);
  if (nextCandCode !== 'CND-000184' || !candidateCodePattern.test(nextCandCode)) {
    throw new Error(`Unexpected candidate code: ${nextCandCode}`);
  }

  const nextAppCode = await generateApplicationCode(mockDb);
  console.log('   Generated Application Code:', nextAppCode);
  if (nextAppCode !== 'APP-000938' || !appCodePattern.test(nextAppCode)) {
    throw new Error(`Unexpected application code: ${nextAppCode}`);
  }

  const nextJobCode = await generateJobCode(mockDb);
  console.log('   Generated Job Code:', nextJobCode);
  if (nextJobCode !== `OE-${currentYear}-00124` || !jobCodePattern.test(nextJobCode)) {
    throw new Error(`Unexpected job code: ${nextJobCode}`);
  }

  console.log('--- All Recruitment OS Unit Tests Passed Successfully! ---');
}

testRecruitmentOS().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
