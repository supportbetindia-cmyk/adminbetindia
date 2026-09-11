/**
 * Smart link management.
 *
 * The two rules this service exists to enforce:
 *
 *  - A link points at exactly one approved destination, and a destination
 *    change creates an immutable new version rather than editing the old one
 *    (UI/UX §6, Backend Schema §3). Historical clicks keep pointing at the
 *    version that was live when they happened.
 *  - There is no delete. UI/UX §7: "Never expose a delete action that destroys
 *    historical attribution." Ending a link is the terminal state.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import {
  campaigns, clickEvents, creatives, destinations, destinationVersions, publishers, smartLinks,
} from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';
import { diff, writeAudit } from '@/lib/audit';
import { conflict, notFound, precondition } from '@/lib/errors';
import {
  parseInput, smartLinkCreateSchema, smartLinkDestinationChangeSchema, smartLinkUpdateSchema,
} from '@/lib/validation';
import { buildRedirectUrl } from '@/lib/destination-url';
import { publisherPermits } from './publishers';
import { pickProvided } from './campaigns';

type Db = typeof Database;

export type SmartLink = typeof smartLinks.$inferSelect;

export interface SmartLinkRow extends SmartLink {
  campaignName: string;
  publisherId: string;
  publisherName: string;
  creativeName: string | null;
  destinationUrl: string | null;
  destinationApproval: string | null;
  clickCount: number;
  shortUrl: string;
}

export interface SmartLinkFilter {
  id?: string;
  campaignId?: string;
  publisherId?: string;
  status?: SmartLink['status'];
}

/** Base of the public redirect domain. Configured, never derived from a request. */
export function shortUrlBase(): string {
  return (process.env.SMART_LINK_BASE_URL ?? 'https://go.betindia.bet').replace(/\/+$/, '');
}

export function shortUrlFor(slug: string): string {
  return `${shortUrlBase()}/c/${slug}`;
}

export async function listSmartLinks(
  db: Db,
  actor: ActorContext,
  filter: SmartLinkFilter = {},
): Promise<SmartLinkRow[]> {
  requirePermission(actor, 'links:read');

  const conditions = [
    filter.id ? eq(smartLinks.id, filter.id) : undefined,
    filter.campaignId ? eq(smartLinks.campaignId, filter.campaignId) : undefined,
    filter.publisherId ? eq(campaigns.publisherId, filter.publisherId) : undefined,
    filter.status ? eq(smartLinks.status, filter.status) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      link: smartLinks,
      campaignName: campaigns.name,
      publisherId: publishers.id,
      publisherName: publishers.name,
      creativeName: creatives.name,
      destinationUrl: destinations.url,
      destinationApproval: destinations.approvalStatus,
      clickCount: sql<number>`count(${clickEvents.id})::int`,
    })
    .from(smartLinks)
    .innerJoin(campaigns, eq(campaigns.id, smartLinks.campaignId))
    .innerJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .leftJoin(creatives, eq(creatives.id, smartLinks.creativeId))
    .leftJoin(destinations, eq(destinations.id, smartLinks.activeDestinationId))
    .leftJoin(clickEvents, eq(clickEvents.smartLinkId, smartLinks.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(
      smartLinks.id, campaigns.name, publishers.id, publishers.name,
      creatives.name, destinations.url, destinations.approvalStatus,
    )
    .orderBy(desc(smartLinks.createdAt));

  return rows.map((r) => ({
    ...r.link,
    campaignName: r.campaignName,
    publisherId: r.publisherId,
    publisherName: r.publisherName,
    creativeName: r.creativeName,
    destinationUrl: r.destinationUrl,
    destinationApproval: r.destinationApproval,
    clickCount: r.clickCount,
    shortUrl: shortUrlFor(r.link.slug),
  }));
}

export async function getSmartLink(db: Db, actor: ActorContext, id: string): Promise<SmartLinkRow> {
  const [row] = await listSmartLinks(db, actor, { id });
  if (!row) throw notFound('Smart link');
  return row;
}

export async function isSlugAvailable(db: Db, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: smartLinks.id })
    .from(smartLinks)
    .where(eq(smartLinks.slug, slug))
    .limit(1);
  return !row;
}

