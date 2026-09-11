/**
 * Publisher management.
 *
 * A publisher record is where PRD §11 and TRD §13 land: what this publisher
 * has approved in writing. Every field defaults to "not approved", because
 * "Never assume a macro, script or postback is supported" (PRD §11) is only
 * enforceable if the absence of a recorded approval is itself a state.
 */

import { asc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { campaigns, publishers } from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';
import { diff, writeAudit } from '@/lib/audit';
import { notFound } from '@/lib/errors';
import { parseInput, publisherCreateSchema, publisherUpdateSchema } from '@/lib/validation';

type Db = typeof Database;

export type Publisher = typeof publishers.$inferSelect;

export interface PublisherListRow extends Publisher {
  campaignCount: number;
}

export async function listPublishers(db: Db, actor: ActorContext): Promise<PublisherListRow[]> {
  requirePermission(actor, 'publishers:read');

  const rows = await db
    .select({
      publisher: publishers,
      campaignCount: sql<number>`count(${campaigns.id})::int`,
    })
    .from(publishers)
    .leftJoin(campaigns, eq(campaigns.publisherId, publishers.id))
    .groupBy(publishers.id)
    .orderBy(asc(publishers.name));

  return rows.map((r) => ({ ...r.publisher, campaignCount: r.campaignCount }));
}

export async function getPublisher(db: Db, actor: ActorContext, id: string): Promise<Publisher> {
  requirePermission(actor, 'publishers:read');
  const [row] = await db.select().from(publishers).where(eq(publishers.id, id)).limit(1);
  if (!row) throw notFound('Publisher');
  return row;
}

export async function createPublisher(
  db: Db,
  actor: ActorContext,
  input: unknown,
): Promise<Publisher> {
  requirePermission(actor, 'publishers:write');
  const data = parseInput(publisherCreateSchema, input);

  const [row] = await db
    .insert(publishers)
    .values({ ...data, createdBy: actor.user.id, updatedAt: new Date() })
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: 'publisher.create',
    entityType: 'publisher',
    entityId: row.id,
    summary: `Created publisher "${row.name}"`,
    approvalReference: row.approvalEvidence,
    after: row,
    ipHash: actor.ipHash,
  });

  return row;
}

export async function updatePublisher(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<Publisher> {
  requirePermission(actor, 'publishers:write');
  const data = parseInput(publisherUpdateSchema, input);

  const [before] = await db.select().from(publishers).where(eq(publishers.id, id)).limit(1);
  if (!before) throw notFound('Publisher');

  const changes = diff(before as Record<string, unknown>, data as Record<string, unknown>);
  if (changes.changedKeys.length === 0) return before;

  const [after] = await db
    .update(publishers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(publishers.id, id))
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: 'publisher.update',
    entityType: 'publisher',
    entityId: id,
    summary: `Updated ${changes.changedKeys.join(', ')} on "${after.name}"`,
    approvalReference: after.approvalEvidence,
    before: changes.before,
    after: changes.after,
    ipHash: actor.ipHash,
  });

  return after;
}

/**
 * Whether this publisher has approved the given destination type in writing.
 *
 * Called before a campaign using that type can be activated. TRD §13: "Only
 * enable capabilities explicitly approved by the publisher."
 */
export function publisherPermits(
  publisher: Pick<Publisher, 'eligibility' | 'permittedDestinationTypes' | 'trackingUrlApproved' | 'status'>,
  destinationType: 'website' | 'whatsapp',
): { permitted: true } | { permitted: false; reason: string } {
  if (publisher.status !== 'active') {
    return { permitted: false, reason: 'The publisher is not active.' };
  }
  if (publisher.eligibility === 'ineligible') {
    return { permitted: false, reason: 'This publisher is marked ineligible (TRD §13).' };
  }
  if (publisher.eligibility === 'unconfirmed') {
    return {
      permitted: false,
      reason: 'Publisher eligibility is unconfirmed. Record the approval before activating.',
    };
  }
  if (!publisher.trackingUrlApproved) {
    return {
      permitted: false,
      reason: 'The publisher has not approved the tracking URL in writing (PRD §11).',
    };
  }
  if (!publisher.permittedDestinationTypes.includes(destinationType)) {
    return {
      permitted: false,
      reason: `The publisher has not approved a ${destinationType} destination.`,
    };
  }
  return { permitted: true };
}
