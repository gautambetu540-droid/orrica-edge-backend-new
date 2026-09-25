// Orrica Edge Intelligent ATS & Resume Matching Engine

export interface AtsMatchResult {
  score: number; // 0 - 100
  matchedSkills: string[];
  missingSkills: string[];
  skillScore: number;
  experienceScore: number;
  locationScore: number;
  languageScore: number;
  matchReason: string;
}

export interface CandidateAttributes {
  skills: string[];
  experienceYears: number;
  location: string;
  languages?: string[];
  education?: string;
  resumeText?: string;
}

export interface JobRequirements {
  skills: string[];
  experienceMin: number;
  experienceMax: number;
  location: string;
  workMode: string;
  languages?: string[];
  eligibilityCriteria?: string;
}

export const analyzeAtsMatch = (
  candidate: CandidateAttributes,
  job: JobRequirements
): AtsMatchResult => {
  const candidateSkillsLower = candidate.skills.map((s) => s.toLowerCase().trim());
  const jobSkillsLower = job.skills.map((s) => s.toLowerCase().trim());

  // 1. Skill Matching (Weight: 50%)
  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];

  if (jobSkillsLower.length === 0) {
    matchedSkills.push(...candidate.skills);
  } else {
    job.skills.forEach((rawSkill) => {
      const s = rawSkill.toLowerCase().trim();
      const isMatched =
        candidateSkillsLower.some((cs) => cs.includes(s) || s.includes(cs)) ||
        (candidate.resumeText && candidate.resumeText.toLowerCase().includes(s));

      if (isMatched) {
        matchedSkills.push(rawSkill);
      } else {
        missingSkills.push(rawSkill);
      }
    });
  }

  const skillScore =
    jobSkillsLower.length > 0
      ? Math.round((matchedSkills.length / jobSkillsLower.length) * 100)
      : 80;

  // 2. Experience Matching (Weight: 25%)
  let experienceScore = 100;
  const candExp = Number(candidate.experienceYears) || 0;
  if (candExp < job.experienceMin) {
    const diff = job.experienceMin - candExp;
    experienceScore = Math.max(30, Math.round(100 - diff * 25));
  } else if (candExp > job.experienceMax + 4) {
    // Slightly overqualified penalty
    experienceScore = 85;
  }

  // 3. Location & Work Mode Matching (Weight: 15%)
  let locationScore = 100;
  const candLoc = candidate.location.toLowerCase();
  const jobLoc = job.location.toLowerCase();

  if (job.workMode === 'REMOTE') {
    locationScore = 100;
  } else if (candLoc.includes(jobLoc) || jobLoc.includes(candLoc)) {
    locationScore = 100;
  } else if (job.workMode === 'HYBRID') {
    locationScore = 75;
  } else {
    locationScore = 50; // May require relocation
  }

  // 4. Language Matching (Weight: 10%)
  let languageScore = 100;
  const candLangs = (candidate.languages || ['English']).map((l) => l.toLowerCase());
  const jobLangs = (job.languages || ['English']).map((l) => l.toLowerCase());

  const matchedLangs = jobLangs.filter((jl) =>
    candLangs.some((cl) => cl.includes(jl) || jl.includes(cl))
  );
  if (jobLangs.length > 0) {
    languageScore = Math.round((matchedLangs.length / jobLangs.length) * 100);
  }

  // Total Weighted Score Calculation
  const totalScore = Math.round(
    skillScore * 0.5 +
      experienceScore * 0.25 +
      locationScore * 0.15 +
      languageScore * 0.1
  );

  const boundedScore = Math.min(99, Math.max(30, totalScore));

  let matchReason = '';
  if (boundedScore >= 85) {
    matchReason = `High alignment: strong skill match (${matchedSkills.length}/${job.skills.length}) and verified experience bracket.`;
  } else if (boundedScore >= 70) {
    matchReason = `Good match: satisfies primary hiring baseline. Missing skills: ${missingSkills.slice(0, 3).join(', ') || 'None'}.`;
  } else {
    matchReason = `Moderate fit: candidate lacks key competencies (${missingSkills.slice(0, 3).join(', ')}). Manual review suggested.`;
  }

  return {
    score: boundedScore,
    matchedSkills,
    missingSkills,
    skillScore,
    experienceScore,
    locationScore,
    languageScore,
    matchReason,
  };
};

// Basic heuristic resume text extractor (extracts email, phone, name, detected skills)
export const extractResumeMetadata = (rawText: string) => {
  const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/i;
  const phoneRegex = /(?:\+?(\d{1,3}))?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{4})(?: *x(\d+))?/;

  const emailMatch = rawText.match(emailRegex);
  const phoneMatch = rawText.match(phoneRegex);

  const extractedEmail = emailMatch ? emailMatch[0] : null;
  const extractedPhone = phoneMatch ? phoneMatch[0] : null;

  // Common recruitment skill keywords dictionary
  const skillKeywords = [
    'customer support',
    'voice process',
    'non-voice',
    'chat support',
    'email support',
    'crm',
    'salesforce',
    'zendesk',
    'communication',
    'active listening',
    'typing speed',
    'excel',
    'microsoft office',
    'operations',
    'bpo',
    'inbound',
    'outbound',
    'escalation handling',
    'client servicing',
  ];

  const lower = rawText.toLowerCase();
  const detectedSkills = skillKeywords.filter((sk) => lower.includes(sk));

  return {
    extractedEmail,
    extractedPhone,
    detectedSkills,
  };
};
