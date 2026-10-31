import crypto from 'crypto';

/**
 * Generates a strong 12-14 character temporary password using crypto.randomInt
 * Guaranteed to contain:
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 digit
 * - At least 1 special symbol
 */
export const generateSecureTemporaryPassword = (length: number = 13): string => {
  const targetLength = Math.max(12, Math.min(14, length));
  const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowers = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*_-+=';
  const allChars = uppers + lowers + digits + symbols;

  const passwordChars: string[] = [
    uppers[crypto.randomInt(0, uppers.length)],
    lowers[crypto.randomInt(0, lowers.length)],
    digits[crypto.randomInt(0, digits.length)],
    symbols[crypto.randomInt(0, symbols.length)],
  ];

  for (let i = passwordChars.length; i < targetLength; i++) {
    passwordChars.push(allChars[crypto.randomInt(0, allChars.length)]);
  }

  // Fisher-Yates cryptographically secure shuffle
  for (let i = passwordChars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const temp = passwordChars[i];
    passwordChars[i] = passwordChars[j];
    passwordChars[j] = temp;
  }

  return passwordChars.join('');
};
