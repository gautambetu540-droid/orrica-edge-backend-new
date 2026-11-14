import assert from 'assert';
import {
  statusRules,
  resolvePipelineStage,
  resolveOperationalStatus,
  deriveStatus,
} from '../shared/candidateStatusConfig';

console.log('====================================================');
console.log('🧪 Testing Candidate Status Mutation & Concurrency Logic');
console.log('====================================================\n');

// Mock candidate fixture
const mockCandidate = {
  id: 'cand-mut-001',
  candidateCode: 'OE-CAND-001',
  fullName: 'Pooja Sharma',
  status: 'Not Called',
  operationalStatus: 'Not Called',
  pipelineStage: 'Not Called',
  updatedAt: new Date('2026-11-14T10:00:00.000Z'),
};

// Pure logic validator mirroring applyCandidateStatusChange
function simulateStatusChange(
  existing: typeof mockCandidate,
  payload: {
    pipelineStage?: string;
    operationalStatus?: string;
    walkInDate?: string;
    followUpAt?: string;
    clientName?: string;
    remarks?: string;
    expectedUpdatedAt?: string;
  }
) {
  // 1. Optimistic Concurrency Check
  if (payload.expectedUpdatedAt) {
    const expectedTime = new Date(payload.expectedUpdatedAt).getTime();
    const currentTime = new Date(existing.updatedAt).getTime();
    if (!Number.isNaN(expectedTime) && Math.abs(currentTime - expectedTime) > 1500) {
      return {
        success: false,
        statusCode: 409,
        conflict: true,
        message: 'Candidate was modified by another user. Please refresh and review latest updates.',
        currentCandidate: existing,
      };
    }
  }

  // 2. Resolve stages
  const pipeStage = payload.pipelineStage ? resolvePipelineStage(payload.pipelineStage) : undefined;
  const opStatus = payload.operationalStatus ? resolveOperationalStatus(payload.operationalStatus) : undefined;

  // 3. Gate validation
  if (pipeStage) {
    const rule = (statusRules as Record<string, any>)[pipeStage];
    if (rule) {
      const check = rule.validate(payload, existing);
      if (!check.valid) {
        return { success: false, statusCode: 400, message: check.error };
      }
    }
  }

  // 4. Derive status
  const nextDerivedStatus = deriveStatus({
    pipelineStage: pipeStage || existing.pipelineStage,
    operationalStatus: opStatus || existing.operationalStatus,
    status: existing.status,
  });

  return {
    success: true,
    statusCode: 200,
    candidate: {
      ...existing,
      pipelineStage: pipeStage || existing.pipelineStage,
      operationalStatus: opStatus || existing.operationalStatus,
      status: nextDerivedStatus,
      updatedAt: new Date(),
    },
  };
}

// ----------------------------------------------------
// Test 1: Validation gate failure returns 400
// ----------------------------------------------------
console.log('--- 1. Testing Validation Gate (Walk-in requires walkInDate) ---');
const gateFail = simulateStatusChange(mockCandidate, {
  pipelineStage: 'Ready to Go – Walk-in Scheduled',
  // intentionally missing walkInDate
});
assert.strictEqual(gateFail.success, false);
assert.strictEqual(gateFail.statusCode, 400);
console.log('  ✅ [PASS] Gate rejected missing walkInDate with 400:', gateFail.message);

// ----------------------------------------------------
// Test 2: Valid transition succeeds and derives status
// ----------------------------------------------------
console.log('\n--- 2. Testing Valid Transition with Gate Passed ---');
const gatePass = simulateStatusChange(mockCandidate, {
  pipelineStage: 'Ready to Go - Walk-in Scheduled', // hyphen tested
  walkInDate: '2026-11-20',
  remarks: 'Candidate scheduled for walk-in drive tomorrow',
});
assert.strictEqual(gatePass.success, true);
assert.strictEqual(gatePass.statusCode, 200);
assert.strictEqual(gatePass.candidate!.status, 'Ready to Go – Walk-in Scheduled');
assert.strictEqual(gatePass.candidate!.pipelineStage, 'Ready to Go – Walk-in Scheduled');
console.log('  ✅ [PASS] Valid transition succeeded with derived status:', gatePass.candidate!.status);

// ----------------------------------------------------
// Test 3: Optimistic Concurrency 409 Conflict
// ----------------------------------------------------
console.log('\n--- 3. Testing Optimistic Concurrency (409 Conflict) ---');
const staleTimestamp = new Date('2026-11-14T08:00:00.000Z').toISOString(); // 2 hours older
const conflictRes = simulateStatusChange(mockCandidate, {
  operationalStatus: 'Contacted',
  expectedUpdatedAt: staleTimestamp,
});
assert.strictEqual(conflictRes.success, false);
assert.strictEqual(conflictRes.statusCode, 409);
assert.strictEqual(conflictRes.conflict, true);
console.log('  ✅ [PASS] Detected stale timestamp, returned 409 conflict:', conflictRes.message);

// ----------------------------------------------------
// Test 4: Bulk Status Change Aggregation
// ----------------------------------------------------
console.log('\n--- 4. Testing Bulk Status Aggregation Logic ---');
function simulateBulk(candidates: Array<typeof mockCandidate | null>, targetStatus: string) {
  const results = candidates.map((c, i) => {
    if (!c) return { id: `missing-${i}`, success: false, statusCode: 404, message: 'Candidate not found' };
    return simulateStatusChange(c, { pipelineStage: targetStatus });
  });
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  return {
    success: succeeded > 0,
    statusCode: failed === 0 ? 200 : (succeeded > 0 ? 207 : 400),
    summary: { total: candidates.length, succeeded, failed },
    results,
  };
}

const bulkRes = simulateBulk([mockCandidate, null], 'Shortlisted by Recruiter');
assert.strictEqual(bulkRes.summary.total, 2);
assert.strictEqual(bulkRes.summary.succeeded, 1);
assert.strictEqual(bulkRes.summary.failed, 1);
assert.strictEqual(bulkRes.statusCode, 207);
console.log('  ✅ [PASS] Bulk partial reporting verified (1 succeeded, 1 failed, status 207):', bulkRes.summary);

console.log('\n====================================================');
console.log('🎉 ALL MUTATION & CONCURRENCY TESTS PASSED 100%!');
console.log('====================================================\n');
