import assert from 'assert';
import {
  PIPELINE_STAGES,
  PipelineStage,
  OPERATIONAL_STATUSES,
  OperationalStatus,
  resolvePipelineStage,
  resolveOperationalStatus,
  deriveStatus,
  statusRules,
  isTerminal,
} from '../shared/candidateStatusConfig';

console.log('====================================================');
console.log('🧪 Testing Candidate Status Single Source of Truth');
console.log('====================================================\n');

// ----------------------------------------------------
// 1. Table-Driven Test: Pipeline Stage Aliases & Dashes
// ----------------------------------------------------
console.log('--- 1. Testing Pipeline Stage Resolution (Dashes, Case, Aliases) ---');

const pipelineTestCases: Array<{ input: string; expected: PipelineStage | null; desc: string }> = [
  // Exact Canonical 10
  { input: 'Not Called', expected: 'Not Called', desc: 'Canonical 1: Not Called exact' },
  { input: 'No Response', expected: 'No Response', desc: 'Canonical 2: No Response exact' },
  { input: 'Callback Scheduled', expected: 'Callback Scheduled', desc: 'Canonical 3: Callback Scheduled exact' },
  { input: 'On Hold – After 7 Days', expected: 'On Hold – After 7 Days', desc: 'Canonical 4: En-dash exact' },
  { input: 'Screening – Under Evaluation', expected: 'Screening – Under Evaluation', desc: 'Canonical 5: En-dash exact' },
  { input: 'Shortlisted by Recruiter', expected: 'Shortlisted by Recruiter', desc: 'Canonical 6: Shortlisted exact' },
  { input: 'Ready to Go – Walk-in Scheduled', expected: 'Ready to Go – Walk-in Scheduled', desc: 'Canonical 7: En-dash exact' },
  { input: 'Client Select', expected: 'Client Select', desc: 'Canonical 8: Client Select exact' },
  { input: 'Onboarding Under Process', expected: 'Onboarding Under Process', desc: 'Canonical 9: Onboarding exact' },
  { input: 'Joined – Winning Option', expected: 'Joined – Winning Option', desc: 'Canonical 10: Joined exact' },

  // Dash tolerance: regular hyphen
  { input: 'On Hold - After 7 Days', expected: 'On Hold – After 7 Days', desc: 'Regular hyphen mapped to en-dash' },
  { input: 'Screening - Under Evaluation', expected: 'Screening – Under Evaluation', desc: 'Regular hyphen mapped to en-dash' },
  { input: 'Ready to Go - Walk-in Scheduled', expected: 'Ready to Go – Walk-in Scheduled', desc: 'Regular hyphen mapped to en-dash (P0-2 fix)' },
  { input: 'Joined - Winning Option', expected: 'Joined – Winning Option', desc: 'Regular hyphen mapped to en-dash' },

  // Dash tolerance: em-dash (—)
  { input: 'Ready to Go — Walk-in Scheduled', expected: 'Ready to Go – Walk-in Scheduled', desc: 'Em-dash mapped to en-dash' },
  { input: 'On Hold — After 7 Days', expected: 'On Hold – After 7 Days', desc: 'Em-dash mapped to en-dash' },

  // Case insensitivity & spaces
  { input: 'ready to go - walk-in scheduled', expected: 'Ready to Go – Walk-in Scheduled', desc: 'All-lowercase with regular hyphen' },
  { input: '  CLIENT SELECT  ', expected: 'Client Select', desc: 'Uppercase with whitespace trimming' },
  { input: 'screening - under evaluation', expected: 'Screening – Under Evaluation', desc: 'Lowercase hyphenated' },
  { input: 'joined - winning option', expected: 'Joined – Winning Option', desc: 'Lowercase joined' },

  // Legacy uppercase mapping
  { input: 'NEW', expected: 'Not Called', desc: 'Legacy NEW -> Not Called' },
  { input: 'SCREENING', expected: 'Screening – Under Evaluation', desc: 'Legacy SCREENING -> Screening – Under Evaluation' },
  { input: 'SHORTLISTED', expected: 'Shortlisted by Recruiter', desc: 'Legacy SHORTLISTED -> Shortlisted by Recruiter' },
  { input: 'INTERVIEW', expected: 'Ready to Go – Walk-in Scheduled', desc: 'Legacy INTERVIEW -> Ready to Go – Walk-in Scheduled' },
  { input: 'SELECTED', expected: 'Client Select', desc: 'Legacy SELECTED -> Client Select' },
  { input: 'JOINED', expected: 'Joined – Winning Option', desc: 'Legacy JOINED -> Joined – Winning Option' },
  { input: 'ON_HOLD', expected: 'On Hold – After 7 Days', desc: 'Legacy ON_HOLD -> On Hold – After 7 Days' },

  // Non-pipeline / invalid
  { input: 'Random Invalid Status', expected: null, desc: 'Invalid string returns null' },
  { input: '', expected: null, desc: 'Empty string returns null' },
];

for (const tc of pipelineTestCases) {
  const actual = resolvePipelineStage(tc.input);
  assert.strictEqual(actual, tc.expected, `Failed [${tc.desc}]: for input "${tc.input}", expected "${tc.expected}", got "${actual}"`);
  console.log(`  ✅ [PASS] ${tc.desc}: "${tc.input}" => "${actual}"`);
}

// ----------------------------------------------------
// 2. Table-Driven Test: Operational Status Resolution
// ----------------------------------------------------
console.log('\n--- 2. Testing Operational Status Resolution ---');

