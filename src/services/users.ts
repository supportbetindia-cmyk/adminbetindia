/**
 * Admin user management (PRD §3, TRD §14).
 *
 * Only a Super Admin reaches this service. Role and status changes revoke the
 * affected user's live sessions immediately — TRD §14 requires least-privilege
 * access, and a session that keeps its old role until it expires is not that.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { adminUsers } from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';
import { writeAudit } from '@/lib/audit';
import { conflict, notFound, precondition } from '@/lib/errors';
import { hashPassword } from '@/lib/auth/password';
import { revokeAllSessionsForUser } from '@/lib/auth/session';
import type { AdminRole } from '@/lib/auth/rbac';
import { parseInput, userCreateSchema, userUpdateSchema } from '@/lib/validation';

type Db = typeof Database;

/** Never includes password_hash. It has no business leaving the auth path. */
export interface AdminUserView {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
  status: string;
  mfaEnrolled: boolean;
  hasPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const view = {
  id: adminUsers.id,
  email: adminUsers.email,
  name: adminUsers.name,
  role: adminUsers.role,
  status: adminUsers.status,
  mfaEnrolled: adminUsers.mfaEnrolled,
  hasPassword: sql<boolean>`(${adminUsers.passwordHash} is not null)`,
  lastLoginAt: adminUsers.lastLoginAt,
  createdAt: adminUsers.createdAt,
};

export async function listUsers(db: Db, actor: ActorContext): Promise<AdminUserView[]> {
  requirePermission(actor, 'users:read');
  const rows = await db.select(view).from(adminUsers).orderBy(asc(adminUsers.email));
  return rows as AdminUserView[];
}

export async function createUser(db: Db, actor: ActorContext, input: unknown): Promise<AdminUserView> {
  requirePermission(actor, 'users:write');
  const data = parseInput(userCreateSchema, input);

  const [existing] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(sql`lower(${adminUsers.email})`, data.email))
    .limit(1);
  if (existing) throw conflict('That email already has an account.', { email: 'Already in use' });

  const [row] = await db
    .insert(adminUsers)
    .values({
      email: data.email,
      name: data.name,
      role: data.role as AdminRole,
      status: 'active',
      passwordHash: await hashPassword(data.password),
    })
    .returning(view);

  await writeAudit(db, {
    actor: actor.user,
    action: 'user.create',
    entityType: 'admin_user',
    entityId: row.id,
    summary: `Created ${row.email} as ${row.role}`,
    // The password is never in `after`; redact() would catch it, but it should
    // not be assembled into an audit payload in the first place.
    after: { email: row.email, name: row.name, role: row.role, status: row.status },
    ipHash: actor.ipHash,
  });

  return row as AdminUserView;
}

export async function updateUser(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<AdminUserView> {
  requirePermission(actor, 'users:write');
  const data = parseInput(userUpdateSchema, input);

  const [before] = await db.select(view).from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
  if (!before) throw notFound('User');

  // A Super Admin must not be able to lock the platform out of itself.
  if (id === actor.user.id) {
    if (data.status === 'suspended') throw precondition('You cannot suspend your own account.');
    if (data.role && data.role !== before.role) {
      throw precondition('You cannot change your own role. Ask another Super Admin.');
    }
  }
  if (before.role === 'super_admin' && data.role && data.role !== 'super_admin') {
    await assertAnotherSuperAdminRemains(db, id);
  }
  if (before.role === 'super_admin' && data.status === 'suspended') {
    await assertAnotherSuperAdminRemains(db, id);
  }

  const patch: Record<string, unknown> = {};
  const summary: string[] = [];

  if ('name' in (input as object) && data.name !== before.name) {
    patch.name = data.name;
    summary.push('name');
  }
  if (data.role && data.role !== before.role) {
    patch.role = data.role;
    summary.push(`role ${before.role} → ${data.role}`);
  }
  if (data.status && data.status !== before.status) {
    patch.status = data.status;
    summary.push(`status ${before.status} → ${data.status}`);
  }
  if (data.password) {
    patch.passwordHash = await hashPassword(data.password);
    summary.push('password reset');
  }

  if (Object.keys(patch).length === 0) return before as AdminUserView;

  const [after] = await db.update(adminUsers).set(patch).where(eq(adminUsers.id, id)).returning(view);

  // Any of these three changes what the user may do, or whether they may act
  // at all. Existing sessions must not survive it.
  if (patch.role || patch.status || patch.passwordHash) {
    await revokeAllSessionsForUser(db, id);
  }

  await writeAudit(db, {
    actor: actor.user,
    action: 'user.update',
    entityType: 'admin_user',
    entityId: id,
    summary: `${after.email}: ${summary.join(', ')}`,
    before: { role: before.role, status: before.status, name: before.name },
    after: { role: after.role, status: after.status, name: after.name },
    ipHash: actor.ipHash,
  });

  return after as AdminUserView;
}

/** A suspended Super Admin cannot administer anything, so only active ones count. */
async function assertAnotherSuperAdminRemains(db: Db, excludingId: string): Promise<void> {
  const rows = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, 'super_admin'), eq(adminUsers.status, 'active')));
  const remaining = rows.filter((r) => r.id !== excludingId);
  if (remaining.length === 0) {
    throw precondition('This is the last active Super Admin. Promote someone else first.');
  }
}
