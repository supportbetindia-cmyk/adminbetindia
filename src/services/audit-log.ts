/**
 * Reading the audit trail (UI/UX §12).
 *
 * Read-only by design. There is no update or delete path for an audit row
 * anywhere in the codebase — a trail that can be edited answers nothing.
 */

import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { auditLogs } from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';

type Db = typeof Database;

export type AuditLog = typeof auditLogs.$inferSelect;

export interface AuditFilter {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  data: AuditLog[];
  total: number;
  limit: number;
  offset: number;
}

export async function listAuditLogs(
  db: Db,
  actor: ActorContext,
  filter: AuditFilter = {},
): Promise<AuditPage> {
  requirePermission(actor, 'audit:read');

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);

  const conditions = [
    filter.entityType ? eq(auditLogs.entityType, filter.entityType) : undefined,
    filter.entityId ? eq(auditLogs.entityId, filter.entityId) : undefined,
    filter.actorId ? eq(auditLogs.actorId, filter.actorId) : undefined,
    // Prefix match so "destination" finds destination.approve, .reject, .revoke.
    filter.action ? sql`${auditLogs.action} like ${`${filter.action}%`}` : undefined,
  ].filter(Boolean);

  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [totalRow]] = await Promise.all([
    db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.occurredAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);

  return { data: rows, total: Number(totalRow?.total ?? 0), limit, offset };
}

/** Everything recorded against one entity, for a detail drawer. */
export async function entityHistory(
  db: Db,
  actor: ActorContext,
  entityType: string,
  entityId: string,
): Promise<AuditLog[]> {
  requirePermission(actor, 'audit:read');
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)))
    .orderBy(desc(auditLogs.occurredAt))
    .limit(200);
}

/** Distinct action names, for the filter dropdown. */
export async function listAuditActions(db: Db, actor: ActorContext): Promise<string[]> {
  requirePermission(actor, 'audit:read');
  const rows = await db
    .selectDistinct({ action: auditLogs.action })
    .from(auditLogs)
    .orderBy(auditLogs.action);
  return rows.map((r) => r.action);
}
