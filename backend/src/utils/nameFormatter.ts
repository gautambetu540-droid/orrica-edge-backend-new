/**
 * Utility for formatting candidate greeting names.
 * Adheres to CRM requirements:
 * - RAHUL SHARMA -> Rahul
 * - rahul sharma -> Rahul
 * - Rahul Sharma -> Rahul
 * - Jean-Luc Picard -> Jean-Luc
 * - A. K. Sharma -> A. K.
 * - Strips honorifics (Mr., Ms., Dr., etc.)
 * - Never modifies database records
 * - Fallback to 'Candidate' if missing or undefined
 */

export function formatCandidateGreetingName(candidateOrName?: any): string {
  if (!candidateOrName) return 'Candidate';

  let raw = '';
  if (typeof candidateOrName === 'string') {
    raw = candidateOrName;
  } else if (typeof candidateOrName === 'object') {
    if (candidateOrName.firstName && typeof candidateOrName.firstName === 'string' && candidateOrName.firstName.trim()) {
      raw = candidateOrName.firstName.trim();
    } else {
      raw = (candidateOrName.fullName || candidateOrName.name || '').trim();
    }
  }

  // Normalize whitespace
  raw = raw.replace(/\s+/g, ' ').trim();
  if (!raw || raw.toLowerCase() === 'undefined' || raw.toLowerCase() === 'null') {
    return 'Candidate';
  }

  // Strip common honorifics
  raw = raw.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '').trim();
  if (!raw) return 'Candidate';

  const titleCaseWord = (w: string): string => {
    return w
      .split('-')
      .map((part) => {
        if (!part) return '';
        if (part.length === 1 || (part.length === 2 && part.endsWith('.'))) {
          return part.toUpperCase();
        }
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .join('-');
  };

  const parts = raw.split(' ');
  const first = parts[0];

  // If first token is single initial e.g. A. or A, and second token exists
  if ((first.length === 1 || (first.length === 2 && first.endsWith('.'))) && parts.length > 1) {
    const second = parts[1];
    if (second.length === 1 || (second.length === 2 && second.endsWith('.'))) {
      return `${titleCaseWord(first)} ${titleCaseWord(second)}`;
    }
  }

  return titleCaseWord(first) || 'Candidate';
}

export function formatCandidateGreeting(candidateOrName?: any): string {
  const name = formatCandidateGreetingName(candidateOrName);
  return `Dear ${name},`;
}
