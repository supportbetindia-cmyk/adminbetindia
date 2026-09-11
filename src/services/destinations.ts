/**
 * Destination registry and approval workflow.
 *
 * TRD §5: "Use an allowlisted HTTPS destination registry, prevent open
 * redirects and reject arbitrary user-supplied destination URLs." This service
 * is the only way a row enters that registry, and the only way one becomes
 * approved.
 *
 * Approval is separated from creation on purpose: creating a destination is a
 * campaign task, approving one asserts that a publisher has agreed to it in
 * writing (TRD §13). See lib/auth/rbac.ts for which roles hold which.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { destinations, destinationVersions, publishers, smartLinks } from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';
import { diff, writeAudit } from '@/lib/audit';
import { conflict, invalid, notFound, precondition } from '@/lib/errors';
import {
  destinationApproveSchema, destinationCreateSchema, destinationRejectSchema, parseInput,
} from '@/lib/validation';
import { assertSafeDestination, UnsafeDestinationError } from '@/lib/destination-url';

type Db = typeof Database;

export type Destination = typeof destinations.$inferSelect;

export interface DestinationFilter {
  type?: 'website' | 'whatsapp';
  approvalStatus?: Destination['approvalStatus'];
  publisherId?: string;
}

export async function listDestinations(
  db: Db,
  actor: ActorContext,
  filter: DestinationFilter = {},
): Promise<(Destination & { publisherName: string | null; linkCount: number })[]> {
  requirePermission(actor, 'destinations:read');

  const conditions = [
    filter.type ? eq(destinations.type, filter.type) : undefined,
    filter.approvalStatus ? eq(destinations.approvalStatus, filter.approvalStatus) : undefined,
    filter.publisherId ? eq(destinations.publisherId, filter.publisherId) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({ destination: destinations, publisherName: publishers.name })
    .from(destinations)
    .leftJoin(publishers, eq(publishers.id, destinations.publisherId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(destinations.createdAt));

  if (rows.length === 0) return [];

  // How many links currently point at each destination — a destination in use
  // must not be quietly repurposed.
  const usage = await db
    .select({ destinationId: smartLinks.activeDestinationId })
    .from(smartLinks)
    .where(inArray(smartLinks.activeDestinationId, rows.map((r) => r.destination.id)));

  const counts = new Map<string, number>();
  for (const u of usage) {
    if (u.destinationId) counts.set(u.destinationId, (counts.get(u.destinationId) ?? 0) + 1);
  }

  return rows.map((r) => ({
    ...r.destination,
    publisherName: r.publisherName,
    linkCount: counts.get(r.destination.id) ?? 0,
  }));
}

export async function getDestination(db: Db, actor: ActorContext, id: string): Promise<Destination> {
  requirePermission(actor, 'destinations:read');
  const [row] = await db.select().from(destinations).where(eq(destinations.id, id)).limit(1);
  if (!row) throw notFound('Destination');
  return row;
}

export async function createDestination(
  db: Db,
  actor: ActorContext,
  input: unknown,
): Promise<Destination> {
  requirePermission(actor, 'destinations:write');
  const data = parseInput(destinationCreateSchema, input);

  assertUrlUsable(data.url, data.type);

  // The same URL approved twice is two records that can drift apart. Reuse the
  // existing one rather than creating a second.
  const [existing] = await db
    .select()
    .from(destinations)
    .where(and(eq(destinations.url, data.url), eq(destinations.type, data.type)))
    .limit(1);
  if (existing) {
    throw conflict('That destination URL is already in the registry.', { url: 'Already registered' });
  }

  const [row] = await db
    .insert(destinations)
    .values({
      label: data.label,
      type: data.type,
      url: data.url,
      publisherId: data.publisherId ?? null,
      approvalReference: data.approvalReference,
      approvalNotes: data.approvalNotes,
      approvalStatus: 'pending',
      createdBy: actor.user.id,
    })
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: 'destination.create',
    entityType: 'destination',
    entityId: row.id,
    summary: `Registered ${row.type} destination ${row.url} (pending approval)`,
    approvalReference: row.approvalReference,
    after: row,
    ipHash: actor.ipHash,
  });

  return row;
}

export async function approveDestination(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<Destination> {
  requirePermission(actor, 'destinations:approve');
  const data = parseInput(destinationApproveSchema, input);

  const [before] = await db.select().from(destinations).where(eq(destinations.id, id)).limit(1);
  if (!before) throw notFound('Destination');
  if (before.approvalStatus === 'approved') return before;

  // Re-check at approval time. The allowlist may have changed since the row
  // was created, and approval is the point at which traffic becomes possible.
  assertUrlUsable(before.url, before.type);

  const [after] = await db
    .update(destinations)
    .set({
      approvalStatus: 'approved',
      approvalReference: data.approvalReference,
      approvalNotes: data.approvalNotes ?? before.approvalNotes,
      approvedBy: actor.user.id,
      approvedAt: new Date(),
    })
    .where(eq(destinations.id, id))
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: 'destination.approve',
    entityType: 'destination',
    entityId: id,
    summary: `Approved ${after.type} destination ${after.url}`,
    approvalReference: data.approvalReference,
    before: { approvalStatus: before.approvalStatus },
    after: { approvalStatus: after.approvalStatus, approvalReference: after.approvalReference },
    ipHash: actor.ipHash,
  });

  return after;
}

export async function rejectDestination(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<Destination> {
  requirePermission(actor, 'destinations:approve');
  const data = parseInput(destinationRejectSchema, input);
  return setUnapproved(db, actor, id, 'rejected', data.approvalNotes);
}

/**
 * Withdraws an approval that has already been granted.
 *
 * Links pointing at it stop redirecting immediately — the redirect engine
 * requires `approved` on every request. That is the intended behaviour: a
 * withdrawn approval means traffic must stop, not continue until someone
 * notices.
 */
