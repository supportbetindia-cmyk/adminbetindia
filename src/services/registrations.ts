/**
 * Verified registration ingestion (PRD §6, §8; TRD §9, §10).
 *
 * A registration only exists here if it arrived from an authorized server with
 * a real external user ID and a completed account. TRD §9 is explicit:
 * "Registration success requires an actual external user ID and completed
 * account creation." A browser event can never satisfy that — anyone can post
 * one — which is why website `registration_submitted` events live in
 * website_events and never reach this table.
 *
 * Attribution follows TRD §10: an exact click_id join takes precedence,
 * unmatched registrations stay unmatched, and the decision is versioned so it
 * can be revisited when the attribution model is finally approved.
 *
 * Free of Next.js types so it can be tested directly against the database.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import {
  campaigns, clickEvents, conversionAttributions, creatives, publishers, registrations, smartLinks,
} from '@/db/schema';
import { normalisePhone } from '@/lib/privacy';

type Db = typeof Database;

/**
 * The attribution model is NOT approved. TRD §10 proposes first eligible click
 * within a 30-day window "subject to business approval", and PRD §16 lists it
 * as an open decision.
 *
 * Recording the policy version on every row means the decisions made under the
 * proposal are identifiable and can be recomputed once a model is signed off,
 * rather than silently becoming "the way it has always been".
 */
export const ATTRIBUTION_POLICY_VERSION = 'PROPOSED-first-click-30d-UNAPPROVED';
export const DEFAULT_WINDOW_DAYS = 30;

export interface RegistrationInput {
  /** Which system confirmed the account, e.g. "betindia-web". */
  sourceSystem: string;
  /** The platform's own user ID. Required — without it this is not a registration. */
  externalUserId: string;
  registeredAt: Date;
  /** First click, from the bi_click cookie. */
  clickId?: string | null;
  /** Most recent click, from bi_click_last. Preserved for later re-attribution. */
  lastClickId?: string | null;
  /** Raw phone, normalised here. Optional and minimised (PRD §13). */
  phone?: string | null;
  /** The caller's own event/request id, for tracing a delivery back to them. */
  sourceEventId?: string | null;
}

export type RegistrationResult =
  | { status: 'recorded'; registrationId: string; attribution: AttributionOutcome }
  | { status: 'duplicate'; registrationId: string };

export interface AttributionOutcome {
  confidence: 'exact' | 'unknown';
  clickId: string | null;
  campaignId: string | null;
  /** Why it landed where it did, surfaced in the UI rather than left implicit. */
  reason: string;
}

const CLICK_ID_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Records a verified registration and attributes it if possible.
 *
 * Idempotent on (source_system, external_user_id): a redelivery returns the
 * existing row rather than creating a second one. Backend Schema §9 treats
 * duplicate delivery inflating a count as a failed acceptance test.
 */
export async function recordRegistration(
  db: Db,
  input: RegistrationInput,
): Promise<RegistrationResult> {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    throw new Error('externalUserId is required — a registration without one is not verified');
  }

  const contactKey = input.phone ? normalisePhone(input.phone) : null;

  const inserted = await db
    .insert(registrations)
    .values({
      sourceSystem: input.sourceSystem,
      externalUserId,
      registeredAt: input.registeredAt,
      contactKey,
      sourceEventId: input.sourceEventId ?? null,
    })
    .onConflictDoNothing({
      target: [registrations.sourceSystem, registrations.externalUserId],
    })
    .returning({ id: registrations.id });

  if (inserted.length === 0) {
    const [existing] = await db
      .select({ id: registrations.id })
      .from(registrations)
      .where(and(
        eq(registrations.sourceSystem, input.sourceSystem),
        eq(registrations.externalUserId, externalUserId),
      ))
      .limit(1);
    return { status: 'duplicate', registrationId: existing.id };
  }

  const registrationId = inserted[0].id;
  const attribution = await attributeRegistration(db, registrationId, input);

  return { status: 'recorded', registrationId, attribution };
}

