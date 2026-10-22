/**
 * Canonical Candidate ID Migration & Sequence Synchronization
 *
 * Migrates legacy candidate codes (CND-XXXXXX, OE-CAND-XX) to the canonical format:
 * OE-CAND-XXXX (e.g. OE-CAND-0001, OE-CAND-0173, OE-CAND-0185)
 *
 * Rules:
 * 1. Safe, idempotent, non-destructive migration.
 * 2. Preserves relational integrity (Candidate master record, applications, activities, timelines).
 * 3. Builds a clear mapping table of old IDs -> new canonical IDs.
 * 4. Synchronizes PostgreSQL candidate_code_seq with MAX(sequence).
 */

import { prisma } from '../prisma/client';

export interface MigrationMapping {
  candidateId: string;
  candidateName: string;
  oldCode: string;
  newCode: string;
  status: 'MIGRATED' | 'ALREADY_CANONICAL' | 'COLLISION_RESOLVED';
}

export async function migrateCandidateCodes(dryRun = false): Promise<{
  totalCandidates: number;
  migratedCount: number;
  alreadyCanonicalCount: number;
  mapping: MigrationMapping[];
}> {
  console.log('\n======================================================');
  console.log(`--- CANDIDATE ID CANONICAL MIGRATION (${dryRun ? 'DRY-RUN' : 'LIVE'}) ---`);
  console.log('======================================================\n');

  const candidates = await prisma.candidate.findMany({
    select: {
      id: true,
      candidateCode: true,
      fullName: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const mapping: MigrationMapping[] = [];
  const assignedCodes = new Set<string>();

  // 1. First pass: Collect all existing canonical OE-CAND-XXXX codes
  for (const c of candidates) {
    if (c.candidateCode && /^OE-CAND-\d{4,}$/i.test(c.candidateCode)) {
      assignedCodes.add(c.candidateCode.toUpperCase());
    }
  }

  let maxSequence = 0;
  for (const code of assignedCodes) {
    const num = parseInt(code.replace(/^OE-CAND-/i, ''), 10);
    if (!isNaN(num) && num > maxSequence) {
      maxSequence = num;
    }
  }

  let migratedCount = 0;
  let alreadyCanonicalCount = 0;

  // 2. Second pass: Calculate new canonical codes
  for (const c of candidates) {
    const oldCode = (c.candidateCode || '').trim();

    if (/^OE-CAND-\d{4,}$/i.test(oldCode)) {
      alreadyCanonicalCount++;
      mapping.push({
        candidateId: c.id,
        candidateName: c.fullName,
        oldCode,
        newCode: oldCode.toUpperCase(),
        status: 'ALREADY_CANONICAL',
      });
      continue;
    }

    // Extract sequence number from legacy code (e.g. CND-000185 -> 185)
    let candidateSeq = 0;
    const cndMatch = oldCode.match(/^CND-(\d+)$/i);
    const shortOeMatch = oldCode.match(/^OE-CAND-(\d+)$/i);

    if (cndMatch) {
      candidateSeq = parseInt(cndMatch[1], 10);
    } else if (shortOeMatch) {
      candidateSeq = parseInt(shortOeMatch[1], 10);
    } else {
      maxSequence++;
      candidateSeq = maxSequence;
    }

    let targetCode = `OE-CAND-${String(candidateSeq).padStart(4, '0')}`;

    // Handle collisions if code is already taken
    let status: MigrationMapping['status'] = 'MIGRATED';
    if (assignedCodes.has(targetCode)) {
      maxSequence++;
      targetCode = `OE-CAND-${String(maxSequence).padStart(4, '0')}`;
      status = 'COLLISION_RESOLVED';
    }

    assignedCodes.add(targetCode);
    if (candidateSeq > maxSequence) {
      maxSequence = candidateSeq;
    }

    mapping.push({
      candidateId: c.id,
      candidateName: c.fullName,
      oldCode,
      newCode: targetCode,
      status,
    });
    migratedCount++;
  }

  console.log(`Total Candidates: ${candidates.length}`);
  console.log(`Already Canonical: ${alreadyCanonicalCount}`);
  console.log(`To Migrate: ${migratedCount}`);

  if (!dryRun && migratedCount > 0) {
    console.log('\nApplying migrations in atomic transaction...');
    await prisma.$transaction(async (tx) => {
      for (const m of mapping) {
        if (m.status !== 'ALREADY_CANONICAL') {
          await tx.candidate.update({
            where: { id: m.candidateId },
            data: { candidateCode: m.newCode },
          });
        }
      }

      // Synchronize postgresql sequence
      try {
        if (typeof (tx as any).$executeRaw === 'function') {
          await tx.$executeRaw`SELECT setval('candidate_code_seq', ${Math.max(maxSequence, 1)}, true)`;
          console.log(`Synchronized PostgreSQL sequence candidate_code_seq to ${maxSequence}`);
        }
      } catch (seqErr: any) {
        console.warn('PostgreSQL sequence sync note:', seqErr.message);
      }
    });

    console.log('✅ All candidate codes migrated successfully!');
  }

  return {
    totalCandidates: candidates.length,
    migratedCount,
    alreadyCanonicalCount,
    mapping,
  };
}

if (require.main === module) {
  const isDryRun = process.argv.includes('--dry-run');
  migrateCandidateCodes(isDryRun)
    .then((res) => {
      console.log(`\nMigration complete: ${res.migratedCount} candidates migrated to OE-CAND-XXXX canonical format.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
