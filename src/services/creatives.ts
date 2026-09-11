/**
 * Creative and placement management (PRD §4, Backend Schema §2).
 *
 * A creative records the banner version and dimensions a click came from, so
 * performance can be compared per creative. Approval status is tracked because
 * TRD §13 requires recorded creative specifications per publisher.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { campaigns, clickEvents, creatives, smartLinks } from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';
import { diff, writeAudit } from '@/lib/audit';
import { notFound } from '@/lib/errors';
import { creativeCreateSchema, creativeUpdateSchema, parseInput } from '@/lib/validation';
import { pickProvided } from './campaigns';

type Db = typeof Database;

export type Creative = typeof creatives.$inferSelect;

export interface CreativeRow extends Creative {
  campaignName: string;
  linkCount: number;
  clickCount: number;
}

export async function listCreatives(
  db: Db,
  actor: ActorContext,
  filter: { campaignId?: string } = {},
): Promise<CreativeRow[]> {
  requirePermission(actor, 'creatives:read');

  const rows = await db
    .select({
      creative: creatives,
      campaignName: campaigns.name,
      linkCount: sql<number>`count(distinct ${smartLinks.id})::int`,
      clickCount: sql<number>`count(${clickEvents.id})::int`,
    })
    .from(creatives)
    .innerJoin(campaigns, eq(campaigns.id, creatives.campaignId))
    .leftJoin(smartLinks, eq(smartLinks.creativeId, creatives.id))
    .leftJoin(clickEvents, eq(clickEvents.creativeId, creatives.id))
    .where(filter.campaignId ? eq(creatives.campaignId, filter.campaignId) : undefined)
    .groupBy(creatives.id, campaigns.name)
    .orderBy(desc(creatives.createdAt));

  return rows.map((r) => ({
    ...r.creative,
    campaignName: r.campaignName,
    linkCount: r.linkCount,
    clickCount: r.clickCount,
  }));
}

export async function createCreative(db: Db, actor: ActorContext, input: unknown): Promise<Creative> {
  requirePermission(actor, 'creatives:write');
  const data = parseInput(creativeCreateSchema, input);

  const [campaign] = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(eq(campaigns.id, data.campaignId))
    .limit(1);
  if (!campaign) throw notFound('Campaign');

  const [row] = await db
    .insert(creatives)
    .values({ ...data, createdBy: actor.user.id })
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: 'creative.create',
    entityType: 'creative',
    entityId: row.id,
    summary: `Added creative "${row.name}" to ${campaign.name}`,
    approvalReference: row.approvalReference,
    after: row,
    ipHash: actor.ipHash,
  });

  return row;
}

export async function updateCreative(
  db: Db,
  actor: ActorContext,
  id: string,
  input: unknown,
): Promise<Creative> {
  requirePermission(actor, 'creatives:write');
  const data = parseInput(creativeUpdateSchema, input);

  const [before] = await db.select().from(creatives).where(eq(creatives.id, id)).limit(1);
  if (!before) throw notFound('Creative');

  const patch = pickProvided(data as Record<string, unknown>, input);
  const changes = diff(before as Record<string, unknown>, patch);
  if (changes.changedKeys.length === 0) return before;

  const [after] = await db.update(creatives).set(patch).where(eq(creatives.id, id)).returning();

  await writeAudit(db, {
    actor: actor.user,
    action: 'creative.update',
    entityType: 'creative',
    entityId: id,
    summary: `Updated ${changes.changedKeys.join(', ')} on "${after.name}"`,
    approvalReference: after.approvalReference,
    before: changes.before,
    after: changes.after,
    ipHash: actor.ipHash,
  });

  return after;
}

/** Creatives belonging to one campaign, for the link-creation form. */
export async function listCreativesForCampaign(db: Db, actor: ActorContext, campaignId: string) {
  requirePermission(actor, 'creatives:read');
  return db
    .select({ id: creatives.id, name: creatives.name, format: creatives.format })
    .from(creatives)
    .where(and(eq(creatives.campaignId, campaignId), eq(creatives.approvalStatus, 'approved')))
    .orderBy(desc(creatives.createdAt));
}
