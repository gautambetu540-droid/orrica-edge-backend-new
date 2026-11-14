import { PrismaClient } from '@prisma/client';
import {
  resolvePipelineStage,
  resolveOperationalStatus,
  deriveStatus,
  LEGACY_STATUS_MAP,
} from '../shared/candidateStatusConfig';

const prisma = new PrismaClient();

async function runStatusMigration() {
  const isApply = process.argv.includes('--apply');
  console.log('====================================================');
  console.log(`🔄 Candidate Status SSOT Migration [${isApply ? 'APPLY MODE' : 'DRY RUN'}]`);
  console.log('====================================================\n');

  const candidates = await prisma.candidate.findMany({
    select: {
      id: true,
      candidateCode: true,
      status: true,
      operationalStatus: true,
      pipelineStage: true,
    },
  });

  console.log(`Found ${candidates.length} candidate rows in database to inspect.\n`);

  let updatedCount = 0;
  const mappingCounts: Record<string, number> = {};

  for (const cand of candidates) {
    const rawStatus = cand.status || '';
    const rawOp = cand.operationalStatus || '';
    const rawPipe = cand.pipelineStage || '';

    // 1. Resolve pipeline stage
    let nextPipe: string | null = cand.pipelineStage;
    if (!nextPipe && rawStatus) {
      nextPipe = resolvePipelineStage(rawStatus);
    } else if (nextPipe) {
      nextPipe = resolvePipelineStage(nextPipe) || nextPipe;
    }

    // 2. Resolve operational status
    let nextOp: string | null = cand.operationalStatus;
    if (!nextOp && rawStatus && !nextPipe) {
      nextOp = resolveOperationalStatus(rawStatus);
    } else if (nextOp) {
      nextOp = resolveOperationalStatus(nextOp) || nextOp;
    }

    // 3. Resolve legacy mappings
    const upperStatus = rawStatus.trim().toUpperCase().replace(/[- ]/g, '_');
    if (LEGACY_STATUS_MAP[upperStatus]) {
      const mapped = LEGACY_STATUS_MAP[upperStatus];
      if (!nextPipe && mapped.pipelineStage) nextPipe = mapped.pipelineStage;
      if (!nextOp && mapped.operationalStatus) nextOp = mapped.operationalStatus;
    }

    // 4. Derive canonical status
    const nextDerivedStatus = deriveStatus({
      pipelineStage: nextPipe,
      operationalStatus: nextOp,
      status: rawStatus,
    });

    const needsUpdate =
      nextPipe !== cand.pipelineStage ||
      nextOp !== cand.operationalStatus ||
      nextDerivedStatus !== cand.status;

    if (needsUpdate) {
      updatedCount++;
      const changeKey = `"${rawStatus || 'null'}" / "${rawPipe || 'null'}" -> Stage: "${nextPipe || 'null'}", Op: "${nextOp || 'null'}", Status: "${nextDerivedStatus}"`;
      mappingCounts[changeKey] = (mappingCounts[changeKey] || 0) + 1;

      if (isApply) {
        await prisma.candidate.update({
          where: { id: cand.id },
          data: {
            pipelineStage: nextPipe,
            operationalStatus: nextOp,
            status: nextDerivedStatus,
          },
        });
      }
    }
  }

  console.log('--- Migration Summary ---');
  console.log(`Total Candidates Evaluated: ${candidates.length}`);
  console.log(`Candidates Needing Alignment: ${updatedCount}`);
  console.log('\nMappings Breakdown:');
  for (const [mapping, count] of Object.entries(mappingCounts)) {
    console.log(`  [${count} rows] ${mapping}`);
  }

  if (!isApply) {
    console.log('\n💡 Dry-run completed. No database rows were modified.');
    console.log('To apply these changes, run with: npm run migrate:candidate-status -- --apply');
  } else {
    console.log('\n✅ Database migration successfully applied!');
  }
}

runStatusMigration()
  .catch((err) => {
    console.error('Migration error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
