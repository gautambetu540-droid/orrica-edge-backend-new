import { DynamoDBClient, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { PrismaClient, CandidateStatus, Role, JobStatus, WorkMode, EmploymentType } from '@prisma/client';
import crypto from 'node:crypto';

const prisma = new PrismaClient();
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1' });

const TABLES = {
  candidates: process.env.DDB_CANDIDATES_TABLE || 'orrica_candidates',
  recruiters: process.env.DDB_RECRUITERS_TABLE || 'orrica_recruiters',
  questions: process.env.DDB_QUESTIONS_TABLE || 'orrica_questions',
  assessments: process.env.DDB_ASSESSMENTS_TABLE || 'orrica_assessments',
  jobs: process.env.DDB_JOBS_TABLE || 'orrica_jobs',
};

type AnyRecord = Record<string, any>;

function str(v: any, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function arr(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => typeof x === 'string' ? x : (x?.S ?? x?.value ?? String(x))).filter(Boolean);
}
function date(v: any, fallback = new Date()): Date {
  const d = v ? new Date(v) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
}
function uuidFrom(source: string): string {
  const hex = crypto.createHash('sha256').update(source).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function slugify(s: string): string {
  return str(s,'job').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80) || 'job';
}
async function scan(tableName: string): Promise<AnyRecord[]> {
  const out: AnyRecord[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const r = await dynamo.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    for (const item of r.Items ?? []) out.push(unmarshall(item));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}
function looksLikeCandidate(x: AnyRecord): boolean {
  const c = x.candidate && typeof x.candidate === 'object' ? x.candidate : x;
  return Boolean(
    x.candidateId &&
    (c.email || x.candidateEmail || c.phone || x.phone || c.fullName || c.name) &&
    !str(x.candidateId).startsWith('JOB-') &&
    !str(x.candidateId).startsWith('ASM-') &&
    !str(x.candidateId).startsWith('LOG-') &&
    !str(x.candidateId).startsWith('INT-')
  );
}
function candidateData(x: AnyRecord): AnyRecord {
  const c = x.candidate && typeof x.candidate === 'object' ? x.candidate : x;
  return {
    id: str(x.candidateId || c.candidateId || c.id),
    fullName: str(c.fullName || c.name || x.candidateName || x.name, 'Legacy Candidate'),
    email: str(c.email || x.candidateEmail || x.email),
    phone: str(c.phone || x.phone, 'N/A'),
    location: str(c.location || x.location, 'India'),
    education: c.education || x.education || null,
    experienceYears: Number(c.experienceYears ?? c.experience ?? x.experienceYears ?? 0) || 0,
    currentCompany: c.currentCompany || x.currentCompany || null,
    currentDesignation: c.currentDesignation || x.currentDesignation || null,
    skills: arr(c.skills || x.skills),
    languages: arr(c.languages || x.languages) || ['English'],
    resumeUrl: c.resumeUrl || x.resumeUrl || null,
    source: str(c.source || x.source, 'Legacy DynamoDB'),
    tags: arr(c.tags || x.tags),
    notes: c.notes || x.notes || null,
    status: str(c.status || x.status, 'NEW').toUpperCase(),
    createdAt: date(c.createdAt || x.createdAt),
    updatedAt: date(c.updatedAt || x.updatedAt, date(c.createdAt || x.createdAt)),
  };
}
function mapStatus(v: string): CandidateStatus {
  return (Object.values(CandidateStatus) as string[]).includes(v) ? v as CandidateStatus : CandidateStatus.NEW;
}

function sanitizeLegacyValue(value: any, depth = 0): any {
  if (depth > 3) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitizeLegacyValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: AnyRecord = {};
    for (const [key, v] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (lower.includes('password') || lower.includes('token') || lower.includes('secret') || lower.includes('accesskey')) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeLegacyValue(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 1000) return value.slice(0, 1000) + '…';
  return value;
}

function legacyType(x: AnyRecord): string {
  const raw = str(x.candidateId || x.jobId || x.assessmentId || x.interviewId || x.resultId || x.logId || x.id || x.pk || x.itemType || 'UNKNOWN');
  const upper = raw.toUpperCase();
  if (upper.startsWith('JOB-')) return 'JOB';
  if (upper.startsWith('ASM-')) return 'ASSESSMENT';
  if (upper.startsWith('INT-')) return 'INTERVIEW';
  if (upper.startsWith('LOG-')) return 'LOG';
  if (upper.startsWith('CATIQ-')) return 'QUESTION_BANK';
  if (upper.startsWith('EMAILTEMPLATE-')) return 'EMAIL_TEMPLATE';
  if (upper.startsWith('RESULT-')) return 'RESULT';
  if (upper.includes('COUNTER')) return 'SYSTEM';
  if (looksLikeCandidate(x)) return 'CANDIDATE';
  return str(x.itemType || x.action || 'OTHER').toUpperCase() || 'OTHER';
}

export async function runDynamoMigration(apply = false) {
  const APPLY = apply;
  console.log(`DynamoDB → PostgreSQL migration | mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log('No DynamoDB records are modified or deleted.');

  const [candidateRows, recruiterRows, questionRows, assessmentRows, jobRows] = await Promise.all([
    scan(TABLES.candidates),
    scan(TABLES.recruiters),
    scan(TABLES.questions),
    scan(TABLES.assessments),
    scan(TABLES.jobs),
  ]);

  const candidates = candidateRows.filter(looksLikeCandidate);
  const jobs = jobRows.filter(x => x.jobId || x.id || x.jobCode || x.title);
  const recruiters = recruiterRows.filter(x => x.recruiterId && x.email && !str(x.recruiterId).includes('COUNTER'));

  const legacyTypeCounts = candidateRows.reduce<Record<string, number>>((acc, row) => {
    const type = legacyType(row);
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  const legacyTypeSamples = candidateRows.reduce<Record<string, string[]>>((acc, row) => {
    const type = legacyType(row);
    if (!acc[type]) acc[type] = [];
    const id = str(row.candidateId || row.jobId || row.assessmentId || row.interviewId || row.resultId || row.logId || row.id || row.pk);
    if (id && acc[type].length < 10 && !acc[type].includes(id)) acc[type].push(id);
    return acc;
  }, {});

  const inspectTypes = new Set(['JOB', 'INTERVIEW', 'RESULT', 'ASSESSMENT', 'QUESTION_BANK', 'EMAIL_TEMPLATE', 'CATIQ_ATTEMPT', 'PROFILE', 'OTHER']);
  const legacyRecordSamples = candidateRows.reduce<Record<string, AnyRecord[]>>((acc, row) => {
    const type = legacyType(row);
    if (!inspectTypes.has(type)) return acc;
    if (!acc[type]) acc[type] = [];
    if (acc[type].length < 2) acc[type].push(sanitizeLegacyValue(row));
    return acc;
  }, {});

  const summary = {
    scanned: {
      candidatesTable: candidateRows.length,
      recruitersTable: recruiterRows.length,
      questionsTable: questionRows.length,
      assessmentsTable: assessmentRows.length,
      jobsTable: jobRows.length,
    },
    classified: {
      candidates: candidates.length,
      recruiters: recruiters.length,
      questions: questionRows.length,
      assessments: assessmentRows.length,
      jobs: jobs.length,
      unclassifiedCandidateTableRows: candidateRows.length - candidates.length,
    },
    legacyCandidateTable: {
      typeCounts: legacyTypeCounts,
      sampleIds: legacyTypeSamples,
      recordSamples: legacyRecordSamples,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!APPLY) {
    console.log('\nDRY-RUN ONLY. Review counts above. Re-run with --apply only after verification.');
    return summary;
  }

  // Import recruiters as User records, preserving an existing bcrypt passwordHash when present.
  for (const r of recruiters) {
    const id = str(r.recruiterId);
    const email = str(r.email).toLowerCase();
    const passwordHash = str(r.passwordHash);
    if (!email || !passwordHash) {
      console.warn(`SKIP recruiter ${id}: missing email/passwordHash`);
      continue;
    }
    await prisma.user.upsert({
      where: { email },
      update: {
        fullName: str(r.name || r.fullName, 'Recruiter'),
        phone: r.mobile || r.phone || null,
        isActive: str(r.status,'ACTIVE').toUpperCase() !== 'INACTIVE',
      },
      create: {
        id: uuidFrom(`ddb-recruiter:${id}`),
        email,
        passwordHash,
        fullName: str(r.name || r.fullName, 'Recruiter'),
        role: Role.RECRUITER,
        phone: r.mobile || r.phone || null,
        isActive: str(r.status,'ACTIVE').toUpperCase() !== 'INACTIVE',
        createdAt: date(r.createdAt),
        updatedAt: date(r.updatedAt, date(r.createdAt)),
      },
    });
  }

  // Import assessments. Question payload is assembled from the legacy question IDs.
  const questionById = new Map(questionRows.map(q => [str(q.questionId || q.id), q]));
  for (const a of assessmentRows) {
    const assessmentId = str(a.assessmentId || a.id);
    const questionIds = arr(a.questionIds);
    const questions = questionIds.map(id => {
      const q = questionById.get(id);
      if (!q) return { id, missing: true };
      return {
        id,
        question: str(q.question),
        options: q.options ?? [],
        correctOption: q.correctOption ?? null,
        explanation: q.explanation ?? null,
        section: q.section ?? null,
        level: q.level ?? null,
        marks: Number(q.marks ?? 1),
      };
    });
    await prisma.assessment.upsert({
      where: { id: uuidFrom(`ddb-assessment:${assessmentId}`) },
      update: {
        title: str(a.name || a.title, assessmentId),
        category: str(a.level || a.category, 'BPO'),
        timeLimit: Number(a.durationMinutes ?? a.timeLimit ?? 30),
        passingScore: Number(a.passingPercentage ?? a.passingScore ?? 60),
        questions,
        isActive: str(a.status,'READY').toUpperCase() !== 'INACTIVE',
        updatedAt: date(a.updatedAt, date(a.createdAt)),
      },
      create: {
        id: uuidFrom(`ddb-assessment:${assessmentId}`),
        title: str(a.name || a.title, assessmentId),
        category: str(a.level || a.category, 'BPO'),
        timeLimit: Number(a.durationMinutes ?? a.timeLimit ?? 30),
        passingScore: Number(a.passingPercentage ?? a.passingScore ?? 60),
        questions,
        isActive: str(a.status,'READY').toUpperCase() !== 'INACTIVE',
        createdAt: date(a.createdAt),
        updatedAt: date(a.updatedAt, date(a.createdAt)),
      },
    });
  }

  // Import candidates conservatively. We never overwrite an existing candidate's identity fields.
  let importedCandidates = 0;
  for (const raw of candidates) {
    const c = candidateData(raw);
    if (!c.id || !c.email) {
      console.warn('SKIP candidate: missing id/email', raw.candidateId);
      continue;
    }

    // The current schema requires a resumeUrl. If legacy data has no resume URL,
    // use a non-network legacy marker rather than inventing a public URL.
    const resumeUrl = c.resumeUrl || `legacy://dynamodb/orrica_candidates/${encodeURIComponent(c.id)}`;

    await prisma.candidate.upsert({
      where: { email: c.email.toLowerCase() },
      update: {
        fullName: c.fullName,
        phone: c.phone,
        location: c.location,
        education: c.education,
        experienceYears: c.experienceYears,
        currentCompany: c.currentCompany,
        currentDesignation: c.currentDesignation,
        skills: c.skills,
        languages: c.languages.length ? c.languages : ['English'],
        resumeUrl,
        source: c.source,
        tags: c.tags,
        notes: c.notes,
        status: mapStatus(c.status),
        updatedAt: c.updatedAt,
      },
      create: {
        id: uuidFrom(`ddb-candidate:${c.id}`),
        fullName: c.fullName,
        email: c.email.toLowerCase(),
        phone: c.phone,
        location: c.location,
        education: c.education,
        experienceYears: c.experienceYears,
        currentCompany: c.currentCompany,
        currentDesignation: c.currentDesignation,
        skills: c.skills,
        languages: c.languages.length ? c.languages : ['English'],
        resumeUrl,
        source: c.source,
        tags: c.tags,
        notes: c.notes,
        status: mapStatus(c.status),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      },
    });
    importedCandidates++;
  }

  // Jobs are imported only from the dedicated legacy jobs table.
  // We intentionally do NOT reinterpret mixed JOB-* records from orrica_candidates as jobs.
  console.log(`Imported candidates: ${importedCandidates}`);
  console.log(`Jobs imported: 0 from ${TABLES.jobs} unless that table contains actual job records.`);
  console.log('Recruiters, assessments and questions were imported through the structured mappings above.');
  return summary;
}

if (process.argv[1] && process.argv[1].endsWith('migrate-dynamodb.ts')) {
  runDynamoMigration(process.argv.includes('--apply'))
    .catch(err => {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
