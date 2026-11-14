import { getCallingOwner, parseISTDateRange } from '../services/team-calling.service';
import { normalizeIndianPhone, formatIndianPhone, isValidIndianPhone } from '../utils/phone';
import { toISODate, formatDate } from '../utils/dateFormatter';

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

  // Test 5: Phone Normalization SSOT
  console.log('--- Testing Phone Normalization SSOT ---');
  if (normalizeIndianPhone('+91 98765 43210') !== '9876543210') throw new Error('Phone test failed on +91 space format');
  if (normalizeIndianPhone('09876543210') !== '9876543210') throw new Error('Phone test failed on leading 0 format');
  if (normalizeIndianPhone('919876543210') !== '9876543210') throw new Error('Phone test failed on country code 91 prefix');
  if (normalizeIndianPhone('9876543210') !== '9876543210') throw new Error('Phone test failed on raw 10 digits');
  if (normalizeIndianPhone('5555555555') !== null) throw new Error('Phone test failed on invalid starting digit (5)');
  if (normalizeIndianPhone('12345') !== null) throw new Error('Phone test failed on short length');
  if (!isValidIndianPhone('+91-98765-43210')) throw new Error('isValidIndianPhone failed on dashed phone');
  if (formatIndianPhone('9876543210') !== '+91 98765 43210') throw new Error('formatIndianPhone formatting mismatch');
  console.log('✔ Test 5: normalizeIndianPhone accurately strips prefixes and validates 10 digits starting with 6-9');

  // Test 6: Date Formatter SSOT
  console.log('--- Testing Date Formatter SSOT ---');
  if (toISODate('2026-11-14') !== '2026-11-14') throw new Error('toISODate failed on date string');
  if (!formatDate(new Date('2026-11-14T12:00:00Z')).includes('2026')) throw new Error('formatDate failed');
  console.log('✔ Test 6: toISODate and formatDate working stably');

  console.log('All Team Calling & Phone / Date SSOT unit tests passed!');
}

runTests();