export async function createSmartLink(
  db: Db,
  actor: ActorContext,
  input: unknown,
): Promise<SmartLink> {
  requirePermission(actor, 'links:write');
  const data = parseInput(smartLinkCreateSchema, input);

  const [campaign] = await db
    .select({ campaign: campaigns, publisher: publishers })
    .from(campaigns)
    .innerJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .where(eq(campaigns.id, data.campaignId))
    .limit(1);
  if (!campaign) throw notFound('Campaign');

  const destination = await requireApprovedDestination(db, data.destinationId);

  if (destination.publisherId && destination.publisherId !== campaign.publisher.id) {
    throw precondition('That destination is registered to a different publisher.');
  }

  if (data.creativeId) {
    const [creative] = await db
      .select({ id: creatives.id, campaignId: creatives.campaignId })
      .from(creatives)
      .where(eq(creatives.id, data.creativeId))
      .limit(1);
    if (!creative) throw notFound('Creative');
    if (creative.campaignId !== data.campaignId) {
      throw precondition('That creative belongs to a different campaign.');
    }
  }

  if (!(await isSlugAvailable(db, data.slug))) {
    throw conflict('That slug is already in use.', { slug: 'Already taken' });
  }

  // Link and its first destination version are written together: a link with
  // no version cannot resolve, and a version with no link is orphaned.
  const created = await db.transaction(async (tx) => {
    const [link] = await tx
      .insert(smartLinks)
      .values({
        campaignId: data.campaignId,
        creativeId: data.creativeId ?? null,
        slug: data.slug,
        destinationType: destination.type,
        activeDestinationId: destination.id,
        activeDestinationVersion: 1,
        status: 'draft',
        expiresAt: data.expiresAt,
        notes: data.notes,
        createdBy: actor.user.id,
        updatedAt: new Date(),
      })
      .returning();

    await tx.insert(destinationVersions).values({
      smartLinkId: link.id,
      destinationId: destination.id,
      version: 1,
      changedBy: actor.user.id,
      approvalReference: destination.approvalReference,
    });

    return link;
  });

  await writeAudit(db, {
    actor: actor.user,
    action: 'smart_link.create',
    entityType: 'smart_link',
    entityId: created.id,
    summary: `Created /c/${created.slug} → ${destination.url} (v1, draft)`,
    approvalReference: destination.approvalReference,
    after: created,
    ipHash: actor.ipHash,
  });

  return created;
}

export async function updateSmartLink(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<SmartLink> {
  requirePermission(actor, 'links:write');
  const data = parseInput(smartLinkUpdateSchema, input);

  const [before] = await db.select().from(smartLinks).where(eq(smartLinks.id, id)).limit(1);
  if (!before) throw notFound('Smart link');

  if (data.status && data.status !== before.status) {
    await assertLinkStatusAllowed(db, before, data.status);
  }

  const patch = pickProvided(data as Record<string, unknown>, input);
  const changes = diff(before as Record<string, unknown>, patch);
  if (changes.changedKeys.length === 0) return before;

  const [after] = await db
    .update(smartLinks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(smartLinks.id, id))
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: data.status && data.status !== before.status ? 'smart_link.status_change' : 'smart_link.update',
    entityType: 'smart_link',
    entityId: id,
    summary: `Updated ${changes.changedKeys.join(', ')} on /c/${after.slug}`,
    before: changes.before,
    after: changes.after,
    ipHash: actor.ipHash,
  });

  return after;
}

/**
 * Points a link at a different approved destination.
 *
 * Appends a new `destination_versions` row and moves the link's pointer.
 * Nothing about the previous version is modified, so every click already
 * recorded still resolves to the destination it actually used.
 */