/**
 * Decides where a registration came from.
 *
 * Only an exact click_id join is accepted. There is deliberately no fallback
 * to "the most recent click from a similar device around that time" — TRD §10
 * requires unmatched conversions remain unknown, and a plausible guess
 * recorded as fact is the failure this whole system is built to avoid.
 */
async function attributeRegistration(
  db: Db,
  registrationId: string,
  input: RegistrationInput,
): Promise<AttributionOutcome> {
  const candidates = [input.clickId, input.lastClickId]
    .filter((id): id is string => Boolean(id) && CLICK_ID_SHAPE.test(id!));

  for (const clickId of candidates) {
    const [click] = await db
      .select({
        clickId: clickEvents.clickId,
        campaignId: clickEvents.campaignId,
        occurredAt: clickEvents.occurredAt,
        windowDays: campaigns.attributionWindowDays,
      })
      .from(clickEvents)
      .innerJoin(campaigns, eq(campaigns.id, clickEvents.campaignId))
      .where(eq(clickEvents.clickId, clickId))
      .limit(1);

    if (!click) continue;

    // The lookback window is per campaign, defaulting to the proposed 30 days.
    const windowDays = click.windowDays ?? DEFAULT_WINDOW_DAYS;
    const ageMs = input.registeredAt.getTime() - click.occurredAt.getTime();

    if (ageMs < 0 || ageMs > windowDays * 86_400_000) {
      // A click outside its own window is not eligible. Recorded as unknown
      // rather than stretched to fit.
      continue;
    }

    await db.insert(conversionAttributions).values({
      registrationId,
      clickId: click.clickId,
      campaignId: click.campaignId,
      model: 'exact_click_id',
      confidence: 'exact',
      policyVersion: ATTRIBUTION_POLICY_VERSION,
      evidenceReference: `click_id passed through registration by ${input.sourceSystem}`,
    });

    return {
      confidence: 'exact',
      clickId: click.clickId,
      campaignId: click.campaignId,
      reason: 'Click ID passed through the registration and matched a recorded click.',
    };
  }

  // Unknown is a real outcome and is written down as one, so the unmatched
  // count is visible in reports rather than absent from them (TRD §10).
  await db.insert(conversionAttributions).values({
    registrationId,
    clickId: null,
    campaignId: null,
    model: 'none',
    confidence: 'unknown',
    policyVersion: ATTRIBUTION_POLICY_VERSION,
    evidenceReference: candidates.length
      ? 'A click ID was supplied but did not match an eligible recorded click.'
      : 'No click ID was supplied with the registration.',
  });

  return {
    confidence: 'unknown',
    clickId: null,
    campaignId: null,
    reason: candidates.length
      ? 'The click ID supplied did not match an eligible click, so this stays unattributed.'
      : 'No click ID reached the registration, so this stays unattributed.',
  };
}

// ── Reporting ────────────────────────────────────────────────

/**
 * A registration with the full journey attached: which publisher, which
 * campaign, which banner, which link, on what device and from roughly where.
 *
 * Every one of those comes from the click record itself, not from a guess —
 * the click pinned them when it happened, so a later change to a campaign or
 * creative cannot rewrite what this registration is attributed to.
 */
export interface RegistrationRow {
  id: string;
  externalUserId: string;
  sourceSystem: string;
  registeredAt: Date;
  contactKey: string | null;

  clickId: string | null;
  confidence: string | null;

  /** The ad itself. */
  creativeName: string | null;
  creativeFormat: string | null;
  campaignName: string | null;
  publisherName: string | null;
  slug: string | null;
  destinationType: string | null;

  /** Context captured at click time. */
  clickedAt: Date | null;
  device: string | null;
  os: string | null;
  geoCity: string | null;
  geoRegion: string | null;
  /** Seconds between the click and the registration. */
  secondsToRegister: number | null;
}

