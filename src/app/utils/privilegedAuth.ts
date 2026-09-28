import crypto from 'crypto';
import config from '../../config';

export const SYSTEM_PRIVILEGED_ACTOR_ID = 'SYSTEM_PRIVILEGED_ACCESS';

/**
 * Validates whether the incoming token matches the configured secret administrative token.
 * Uses timingSafeEqual to guard against timing side-channel attacks.
 * Supports comma-separated tokens in SECRET_ADMIN_TOKEN for zero-downtime rotation.
 */
export const validatePrivilegedToken = (
  providedToken: string | undefined | null,
): boolean => {
  if (!config.allow_privileged_access) {
    return false;
  }

  const configuredTokenString = config.secret_admin_token?.trim();
  if (!configuredTokenString || !providedToken) {
    return false;
  }

  const cleanProvided = String(providedToken).trim();
  if (!cleanProvided) {
    return false;
  }

  // Token rotation support: comma-delimited tokens allowed
  const allowedTokens = configuredTokenString
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (allowedTokens.length === 0) {
    return false;
  }

  const providedBuffer = Buffer.from(cleanProvided);

  for (const token of allowedTokens) {
    const candidateBuffer = Buffer.from(token);
    if (
      providedBuffer.length === candidateBuffer.length &&
      crypto.timingSafeEqual(providedBuffer, candidateBuffer)
    ) {
      return true;
    }
  }

  return false;
};
