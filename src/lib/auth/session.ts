/**
 * Session issue, lookup and revocation.
 *
 * Free of Next.js types so it can be tested directly against the database.
 * The cookie plumbing lives in lib/auth/cookies.ts.
 */

import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { adminSessions, adminUsers } from '@/db/schema';
import type { AdminRole } from './rbac';

type Db = typeof Database;

export const SESSION_COOKIE = 'bi_admin_session';
/** Idle-independent absolute lifetime. Re-authentication is cheap; a stale privileged session is not. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
  status: string;
  mfaEnrolled: boolean;
}

/**
 * Sentinel for work with no signed-in user behind it (seeds, scheduled jobs).
 * There is deliberately no `admin_users` row with this id, so audit rows written
 * by the system carry a null actor_id and an explicit actor_email instead of
 * being attributed to a real person.
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** Only the hash is stored, so a database leak does not yield usable sessions. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(`session:${token}`).digest('hex');
}

export async function createSession(
  db: Db,
  userId: string,
  meta: { userAgent?: string | null; ipHash?: string | null } = {},
): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(adminSessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
    ipHash: meta.ipHash ?? null,
  });

  return { token, expiresAt };
}

/**
 * Resolves a cookie token to a live user.
 *
 * Returns null for an expired, revoked, unknown or suspended session. The role
 * comes from the user row on every request, so a role change or suspension
 * applies to sessions that already exist.
 */
export async function resolveSession(db: Db, token: string | null | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const rows = await db
    .select({
      sessionId: adminSessions.id,
      expiresAt: adminSessions.expiresAt,
      revokedAt: adminSessions.revokedAt,
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      role: adminUsers.role,
      status: adminUsers.status,
      mfaEnrolled: adminUsers.mfaEnrolled,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
    .where(eq(adminSessions.tokenHash, hashSessionToken(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (row.status !== 'active') return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as AdminRole,
    status: row.status,
    mfaEnrolled: row.mfaEnrolled,
  };
}

export async function touchSession(db: Db, token: string): Promise<void> {
  await db
    .update(adminSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(adminSessions.tokenHash, hashSessionToken(token)));
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminSessions.tokenHash, hashSessionToken(token)), isNull(adminSessions.revokedAt)));
}

/** Used when a user is suspended or their role changes. */
export async function revokeAllSessionsForUser(db: Db, userId: string): Promise<void> {
  await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminSessions.userId, userId), isNull(adminSessions.revokedAt)));
}

/** Housekeeping: drop rows that can no longer authenticate anything. */
export async function purgeDeadSessions(db: Db, now = new Date()): Promise<void> {
  await db
    .delete(adminSessions)
    .where(or(lt(adminSessions.expiresAt, now), lt(adminSessions.revokedAt, now)));
}
