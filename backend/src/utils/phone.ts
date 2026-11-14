/**
 * Single Source of Truth for Indian Phone Number Normalization & Validation.
 * Standardizes all incoming candidate & user phone numbers across Orrica Edge.
 */

/**
 * Normalizes an Indian phone number to exactly 10 digits starting with 6-9.
 * Strips "+91", country code "91", leading "0", spaces, hyphens, and Excel formatting artifacts.
 *
 * @param rawPhone Any string or number input
 * @returns 10-digit phone string (e.g. "9876543210") or null if invalid
 */
export function normalizeIndianPhone(rawPhone: any): string | null {
  if (rawPhone === null || rawPhone === undefined) {
    return null;
  }

  let str = String(rawPhone).trim();
  if (!str) return null;

  // Guard against scientific notation corruption from Excel (e.g. "9.87654E+09")
  if (/^[0-9]+(\.[0-9]+)?[eE]\+[0-9]+$/.test(str)) {
    try {
      const num = Number(str);
      if (!isNaN(num)) {
        str = BigInt(Math.round(num)).toString();
      }
    } catch {
      return null;
    }
  }

  // Strip all non-digit characters
  let digits = str.replace(/\D/g, '');

  // Strip leading 0 (e.g. 09876543210 -> 9876543210)
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Strip country code 91 if present (e.g. 919876543210 -> 9876543210)
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }

  // Must be exactly 10 digits and start with 6, 7, 8, or 9
  if (/^[6-9]\d{9}$/.test(digits)) {
    return digits;
  }

  return null;
}

/**
 * Validates if a given input is a valid 10-digit Indian mobile number.
 */
export function isValidIndianPhone(rawPhone: any): boolean {
  return normalizeIndianPhone(rawPhone) !== null;
}

/**
 * Formats a phone number for display (e.g. "+91 98765 43210").
 */
export function formatIndianPhone(rawPhone: any): string {
  const normalized = normalizeIndianPhone(rawPhone);
  if (normalized) {
    return `+91 ${normalized.slice(0, 5)} ${normalized.slice(5)}`;
  }
  return String(rawPhone || '').trim();
}

