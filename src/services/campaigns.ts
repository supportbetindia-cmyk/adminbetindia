/**
 * Campaign management.
 *
 * UI/UX §6: campaigns are created in Draft, and "Activation requires a valid
 * approved destination and authorized permission". Both checks live here, so
 * no transport can skip them.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import {
  campaigns, clickEvents, destinations, destinationVersions, publishers, smartLinks,
} from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';
import { diff, writeAudit } from '@/lib/audit';
import { notFound, precondition } from '@/lib/errors';
import { campaignCreateSchema, campaignUpdateSchema, parseInput } from '@/lib/validation';
import { publisherPermits } from './publishers';

type Db = typeof Database;

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignStatus = Campaign['status'];

export interface CampaignListRow extends Campaign {
  publisherName: string;
  linkCount: number;
  clickCount: number;
}

export interface CampaignFilter {
  publisherId?: string;
  status?: CampaignStatus;
}

export async function listCampaigns(
  db: Db,
  actor: ActorContext,
  filter: CampaignFilter = {},
): Promise<CampaignListRow[]> {
  requirePermission(actor, 'campaigns:read');

  const conditions = [
    filter.publisherId ? eq(campaigns.publisherId, filter.publisherId) : undefined,
    filter.status ? eq(campaigns.status, filter.status) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      campaign: campaigns,
      publisherName: publishers.name,
      linkCount: sql<number>`count(distinct ${smartLinks.id})::int`,
      // Raw clicks. Bot filtering is applied in the reports layer, never here.
      clickCount: sql<number>`count(${clickEvents.id})::int`,
    })
    .from(campaigns)
    .innerJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .leftJoin(smartLinks, eq(smartLinks.campaignId, campaigns.id))
    .leftJoin(clickEvents, eq(clickEvents.campaignId, campaigns.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(campaigns.id, publishers.name)
    .orderBy(desc(campaigns.createdAt));

  return rows.map((r) => ({
    ...r.campaign,
    publisherName: r.publisherName,
    linkCount: r.linkCount,
    clickCount: r.clickCount,
  }));
}

export async function getCampaign(db: Db, actor: ActorContext, id: string) {
  requirePermission(actor, 'campaigns:read');
  const [row] = await db
    .select({ campaign: campaigns, publisher: publishers })
    .from(campaigns)
    .innerJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .where(eq(campaigns.id, id))
    .limit(1);
  if (!row) throw notFound('Campaign');
  return { ...row.campaign, publisher: row.publisher };
}

export async function createCampaign(db: Db, actor: ActorContext, input: unknown): Promise<Campaign> {
  requirePermission(actor, 'campaigns:write');
  const data = parseInput(campaignCreateSchema, input);

  const [publisher] = await db
    .select()
    .from(publishers)
    .where(eq(publishers.id, data.publisherId))
    .limit(1);
  if (!publisher) throw notFound('Publisher');

  // Always Draft on creation (UI/UX §6). Status is not accepted as an input
  // here — activation is a separate, checked transition.
  const [row] = await db
    .insert(campaigns)
    .values({ ...data, status: 'draft', createdBy: actor.user.id, updatedAt: new Date() })
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: 'campaign.create',
    entityType: 'campaign',
    entityId: row.id,
    summary: `Created campaign "${row.name}" for ${publisher.name} (draft)`,
    approvalReference: row.approvalReference,
    after: row,
    ipHash: actor.ipHash,
  });

  return row;
}

export async function updateCampaign(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<Campaign> {
  requirePermission(actor, 'campaigns:write');
  const data = parseInput(campaignUpdateSchema, input);

  const [before] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!before) throw notFound('Campaign');

  if (data.status && data.status !== before.status) {
    await assertStatusTransitionAllowed(db, before, data.status);
  }

  // A partial update must not overwrite an unchanged field with null. Only
  // keys the caller actually supplied are applied.
  const patch = pickProvided(data, input);
  const changes = diff(before as Record<string, unknown>, patch);
  if (changes.changedKeys.length === 0) return before;

  const [after] = await db
    .update(campaigns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(campaigns.id, id))
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: data.status && data.status !== before.status ? 'campaign.status_change' : 'campaign.update',
    entityType: 'campaign',
    entityId: id,
    summary: `Updated ${changes.changedKeys.join(', ')} on "${after.name}"`,
    approvalReference: after.approvalReference,
    before: changes.before,
    after: changes.after,
    ipHash: actor.ipHash,
  });

  return after;
}

/**
 * Guards the transition into `active`.
 *
 * A campaign may only run when the publisher has approved the destination type
 * in writing and at least one of its links points at an approved destination.
 * Anything less would put traffic on an unapproved route, which PRD §4 and
 * TRD §13 both forbid.
 */
async function assertStatusTransitionAllowed(
  db: Db,
  campaign: Campaign,
  next: CampaignStatus,
): Promise<void> {
  if (campaign.status === 'ended' && next !== 'ended') {
    throw precondition('An ended campaign cannot be reopened. Create a new campaign instead.');
  }
  if (next !== 'active') return;

  const links = await db
    .select({
      linkId: smartLinks.id,
      slug: smartLinks.slug,
      linkStatus: smartLinks.status,
      destinationType: smartLinks.destinationType,
      approvalStatus: destinations.approvalStatus,
    })
    .from(smartLinks)
    .leftJoin(
      destinationVersions,
      and(
        eq(destinationVersions.smartLinkId, smartLinks.id),
        eq(destinationVersions.version, smartLinks.activeDestinationVersion),
      ),
    )
    .leftJoin(destinations, eq(destinations.id, destinationVersions.destinationId))
    .where(eq(smartLinks.campaignId, campaign.id));

  if (links.length === 0) {
    throw precondition('Add a smart link with an approved destination before activating.');
  }

  const usable = links.filter((l) => l.approvalStatus === 'approved');
  if (usable.length === 0) {
    throw precondition(
      'No link on this campaign points at an approved destination. Approve a destination first.',
    );
  }

  const [publisher] = await db
    .select()
    .from(publishers)
    .where(eq(publishers.id, campaign.publisherId))
    .limit(1);
  if (!publisher) throw notFound('Publisher');

  for (const type of new Set(usable.map((l) => l.destinationType))) {
    const verdict = publisherPermits(publisher, type);
    if (!verdict.permitted) {
      throw precondition(`Cannot activate: ${verdict.reason}`);
    }
  }
}

/**
 * Restricts a validated patch to the keys the caller actually sent.
 *
 * Zod's `.optional()` transforms turn an absent field into null, which would
 * otherwise clear a value the caller never mentioned.
 */
function pickProvided<T extends Record<string, unknown>>(
  data: T,
  raw: unknown,
): Partial<T> {
  if (!raw || typeof raw !== 'object') return data;
  const provided = new Set(Object.keys(raw as Record<string, unknown>));
  const out: Partial<T> = {};
  for (const key of Object.keys(data) as (keyof T)[]) {
    if (provided.has(String(key))) out[key] = data[key];
  }
  return out;
}

export { pickProvided };

/** Campaigns eligible to receive new links, for the link-creation form. */
export async function listSelectableCampaigns(db: Db, actor: ActorContext) {
  requirePermission(actor, 'campaigns:read');
  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      publisherId: campaigns.publisherId,
      publisherName: publishers.name,
    })
    .from(campaigns)
    .innerJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .orderBy(asc(publishers.name), asc(campaigns.name));
}