export async function revokeDestination(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<Destination> {
  requirePermission(actor, 'destinations:approve');
  const data = parseInput(destinationRejectSchema, input);
  return setUnapproved(db, actor, id, 'revoked', data.approvalNotes);
}

async function setUnapproved(
  db: Db,
  actor: ActorContext,
  id: string,
  status: 'rejected' | 'revoked',
  notes: string,
): Promise<Destination> {
  const [before] = await db.select().from(destinations).where(eq(destinations.id, id)).limit(1);
  if (!before) throw notFound('Destination');

  const [after] = await db
    .update(destinations)
    .set({ approvalStatus: status, approvalNotes: notes, approvedBy: null, approvedAt: null })
    .where(eq(destinations.id, id))
    .returning();

  const affected = await db
    .select({ slug: smartLinks.slug })
    .from(smartLinks)
    .where(eq(smartLinks.activeDestinationId, id));

  await writeAudit(db, {
    actor: actor.user,
    action: `destination.${status}`,
    entityType: 'destination',
    entityId: id,
    summary:
      `${status === 'rejected' ? 'Rejected' : 'Revoked approval for'} ${after.url}` +
      (affected.length ? ` — ${affected.length} link(s) stop redirecting: ${affected.map((a) => a.slug).join(', ')}` : ''),
    before: { approvalStatus: before.approvalStatus },
    after: { approvalStatus: after.approvalStatus, approvalNotes: notes },
    ipHash: actor.ipHash,
  });

  return after;
}

export async function updateDestination(
  db: Db,
  actor: ActorContext,
  id: string,
  input: { label?: string | null; approvalNotes?: string | null },
): Promise<Destination> {
  requirePermission(actor, 'destinations:write');

  const [before] = await db.select().from(destinations).where(eq(destinations.id, id)).limit(1);
  if (!before) throw notFound('Destination');

  // The URL is deliberately immutable. Editing it in place would silently
  // change where historical clicks were sent, which Backend Schema §3 forbids.
  // Register a new destination and move the link instead.
  const patch = {
    label: input.label ?? before.label,
    approvalNotes: input.approvalNotes ?? before.approvalNotes,
  };
  const changes = diff(before as Record<string, unknown>, patch);
  if (changes.changedKeys.length === 0) return before;

  const [after] = await db
    .update(destinations)
    .set(patch)
    .where(eq(destinations.id, id))
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: 'destination.update',
    entityType: 'destination',
    entityId: id,
    summary: `Updated ${changes.changedKeys.join(', ')}`,
    before: changes.before,
    after: changes.after,
    ipHash: actor.ipHash,
  });

  return after;
}

/** Approved destinations only — what the link form is allowed to offer. */
export async function listApprovedDestinations(
  db: Db,
  actor: ActorContext,
  publisherId?: string,
): Promise<Destination[]> {
  requirePermission(actor, 'destinations:read');
  const rows = await db
    .select()
    .from(destinations)
    .where(eq(destinations.approvalStatus, 'approved'))
    .orderBy(desc(destinations.approvedAt));

  // A publisher-scoped destination belongs to that publisher alone; unscoped
  // rows are shared.
  return publisherId
    ? rows.filter((r) => r.publisherId === null || r.publisherId === publisherId)
    : rows;
}

/** Version history for one link (UI/UX §7 "view history"). */
export async function listDestinationHistory(db: Db, actor: ActorContext, smartLinkId: string) {
  requirePermission(actor, 'links:read');
  return db
    .select({
      version: destinationVersions.version,
      effectiveAt: destinationVersions.effectiveAt,
      approvalReference: destinationVersions.approvalReference,
      changedBy: destinationVersions.changedBy,
      destinationId: destinations.id,
      url: destinations.url,
      type: destinations.type,
      approvalStatus: destinations.approvalStatus,
    })
    .from(destinationVersions)
    .innerJoin(destinations, eq(destinations.id, destinationVersions.destinationId))
    .where(eq(destinationVersions.smartLinkId, smartLinkId))
    .orderBy(desc(destinationVersions.version));
}

/**
 * Same check the redirect engine runs, applied before a URL can be stored or
 * approved — so an unusable destination is refused at the point a person can
 * still fix it, rather than at 3am on the redirect path.
 */
function assertUrlUsable(url: string, type: 'website' | 'whatsapp'): void {
  let parsed: URL;
  try {
    parsed = assertSafeDestination(url);
  } catch (err) {
    if (err instanceof UnsafeDestinationError) {
      throw precondition(err.message, { url: err.message });
    }
    throw err;
  }

  const isWhatsAppHost = /(^|\.)(wa\.me|api\.whatsapp\.com|whatsapp\.com)$/i.test(parsed.hostname);
  if (type === 'whatsapp' && !isWhatsAppHost) {
    throw invalid('A WhatsApp destination must be a wa.me or api.whatsapp.com link.', {
      url: 'Not a WhatsApp link',
    });
  }
  if (type === 'website' && isWhatsAppHost) {
    throw invalid('That is a WhatsApp link. Choose the WhatsApp destination type.', {
      type: 'Should be WhatsApp',
    });
  }
}
