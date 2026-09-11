/**
 * Authentication service.
 *
 * Kept free of Next.js types so it can be tested directly against the
 * database, in the same style as services/redirect.ts.
 */

import { eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { adminUsers } from '@/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, revokeSession, type IssuedSession, type SessionUser } from '@/lib/auth/session';
import type { AdminRole } from '@/lib/auth/rbac';
import { rateLimit } from '@/lib/rate-limit';
import { writeAudit } from '@/lib/audit';

type Db = typeof Database;

/** Deliberately strict: five attempts per identity and per source, per 15 minutes. */
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export type LoginResult =
  | { status: 'ok'; user: SessionUser; session: IssuedSession }
  | { status: 'invalid_credentials' }
  | { status: 'suspended' }
  | { status: 'rate_limited'; retryAfterSeconds: number };

export interface LoginInput {
  email: string;
  password: string;
  ipHash: string | null;
  userAgent: string | null;
}

export async function login(db: Db, input: LoginInput): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  // Limit on both axes: one identity being guessed, and one source guessing
  // many identities. Either alone leaves an obvious hole.
  for (const key of [`login:email:${email}`, `login:ip:${input.ipHash ?? 'unknown'}`]) {
    const result = rateLimit(key, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    if (!result.allowed) {
      return { status: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds };
    }
  }

  const rows = await db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      role: adminUsers.role,
      status: adminUsers.status,
      passwordHash: adminUsers.passwordHash,
      mfaEnrolled: adminUsers.mfaEnrolled,
    })
    .from(adminUsers)
    .where(eq(sql`lower(${adminUsers.email})`, email))
    .limit(1);

  const row = rows[0];

  // Verify against a dummy hash when the user does not exist, so a missing
  // account and a wrong password take the same time and look the same.
  const ok = await verifyPassword(input.password, row?.passwordHash ?? DUMMY_HASH);
  if (!row || !ok) return { status: 'invalid_credentials' };
  if (row.status !== 'active') return { status: 'suspended' };

  const session = await createSession(db, row.id, {
    userAgent: input.userAgent,
    ipHash: input.ipHash,
  });

  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, row.id));

  const user: SessionUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as AdminRole,
    status: row.status,
    mfaEnrolled: row.mfaEnrolled,
  };

  await writeAudit(db, {
    actor: user,
    action: 'auth.login',
    entityType: 'admin_user',
    entityId: row.id,
    summary: `${row.email} signed in`,
    ipHash: input.ipHash,
  });

  return { status: 'ok', user, session };
}

export async function logout(
  db: Db,
  token: string,
  actor: SessionUser | null,
  ipHash: string | null = null,
): Promise<void> {
  await revokeSession(db, token);
  if (actor) {
    await writeAudit(db, {
      actor,
      action: 'auth.logout',
      entityType: 'admin_user',
      entityId: actor.id,
      summary: `${actor.email} signed out`,
      ipHash,
    });
  }
}

/**
 * A real scrypt hash of a random value, so the "no such user" path performs
 * the same work as the "wrong password" path.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'JmRlY295aGFzaGZvcnRpbWluZ2VxdWFsaXR5MDAwMA==';
