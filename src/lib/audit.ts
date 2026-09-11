/**
 * Audit logging.
 *
 * "Every admin mutation writes an audit_logs row with before/after values"
 * (PRD §13, TRD §6, UI/UX §12). This is the only way a destination change or
 * a permission change can be answered for after the fact.
 *
 * Backend Schema §8: "Never store API credentials in source code or audit
 * logs." Values are therefore redacted by key name before they are written.
 */

import type { db as Database } from '@/db';
import { auditLogs } from '@/db/schema';
import { SYSTEM_USER_ID, type SessionUser } from '@/lib/auth/session';

type Db = typeof Database;

/** Key fragments whose values never reach the audit table. */
const SECRET_KEY_PATTERNS = [
  /password/i, /secret/i, /token/i, /api[_-]?key/i, /credential/i,
  /authorization/i, /signature/i, /private[_-]?key/i, /salt/i,
];

const REDACTED = '[redacted]';

/** Recursive so a secret nested inside a settings object is caught too. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERNS.some((re) => re.test(key)) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export interface AuditInput {
  actor: SessionUser | null;
  action: string;
  entityType: string;
  entityId: string;
  summary?: string | null;
  approvalReference?: string | null;
  before?: unknown;
  after?: unknown;
  ipHash?: string | null;
}

export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  // The system sentinel has no admin_users row; recording it as actor_id would
  // violate the foreign key. The email column still says who acted.
  const actorId =
    input.actor && input.actor.id !== SYSTEM_USER_ID ? input.actor.id : null;

  await db.insert(auditLogs).values({
    actorId,
    actorEmail: input.actor?.email ?? null,
    actorRole: input.actor?.role ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    summary: input.summary ?? null,
    approvalReference: input.approvalReference ?? null,
    beforeData: input.before === undefined ? null : (redact(input.before) as object),
    afterData: input.after === undefined ? null : (redact(input.after) as object),
    ipHash: input.ipHash ?? null,
  });
}

/**
 * Field-level diff for the audit trail. Only what actually changed is stored,
 * so a reviewer reading the log sees the change and not the whole row.
 */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T>; changedKeys: string[] } {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  const changedKeys: string[] = [];

  for (const key of Object.keys(after) as (keyof T)[]) {
    if (!sameValue(before[key], after[key])) {
      b[key] = before[key];
      a[key] = after[key];
      changedKeys.push(String(key));
    }
  }
  return { before: b, after: a, changedKeys };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
    const bt = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
    return Number.isFinite(at) && Number.isFinite(bt) && at === bt;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  return a === b || (a ?? null) === (b ?? null);
}
