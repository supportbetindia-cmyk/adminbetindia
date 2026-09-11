/**
 * Campaign cost entry (PRD §4 commercials, §10 cost formulas).
 *
 * PRD §16 requires the cost import process and financial definitions to be
 * confirmed before ROI reporting, so this service records spend and nothing
 * more. It deliberately does not compute ROAS or ROI — TRD §11 puts those
 * behind approved accounting definitions, and "deposits are not automatically
 * revenue or profit" (PRD §10).
 *
 * Planned budget lives on the campaign; actual spend lives here. They are
 * never added together.
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { campaignCosts, campaigns } from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';
import { writeAudit } from '@/lib/audit';
import { notFound, precondition } from '@/lib/errors';
import { campaignCostSchema, parseInput } from '@/lib/validation';

type Db = typeof Database;

export type CampaignCost = typeof campaignCosts.$inferSelect;

export async function listCampaignCosts(
  db: Db,
  actor: ActorContext,
  campaignId: string,
): Promise<CampaignCost[]> {
  requirePermission(actor, 'costs:read');
  return db
    .select()
    .from(campaignCosts)
    .where(eq(campaignCosts.campaignId, campaignId))
    .orderBy(desc(campaignCosts.costDate));
}

/**
 * Records or corrects one day of spend.
 *
 * Upsert on (campaign, date, source) so re-importing a corrected figure
 * replaces it rather than double-counting — the unique index in the schema
 * backs this up.
 */
export async function recordCampaignCost(
  db: Db,
  actor: ActorContext,
  input: unknown,
): Promise<CampaignCost> {
  requirePermission(actor, 'costs:write');
  const data = parseInput(campaignCostSchema, input);

  const [campaign] = await db
    .select({ id: campaigns.id, name: campaigns.name, currency: campaigns.currency })
    .from(campaigns)
    .where(eq(campaigns.id, data.campaignId))
    .limit(1);
  if (!campaign) throw notFound('Campaign');

  // Mixing currencies inside one campaign would make every cost-per-result
  // figure meaningless, and there is no approved conversion rate source.
  if (data.currency !== campaign.currency) {
    throw precondition(
      `This campaign reports in ${campaign.currency}. Record spend in the same currency, or change the campaign currency first.`,
      { currency: `Expected ${campaign.currency}` },
    );
  }

  const [before] = await db
    .select()
    .from(campaignCosts)
    .where(
      and(
        eq(campaignCosts.campaignId, data.campaignId),
        eq(campaignCosts.costDate, data.costDate),
        eq(campaignCosts.source, data.source),
      ),
    )
    .limit(1);

  const [row] = await db
    .insert(campaignCosts)
    .values({
      campaignId: data.campaignId,
      costDate: data.costDate,
      amount: data.amount as string,
      currency: data.currency,
      source: data.source,
      externalReference: data.externalReference,
    })
    .onConflictDoUpdate({
      target: [campaignCosts.campaignId, campaignCosts.costDate, campaignCosts.source],
      set: { amount: data.amount as string, externalReference: data.externalReference },
    })
    .returning();

  await writeAudit(db, {
    actor: actor.user,
    action: before ? 'campaign_cost.correct' : 'campaign_cost.record',
    entityType: 'campaign_cost',
    entityId: row.id,
    summary: `${campaign.name}: ${data.currency} ${data.amount} on ${data.costDate} (source: ${data.source})`,
    before: before ? { amount: before.amount } : undefined,
    after: { amount: row.amount, source: row.source, costDate: row.costDate },
    ipHash: actor.ipHash,
  });

  return row;
}

/** Total recorded spend in a window, or null when nothing has been imported. */
export async function campaignSpend(
  db: Db,
  actor: ActorContext,
  campaignId: string,
  from?: string,
  to?: string,
): Promise<number | null> {
  requirePermission(actor, 'costs:read');
  const [row] = await db
    .select({ total: sql<string | null>`sum(${campaignCosts.amount})` })
    .from(campaignCosts)
    .where(
      and(
        eq(campaignCosts.campaignId, campaignId),
        from ? gte(campaignCosts.costDate, from) : undefined,
        to ? lte(campaignCosts.costDate, to) : undefined,
      ),
    );
  return row?.total == null ? null : Number(row.total);
}
