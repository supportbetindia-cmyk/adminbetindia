import { randomBytes } from 'node:crypto';

/**
 * Click IDs must be cryptographically random (TRD §5) — they must not be
 * guessable, enumerable, or derived from anything about the user.
 *
 * 16 random bytes rendered base64url gives 22 URL-safe characters and 128 bits
 * of entropy, so collisions are not a practical concern. The UNIQUE constraint
 * on click_events.click_id is the backstop.
 */
export function generateClickId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * First-party visitor token. Used only to produce a deduplicated *estimate* of
 * unique visitors — never treated as proof of a person (TRD §7, §11).
 */
export function generateVisitorToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Short, human-safe campaign reference placed in a WhatsApp prefilled message.
 * Uppercase and unambiguous so it survives being retyped or partially quoted.
 */
export function generateCampaignReference(prefix = 'BI'): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}-${out}`;
}
