/**
 * Candidate data masking utility for role-based security (e.g., SUB_ADMIN).
 * Enforces server-side sanitization so raw emails and phone numbers never reach unauthorized roles.
 */

export const MASK_PHONE_BULLETS = '••••';
export const MASK_EMAIL_BULLETS = '•••••';

/**
 * Mask candidate phone number.
 * Displays only the last 6 digits (e.g., ••••543210).
 */
export function maskPhone(phone?: string | null): string {
  if (!phone || typeof phone !== 'string') return '';
  const trimmed = phone.trim();
  if (!trimmed) return '';

  // Extract digits for standard formatting, or take last 6 characters
  const cleanDigits = trimmed.replace(/\D/g, '');
  if (cleanDigits.length >= 6) {
    const last6 = cleanDigits.slice(-6);
    return `${MASK_PHONE_BULLETS}${last6}`;
  }

  // If fewer than 6 digits, show available digits with bullets prefix
  return `${MASK_PHONE_BULLETS}${cleanDigits || trimmed}`;
}

/**
 * Mask candidate email address.
 * Displays the first 2 characters + bullets + domain (e.g., ab•••••@gmail.com).
 */
export function maskEmail(email?: string | null): string {
  if (!email || typeof email !== 'string') return '';
  const trimmed = email.trim();
  if (!trimmed || !trimmed.includes('@')) return '';

  const [localPart, domain] = trimmed.split('@');
  if (!domain) return '';

  const prefix = localPart.slice(0, 2);
  return `${prefix}${MASK_EMAIL_BULLETS}@${domain}`;
}

/**
 * Mask a candidate object for a specific user role.
 * Only SUB_ADMIN is masked; ADMIN, RECRUITER, etc. receive full values.
 */
export function maskCandidateForRole<T = any>(candidate: T, role?: string): T {
  if (!candidate || typeof candidate !== 'object') return candidate;
  if (role !== 'SUB_ADMIN') return candidate;

  // Shallow copy object so original reference is not mutated unexpectedly
  const masked: any = Array.isArray(candidate) ? [...candidate] : { ...candidate };

  if ('phone' in masked && masked.phone) {
    masked.phone = maskPhone(masked.phone);
  }
  if ('mobile' in masked && masked.mobile) {
    masked.mobile = maskPhone(masked.mobile);
  }
  if ('email' in masked && masked.email) {
    masked.email = maskEmail(masked.email);
  }
  if ('candidateEmail' in masked && masked.candidateEmail) {
    masked.candidateEmail = maskEmail(masked.candidateEmail);
  }
  if ('candidatePhone' in masked && masked.candidatePhone) {
    masked.candidatePhone = maskPhone(masked.candidatePhone);
  }

  // Nested candidate objects (e.g., in Application, Interview, WalkIn, or Activity records)
  if (masked.candidate && typeof masked.candidate === 'object') {
    masked.candidate = maskCandidateForRole(masked.candidate, role);
  }

  // Applications list attached to candidate
  if (Array.isArray(masked.applications)) {
    masked.applications = masked.applications.map((app: any) => {
      if (app && typeof app === 'object') {
        const appCopy = { ...app };
        if (appCopy.candidate && typeof appCopy.candidate === 'object') {
          appCopy.candidate = maskCandidateForRole(appCopy.candidate, role);
        }
        return appCopy;
      }
      return app;
    });
  }

  return masked;
}

/**
 * Mask an array of candidates for a specific user role.
 */
export function maskCandidatesListForRole<T = any>(candidates: T[], role?: string): T[] {
  if (!Array.isArray(candidates)) return [];
  if (role !== 'SUB_ADMIN') return candidates;
  return candidates.map((c) => maskCandidateForRole(c, role));
}
