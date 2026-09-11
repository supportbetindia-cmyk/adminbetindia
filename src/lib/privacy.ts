import { createHash } from 'node:crypto';

/**
 * Privacy helpers.
 *
 * Backend Schema §8 and PRD §13 require phone and IP data to be minimised and
 * protected. We never persist a raw IP address: only a salted hash, which is
 * enough to spot abuse patterns but not to re-identify a person.
 *
 * The salt must be a real secret in production. If it leaks, the hashes become
 * reversible for any candidate IP (the space is small enough to brute force).
 */

const SALT = process.env.IP_HASH_SALT ?? '';

if (process.env.NODE_ENV === 'production' && !SALT) {
  throw new Error('IP_HASH_SALT must be set in production');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Salted, truncated hash of an IP address. Returns null when no IP is known. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return sha256(`ip:${SALT}:${ip.trim().toLowerCase()}`).slice(0, 32);
}

/** Salted hash of a first-party visitor token. The raw token stays in the cookie. */
export function hashVisitorToken(token: string | null | undefined): string | null {
  if (!token) return null;
  return sha256(`visitor:${SALT}:${token}`).slice(0, 32);
}

/**
 * Normalises a phone number to E.164-ish form for use as a contact key.
 * Defaults to India (+91) when no country code is present.
 *
 * Note for later phases: Backend Schema §4 warns that a phone number alone is
 * not proof of a click. This produces a join key, not an attribution decision.
 */
export function normalisePhone(raw: string, defaultCountryCode = '91'): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (raw.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  return `+${digits}`;
}
