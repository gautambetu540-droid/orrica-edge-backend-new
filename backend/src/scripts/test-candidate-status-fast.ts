import assert from 'assert';

console.log('--- Testing Candidate Status & Pipeline Fast Logic ---');

const OFFICIAL_PIPELINE_STAGES = [
  'Not Called',
  'No Response',
  'Callback Scheduled',
  'On Hold – After 7 Days',
  'Screening – Under Evaluation',
  'Shortlisted by Recruiter',
  'Ready to Go – Walk-in Scheduled',
  'Client Select',
  'Onboarding Under Process',
  'Joined – Winning Option',
];

const OFFICIAL_PIPELINE_SET = new Set(OFFICIAL_PIPELINE_STAGES);

// Gate validation test helper
function validateStatusTransition(payload: {
  status?: string;
  operationalStatus?: string;
  pipelineStage?: string;
  followUpAt?: string | null;
  walkInDate?: string | null;
  clientName?: string | null;
  feedback?: string | null;
  dateOfJoin?: string | null;
  actualJoiningStatus?: string | null;
}, existing: {
  followUpAt?: string | null;
  walkInDate?: string | null;
  clientName?: string | null;
  feedback?: string | null;
  dateOfJoin?: string | null;
  actualJoiningStatus?: string | null;
}) {
  const opStatus = payload.operationalStatus || (payload.status && !OFFICIAL_PIPELINE_SET.has(payload.status) ? payload.status : undefined);
  const pipeStage = payload.pipelineStage !== undefined ? payload.pipelineStage : (payload.status && OFFICIAL_PIPELINE_SET.has(payload.status) ? payload.status : undefined);

  if (opStatus === 'Callback Requested' || opStatus === 'On Hold' || opStatus === 'Callback Scheduled') {
    if (!payload.followUpAt && !existing.followUpAt) {
      return { ok: false, error: 'A follow-up date is required when setting status to Callback Requested or On Hold.' };
    }
  }

  if (pipeStage === 'Ready to Go – Walk-in Scheduled' || pipeStage === 'Ready to Go - Walk-in Scheduled') {
    if (!payload.walkInDate && !existing.walkInDate) {
      return { ok: false, error: 'A walk-in date is required for Ready to Go – Walk-in Scheduled.' };
    }
  }

  if (pipeStage === 'Client Select') {
    if (!payload.clientName && !existing.clientName && !payload.feedback && !existing.feedback) {
      return { ok: false, error: 'Client feedback or client name is required for Client Select.' };
    }
  }

  if (pipeStage === 'Joined – Winning Option' || pipeStage === 'Joined - Winning Option') {
    if (!payload.dateOfJoin && !existing.dateOfJoin && !payload.actualJoiningStatus && !existing.actualJoiningStatus) {
      return { ok: false, error: 'Confirmed joining date or status is required for Joined – Winning Option.' };
    }
  }

  return { ok: true };
}

// 1. Gate: Callback Requested without followUpAt -> rejected
const r1 = validateStatusTransition({ operationalStatus: 'Callback Requested' }, {});
assert.strictEqual(r1.ok, false);
assert.ok(r1.error?.includes('follow-up date is required'));
console.log('✓ Validation Gate 1: Callback Requested without follow-up date rejected');

// 2. Gate: Callback Requested with followUpAt -> accepted
const r2 = validateStatusTransition({ operationalStatus: 'Callback Requested', followUpAt: '2026-11-10' }, {});
assert.strictEqual(r2.ok, true);
console.log('✓ Validation Gate 2: Callback Requested with follow-up date accepted');

// 3. Gate: Ready to Go – Walk-in Scheduled without walkInDate -> rejected
const r3 = validateStatusTransition({ pipelineStage: 'Ready to Go – Walk-in Scheduled' }, {});
assert.strictEqual(r3.ok, false);
assert.ok(r3.error?.includes('walk-in date is required'));
console.log('✓ Validation Gate 3: Walk-in Scheduled without walk-in date rejected');

// 4. Gate: Ready to Go – Walk-in Scheduled with walkInDate -> accepted
const r4 = validateStatusTransition({ pipelineStage: 'Ready to Go – Walk-in Scheduled', walkInDate: '2026-11-12' }, {});
assert.strictEqual(r4.ok, true);
console.log('✓ Validation Gate 4: Walk-in Scheduled with walk-in date accepted');

// 5. Gate: Client Select requires client or feedback
const r5 = validateStatusTransition({ pipelineStage: 'Client Select' }, {});
assert.strictEqual(r5.ok, false);
const r5b = validateStatusTransition({ pipelineStage: 'Client Select', clientName: 'Digitide Solutions' }, {});
assert.strictEqual(r5b.ok, true);
console.log('✓ Validation Gate 5: Client Select client verification passed');

// 6. Gate: Joined – Winning Option requires dateOfJoin or joining status
const r6 = validateStatusTransition({ pipelineStage: 'Joined – Winning Option' }, {});
assert.strictEqual(r6.ok, false);
const r6b = validateStatusTransition({ pipelineStage: 'Joined – Winning Option', dateOfJoin: '2026-11-15' }, {});
assert.strictEqual(r6b.ok, true);
console.log('✓ Validation Gate 6: Joined Winning Option DOJ verification passed');

console.log('--- All Candidate Status & Pipeline Fast Logic Tests Passed Successfully! ---');