const opTestCases: Array<{ input: string; expected: OperationalStatus | null; desc: string }> = [
  { input: 'Contacted', expected: 'Contacted', desc: 'Exact Contacted' },
  { input: 'Interested', expected: 'Interested', desc: 'Exact Interested' },
  { input: 'Not Interested', expected: 'Not Interested', desc: 'Exact Not Interested' },
  { input: 'Not Reachable', expected: 'Not Reachable', desc: 'Exact Not Reachable' },
  { input: 'Wrong Number', expected: 'Wrong Number', desc: 'Exact Wrong Number' },
  { input: 'Callback Requested', expected: 'Callback Requested', desc: 'Exact Callback Requested' },
  { input: 'On Hold', expected: 'On Hold', desc: 'Exact On Hold' },
  { input: 'Do Not Call', expected: 'Do Not Call', desc: 'Exact Do Not Call' },

  // Case & aliases
  { input: 'not interested', expected: 'Not Interested', desc: 'Lowercase not interested' },
  { input: 'callback', expected: 'Callback Requested', desc: 'Alias callback' },
  { input: 'DNC', expected: 'Do Not Call', desc: 'Alias DNC' },
  { input: 'busy', expected: 'Not Reachable', desc: 'Alias busy' },
  { input: 'unreachable', expected: 'Not Reachable', desc: 'Alias unreachable' },
];

for (const tc of opTestCases) {
  const actual = resolveOperationalStatus(tc.input);
  assert.strictEqual(actual, tc.expected, `Failed [${tc.desc}]: for input "${tc.input}", expected "${tc.expected}", got "${actual}"`);
  console.log(`  ✅ [PASS] ${tc.desc}: "${tc.input}" => "${actual}"`);
}

// ----------------------------------------------------
// 3. Derived Status Logic
// ----------------------------------------------------
console.log('\n--- 3. Testing Derived Status Calculation ---');

// Pipeline stage takes precedence if progressed beyond initial
const d1 = deriveStatus({ pipelineStage: 'Ready to Go – Walk-in Scheduled', operationalStatus: 'Interested' });
assert.strictEqual(d1, 'Ready to Go – Walk-in Scheduled');
console.log('  ✅ [PASS] Pipeline stage takes precedence when progressed:', d1);

// Operational status takes precedence if pipeline is default 'Not Called'
const d2 = deriveStatus({ pipelineStage: 'Not Called', operationalStatus: 'Interested' });
assert.strictEqual(d2, 'Interested');
console.log('  ✅ [PASS] Operational status used when pipeline is Not Called:', d2);

// Plain hyphen pipeline stage is resolved cleanly in deriveStatus
const d3 = deriveStatus({ pipelineStage: 'Ready to Go - Walk-in Scheduled' as any });
assert.strictEqual(d3, 'Ready to Go – Walk-in Scheduled');
console.log('  ✅ [PASS] Plain hyphen pipeline stage canonicalized in deriveStatus:', d3);

// Fallback to existing or 'Not Called'
const d4 = deriveStatus({});
assert.strictEqual(d4, 'Not Called');
console.log('  ✅ [PASS] Empty candidate defaults safely to Not Called:', d4);

// ----------------------------------------------------
// 4. Status Validation Rules & Gates
// ----------------------------------------------------
console.log('\n--- 4. Testing Gate Validation Rules ---');

// Callback Scheduled
const cbFail = statusRules['Callback Scheduled'].validate({});
assert.strictEqual(cbFail.valid, false);
console.log('  ✅ [PASS] Callback Scheduled rejected without followUpAt');

const cbPass = statusRules['Callback Scheduled'].validate({ followUpAt: new Date().toISOString() });
assert.strictEqual(cbPass.valid, true);
console.log('  ✅ [PASS] Callback Scheduled passed with followUpAt');

// Ready to Go – Walk-in Scheduled
const walkinFail = statusRules['Ready to Go – Walk-in Scheduled'].validate({});
assert.strictEqual(walkinFail.valid, false);
console.log('  ✅ [PASS] Walk-in Scheduled rejected without walkInDate');

const walkinPass = statusRules['Ready to Go – Walk-in Scheduled'].validate({ walkInDate: '2026-11-20' });
assert.strictEqual(walkinPass.valid, true);
console.log('  ✅ [PASS] Walk-in Scheduled passed with walkInDate');

// Client Select
const clientFail = statusRules['Client Select'].validate({});
assert.strictEqual(clientFail.valid, false);
console.log('  ✅ [PASS] Client Select rejected without client name or feedback');

const clientPass = statusRules['Client Select'].validate({ clientName: 'Tech Mahindra' });
assert.strictEqual(clientPass.valid, true);
console.log('  ✅ [PASS] Client Select passed with clientName');

// Joined – Winning Option
const joinedFail = statusRules['Joined – Winning Option'].validate({});
assert.strictEqual(joinedFail.valid, false);
console.log('  ✅ [PASS] Joined rejected without dateOfJoin or joining status');

const joinedPass = statusRules['Joined – Winning Option'].validate({ dateOfJoin: '2026-12-01' });
assert.strictEqual(joinedPass.valid, true);
console.log('  ✅ [PASS] Joined passed with dateOfJoin');

// ----------------------------------------------------
// 5. Terminal Status Detection
// ----------------------------------------------------
console.log('\n--- 5. Testing Terminal Statuses ---');
assert.strictEqual(isTerminal('Joined – Winning Option'), true);
assert.strictEqual(isTerminal('Rejected'), true);
assert.strictEqual(isTerminal('Screening – Under Evaluation'), false);
console.log('  ✅ [PASS] isTerminal correctly identifies final states');

console.log('\n====================================================');
console.log('🎉 ALL CANDIDATE STATUS SSOT TESTS PASSED 100%!');
console.log('====================================================\n');
