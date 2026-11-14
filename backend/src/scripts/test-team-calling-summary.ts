import { getCallingOwner, parseISTDateRange } from '../services/team-calling.service';

function runTests() {
  console.log('--- Testing Team Calling SSOT Logic ---');

  // Test 1: Calling owner single rule
  const candWithOwner = { ownerRecruiterId: 'rec-owner-1', assignedRecruiterIds: ['rec-assigned-2'] };
  if (getCallingOwner(candWithOwner) !== 'rec-owner-1') {
    throw new Error('Test 1 failed: ownerRecruiterId should take precedence');
  }
  console.log('✔ Test 1: ownerRecruiterId takes precedence');

  // Test 2: Fallback to assignedRecruiterIds[0]
  const candWithAssignedOnly = { ownerRecruiterId: null, assignedRecruiterIds: ['rec-assigned-2', 'rec-assigned-3'] };
  if (getCallingOwner(candWithAssignedOnly) !== 'rec-assigned-2') {
    throw new Error('Test 2 failed: assignedRecruiterIds[0] should be used as fallback');
  }
  console.log('✔ Test 2: Fallback to assignedRecruiterIds[0]');

  // Test 3: Unmapped / unassigned
  const candUnassigned = { ownerRecruiterId: '', assignedRecruiterIds: [] };
  if (getCallingOwner(candUnassigned) !== null) {
    throw new Error('Test 3 failed: should be null for unassigned');
  }
  console.log('✔ Test 3: Unassigned resolves to null');

  // Test 4: IST Date Range parsing
  const range = parseISTDateRange('2026-11-14', '2026-11-14');
  if (!range.from || !range.to) {
    throw new Error('Test 4 failed: range from/to should not be null');
  }
  // 2026-11-14 00:00:00 IST is 2026-11-13 18:30:00.000Z
  const expectedFromIso = new Date('2026-11-13T18:30:00.000Z').toISOString();
  if (range.from.toISOString() !== expectedFromIso) {
    throw new Error(`Test 4 failed: expected from ${expectedFromIso}, got ${range.from.toISOString()}`);
  }

  // 2026-11-14 23:59:59.999 IST is 2026-11-14 18:29:59.999Z
  const expectedToIso = new Date('2026-11-14T18:29:59.999Z').toISOString();
  if (range.to.toISOString() !== expectedToIso) {
    throw new Error(`Test 4 failed: expected to ${expectedToIso}, got ${range.to.toISOString()}`);
  }
  console.log('✔ Test 4: IST date boundaries parsed accurately');

  console.log('All Team Calling unit tests passed!');
}

runTests();
