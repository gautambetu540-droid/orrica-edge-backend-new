import crypto from 'crypto';
import { config } from '../config';

const PREFIX = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

const getKey = (): Buffer => {
  const configuredKey = config.mfa.encryptionKey.trim();

  if (!configuredKey) {
    throw new Error('MFA_ENCRYPTION_KEY is required to encrypt MFA secrets.');
  }

  // Derive a fixed 256-bit key from the configured secret.
  return crypto.createHash('sha256').update(configuredKey, 'utf8').digest().subarray(0, KEY_LENGTH);
};

export const encryptMfaSecret = (secret: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    PREFIX,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
};

export const decryptMfaSecret = (storedSecret: string): {
  secret: string;
  legacy: boolean;
} => {
  if (!storedSecret.startsWith(`${PREFIX}:`)) {
    // Backward compatibility for MFA secrets created before encryption was added.
    return { secret: storedSecret, legacy: true };
  }

  const parts = storedSecret.split(':');

  if (parts.length !== 4) {
    throw new Error('Invalid encrypted MFA secret format.');
  }

  const [, ivEncoded, authTagEncoded, encryptedEncoded] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivEncoded, 'base64url')
  );

  decipher.setAuthTag(Buffer.from(authTagEncoded, 'base64url'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');

  if (!decrypted) {
    throw new Error('Decrypted MFA secret is empty.');
  }

  return { secret: decrypted, legacy: false };
};