export async function changeSmartLinkDestination(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<{ link: SmartLink; version: number }> {
  requirePermission(actor, 'links:write');
  const data = parseInput(smartLinkDestinationChangeSchema, input);

  const [before] = await db.select().from(smartLinks).where(eq(smartLinks.id, id)).limit(1);
  if (!before) throw notFound('Smart link');
  if (before.activeDestinationId === data.destinationId) {
    throw precondition('That link already points at this destination.');
  }

  const destination = await requireApprovedDestination(db, data.destinationId);

  const [campaign] = await db
    .select({ campaign: campaigns, publisher: publishers })
    .from(campaigns)
    .innerJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .where(eq(campaigns.id, before.campaignId))
    .limit(1);
  if (!campaign) throw notFound('Campaign');

  // PRD §11 and TRD §13: a destination change may itself need publisher
  // approval. Refuse the change if the new type was never approved.
  const verdict = publisherPermits(campaign.publisher, destination.type);
  if (!verdict.permitted && before.status === 'active') {
    throw precondition(`Cannot change destination on a live link: ${verdict.reason}`);
  }

  const nextVersion = before.activeDestinationVersion + 1;

  const updated = await db.transaction(async (tx) => {
    await tx.insert(destinationVersions).values({
      smartLinkId: id,
      destinationId: destination.id,
      version: nextVersion,
      changedBy: actor.user.id,
      approvalReference: data.approvalReference,
    });

    const [link] = await tx
      .update(smartLinks)
      .set({
        activeDestinationId: destination.id,
        activeDestinationVersion: nextVersion,
        destinationType: destination.type,
        updatedAt: new Date(),
      })
      .where(eq(smartLinks.id, id))
      .returning();

    return link;
  });

  await writeAudit(db, {
    actor: actor.user,
    action: 'smart_link.destination_change',
    entityType: 'smart_link',
    entityId: id,
    summary: `/c/${updated.slug} destination v${before.activeDestinationVersion} → v${nextVersion} (${destination.url})`,
    approvalReference: data.approvalReference,
    before: {
      destinationId: before.activeDestinationId,
      version: before.activeDestinationVersion,
      destinationType: before.destinationType,
    },
    after: {
      destinationId: destination.id,
      version: nextVersion,
      destinationType: destination.type,
      url: destination.url,
    },
    ipHash: actor.ipHash,
  });

  return { link: updated, version: nextVersion };
}

/**
 * The exact URL a click will be sent to, for the "preview final destination"
 * step in UI/UX §7. Built by the same function the redirect engine uses, so
 * the preview cannot disagree with what actually happens.
 */
export async function previewDestination(
  db: Db,
  actor: ActorContext,
  destinationId: string,
  slug: string,
): Promise<string> {
  requirePermission(actor, 'links:read');
  const destination = await requireApprovedDestination(db, destinationId);
  return buildRedirectUrl({
    destinationUrl: destination.url,
    kind: destination.type,
    clickId: 'EXAMPLE_CLICK_ID',
    campaignReference: destination.type === 'whatsapp' ? `BI-${slug.toUpperCase()}` : null,
  });
}

async function requireApprovedDestination(db: Db, destinationId: string) {
  const [destination] = await db
    .select()
    .from(destinations)
    .where(eq(destinations.id, destinationId))
    .limit(1);
  if (!destination) throw notFound('Destination');
  if (destination.approvalStatus !== 'approved') {
    throw precondition(
      `That destination is ${destination.approvalStatus}, not approved. A link may only point at an approved destination.`,
    );
  }
  return destination;
}

async function assertLinkStatusAllowed(
  db: Db,
  link: SmartLink,
  next: SmartLink['status'],
): Promise<void> {
  if (link.status === 'ended' && next !== 'ended') {
    throw precondition('An ended link cannot be reopened. Create a new link instead.');
  }
  if (next !== 'active') return;

  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    throw precondition('That link has already expired. Clear or extend the expiry first.');
  }

  const rows = await db
    .select({
      approvalStatus: destinations.approvalStatus,
      destinationType: destinations.type,
      campaignStatus: campaigns.status,
      publisher: publishers,
    })
    .from(smartLinks)
    .innerJoin(campaigns, eq(campaigns.id, smartLinks.campaignId))
    .innerJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .leftJoin(destinations, eq(destinations.id, smartLinks.activeDestinationId))
    .where(eq(smartLinks.id, link.id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Smart link');

  if (row.approvalStatus !== 'approved') {
    throw precondition('This link has no approved destination. Approve one before activating.');
  }
  if (row.campaignStatus === 'ended') {
    throw precondition('The campaign has ended.');
  }

  const verdict = publisherPermits(row.publisher, row.destinationType ?? 'website');
  if (!verdict.permitted) throw precondition(`Cannot activate: ${verdict.reason}`);
}