export async function listRegistrations(db: Db, limit = 100): Promise<RegistrationRow[]> {
  const rows = await db
    .select({
      id: registrations.id,
      externalUserId: registrations.externalUserId,
      sourceSystem: registrations.sourceSystem,
      registeredAt: registrations.registeredAt,
      contactKey: registrations.contactKey,

      clickId: conversionAttributions.clickId,
      confidence: conversionAttributions.confidence,

      creativeName: creatives.name,
      creativeFormat: creatives.format,
      campaignName: campaigns.name,
      publisherName: publishers.name,
      slug: smartLinks.slug,
      destinationType: smartLinks.destinationType,

      clickedAt: clickEvents.occurredAt,
      device: clickEvents.deviceType,
      os: clickEvents.os,
      geoCity: clickEvents.geoCity,
      geoRegion: clickEvents.geoRegion,
      secondsToRegister: sql<number | null>`
        case when ${clickEvents.occurredAt} is null then null
             else extract(epoch from (${registrations.registeredAt} - ${clickEvents.occurredAt}))::int
        end`,
    })
    .from(registrations)
    .leftJoin(conversionAttributions, eq(conversionAttributions.registrationId, registrations.id))
    // Joined through the click, so the ad shown is the one that was actually
    // clicked — not whatever the campaign points at today.
    .leftJoin(clickEvents, eq(clickEvents.clickId, conversionAttributions.clickId))
    .leftJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .leftJoin(creatives, eq(creatives.id, clickEvents.creativeId))
    .leftJoin(campaigns, eq(campaigns.id, conversionAttributions.campaignId))
    .leftJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .orderBy(desc(registrations.registeredAt))
    .limit(limit);

  return rows as RegistrationRow[];
}

export interface RegistrationSummary {
  total: number;
  attributed: number;
  unknown: number;
  byCampaign: { campaignName: string | null; publisherName: string | null; count: number }[];
  /** Which ad actually produced registrations — the question this answers. */
  byCreative: {
    creativeName: string | null;
    creativeFormat: string | null;
    campaignName: string | null;
    publisherName: string | null;
    slug: string | null;
    count: number;
  }[];
}

export async function registrationSummary(db: Db): Promise<RegistrationSummary> {
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      attributed: sql<number>`count(*) filter (where ${conversionAttributions.confidence} = 'exact')::int`,
    })
    .from(registrations)
    .leftJoin(conversionAttributions, eq(conversionAttributions.registrationId, registrations.id));

  const byCampaign = await db
    .select({
      campaignName: campaigns.name,
      publisherName: publishers.name,
      count: sql<number>`count(*)::int`,
    })
    .from(conversionAttributions)
    .leftJoin(campaigns, eq(campaigns.id, conversionAttributions.campaignId))
    .leftJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .where(eq(conversionAttributions.confidence, 'exact'))
    .groupBy(campaigns.name, publishers.name)
    .orderBy(sql`3 desc`);

  const byCreative = await db
    .select({
      creativeName: creatives.name,
      creativeFormat: creatives.format,
      campaignName: campaigns.name,
      publisherName: publishers.name,
      slug: smartLinks.slug,
      count: sql<number>`count(*)::int`,
    })
    .from(conversionAttributions)
    .innerJoin(clickEvents, eq(clickEvents.clickId, conversionAttributions.clickId))
    .leftJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .leftJoin(creatives, eq(creatives.id, clickEvents.creativeId))
    .leftJoin(campaigns, eq(campaigns.id, conversionAttributions.campaignId))
    .leftJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .where(eq(conversionAttributions.confidence, 'exact'))
    .groupBy(creatives.name, creatives.format, campaigns.name, publishers.name, smartLinks.slug)
    .orderBy(sql`6 desc`);

  const total = totals?.total ?? 0;
  const attributed = totals?.attributed ?? 0;

  return {
    total,
    attributed,
    // Never redistributed across campaigns to make the report look complete.
    unknown: total - attributed,
    byCampaign,
    byCreative,
  };
}

export async function hasRegistrations(db: Db): Promise<boolean> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(registrations);
  return (row?.n ?? 0) > 0;
}
