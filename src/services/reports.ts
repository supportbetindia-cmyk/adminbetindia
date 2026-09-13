/**
 * Reporting.
 *
 * The hard rule across all four documents is that a report must never present
 * something it does not have. So every metric produced here carries its own
 * availability, definition and source, and the UI renders that rather than a
 * bare number:
 *
 *   measured    — counted first-hand from our own event tables
 *   estimated   — deduplicated approximation, never a person count (PRD §5, TRD §11)
 *   unavailable — the source integration does not exist yet, so the value is
 *                 null and displays as N/A, never as zero (UI/UX §4)
 *
 * Zero and unavailable are different facts. "No leads yet" and "we cannot see
 * leads at all" would otherwise look identical on a dashboard, which is the
 * exact failure the specification is written to prevent.
 */

import { and, asc, between, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { db as Database } from '@/db';
import {
  campaignCosts, campaigns, clickEvents, destinations, destinationVersions, ftdEvents, leads,
  publisherReports, publishers, registrations, smartLinks, websiteSessions, whatsappEvents,
} from '@/db/schema';
import { requirePermission, type ActorContext } from '@/lib/auth/context';
import { parseInput, reportFilterSchema, type ReportFilter } from '@/lib/validation';

type Db = typeof Database;

export type Availability = 'measured' | 'estimated' | 'unavailable';

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  availability: Availability;
  /** What this number counts. Surfaced in the UI (UI/UX §4). */
  definition: string;
  /** Where it came from, or why it is missing. */
  source: string;
}

function measured(key: string, label: string, value: number, definition: string, source: string): Metric {
  return { key, label, value, availability: 'measured', definition, source };
}

function estimated(key: string, label: string, value: number, definition: string, source: string): Metric {
  return { key, label, value, availability: 'estimated', definition, source };
}

function unavailable(key: string, label: string, definition: string, source: string): Metric {
  return { key, label, value: null, availability: 'unavailable', definition, source };
}

/** Reasons a metric has no source yet, quoted from the checklist that blocks it. */
const BLOCKED = {
  impressions:
    'Impressions happen on the publisher’s page. Only the publisher can count them, and no publisher report has been imported for this range (PRD §11).',
  websiteVisits:
    'The website tracking SDK is not deployed, so no landing sessions are recorded (Feature 4, blocked on website deploy access).',
  whatsappOpens:
    'A WhatsApp open is not observable. PRD §6 requires redirects to WhatsApp be reported as a separate proxy instead.',
  leads:
    'Interakt webhook ingestion is not built. A lead requires a genuine inbound message event; a redirect is not one (PRD §6, TRD §8).',
  registrations:
    'No authorized registration API or webhook is connected. A registration requires a real external user ID (TRD §9).',
  ftd:
    'No authorized transaction API is connected, and the genuine-first-deposit definition is not confirmed (PRD §8, TRD §9).',
  spend: 'No cost rows have been imported for this range (PRD §16 cost import process).',
} as const;

export interface DateWindow {
  from: Date;
  to: Date;
}

/** Inclusive day range in UTC. Display conversion to IST happens in the UI. */
export function resolveWindow(filter: ReportFilter): DateWindow {
  const to = filter.to ? endOfDayUtc(filter.to) : endOfDayUtc(todayIso());
  const from = filter.from
    ? startOfDayUtc(filter.from)
    : startOfDayUtc(new Date(to.getTime() - 29 * 86_400_000).toISOString().slice(0, 10));
  return { from, to };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function startOfDayUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function endOfDayUtc(iso: string): Date {
  return new Date(`${iso}T23:59:59.999Z`);
}

/**
 * Click-side filters shared by every query below.
 *
 * `botFilter` is separate from the rest because several callers need the same
 * slice of traffic both with and without it — the raw-versus-counted
 * comparison in PRD §5 is meaningless if the two totals differ on any other
 * dimension.
 */
function clickConditions(
  filter: ReportFilter,
  window: DateWindow,
  botFilter: 'apply' | 'ignore' = 'apply',
): SQL[] {
  const conditions: SQL[] = [between(clickEvents.occurredAt, window.from, window.to)];

  if (filter.publisherId) conditions.push(eq(clickEvents.publisherId, filter.publisherId));
  if (filter.campaignId) conditions.push(eq(clickEvents.campaignId, filter.campaignId));
  if (filter.creativeId) conditions.push(eq(clickEvents.creativeId, filter.creativeId));
  if (filter.smartLinkId) conditions.push(eq(clickEvents.smartLinkId, filter.smartLinkId));
  if (filter.device) conditions.push(eq(clickEvents.deviceType, filter.device));
  if (filter.destinationType) conditions.push(eq(smartLinks.destinationType, filter.destinationType));

  // PRD §5: raw counts are never silently altered. The raw row always exists;
  // reports exclude flagged clicks by default and can include them on request.
  if (botFilter === 'apply' && !filter.includeFiltered) {
    conditions.push(eq(clickEvents.isFiltered, false));
  }

  return conditions;
}

export interface OverviewReport {
  window: DateWindow;
  filter: ReportFilter;
  metrics: Metric[];
  /** Raw vs filtered, always shown side by side rather than as one number. */
  clickBreakdown: { raw: number; filtered: number; counted: number };
  generatedAt: Date;
}

export async function overviewReport(
  db: Db,
  actor: ActorContext,
  rawFilter: unknown,
): Promise<OverviewReport> {
  requirePermission(actor, 'reports:read');
  const filter = parseInput(reportFilterSchema, rawFilter ?? {});
  const window = resolveWindow(filter);

  const conditions = clickConditions(filter, window);
  // Same slice of traffic, bot filter off, so raw and counted are comparable.
  const rawConditions = clickConditions(filter, window, 'ignore');

  const [clickRow] = await db
    .select({
      counted: sql<number>`count(*)::int`,
      uniqueVisitors: sql<number>`count(distinct ${clickEvents.visitorTokenHash})::int`,
      whatsappRedirects: sql<number>`count(*) filter (where ${smartLinks.destinationType} = 'whatsapp')::int`,
      websiteRedirects: sql<number>`count(*) filter (where ${smartLinks.destinationType} = 'website')::int`,
    })
    .from(clickEvents)
    .innerJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .where(and(...conditions));

  const [rawRow] = await db
    .select({
      raw: sql<number>`count(*)::int`,
      filtered: sql<number>`count(*) filter (where ${clickEvents.isFiltered})::int`,
    })
    .from(clickEvents)
    .innerJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .where(and(...rawConditions));

  const [impressionRow] = await db
    .select({
      impressions: sql<number | null>`sum(${publisherReports.impressions})::int`,
      publisherClicks: sql<number | null>`sum(${publisherReports.publisherClicks})::int`,
    })
    .from(publisherReports)
    .where(
      and(
        gte(publisherReports.reportDate, window.from.toISOString().slice(0, 10)),
        lte(publisherReports.reportDate, window.to.toISOString().slice(0, 10)),
        filter.publisherId ? eq(publisherReports.publisherId, filter.publisherId) : undefined,
        filter.campaignId ? eq(publisherReports.campaignId, filter.campaignId) : undefined,
      ),
    );

  const [spendRow] = await db
    .select({ spend: sql<string | null>`sum(${campaignCosts.amount})` })
    .from(campaignCosts)
    .innerJoin(campaigns, eq(campaigns.id, campaignCosts.campaignId))
    .where(
      and(
        gte(campaignCosts.costDate, window.from.toISOString().slice(0, 10)),
        lte(campaignCosts.costDate, window.to.toISOString().slice(0, 10)),
        filter.campaignId ? eq(campaignCosts.campaignId, filter.campaignId) : undefined,
        filter.publisherId ? eq(campaigns.publisherId, filter.publisherId) : undefined,
      ),
    );

  // These four read from tables that exist but have no producer yet. Counting
  // them and reporting zero would be indistinguishable from a real zero, so an
  // empty table is reported as unavailable instead.
  const [downstream] = await db
    .select({
      sessions: sql<number>`(select count(*)::int from ${websiteSessions})`,
      waEvents: sql<number>`(select count(*)::int from ${whatsappEvents})`,
      leadCount: sql<number>`(select count(*)::int from ${leads})`,
      regCount: sql<number>`(select count(*)::int from ${registrations})`,
      ftdCount: sql<number>`(select count(*)::int from ${ftdEvents})`,
    })
    .from(sql`(select 1) as _`);

  const metrics: Metric[] = [
    impressionRow?.impressions != null
      ? measured(
          'impressions', 'Publisher impressions', impressionRow.impressions,
          'Impressions as reported by the publisher.',
          'Imported publisher report. Not measured by this system.',
        )
      : unavailable('impressions', 'Publisher impressions', 'Impressions as reported by the publisher.', BLOCKED.impressions),

    measured(
      'clicks', 'Tracked clicks', clickRow?.counted ?? 0,
      filter.includeFiltered
        ? 'All click events recorded on the redirect endpoint, including those flagged as bot or link-preview traffic.'
        : 'Click events recorded on the redirect endpoint, excluding those flagged as bot or link-preview traffic.',
      'First-party click_events. Measured by this system.',
    ),

    estimated(
      'unique_visitors', 'Unique click estimate', clickRow?.uniqueVisitors ?? 0,
      'Distinct first-party visitor tokens. A deduplicated estimate, not a count of people — the same person on two devices counts twice (PRD §5).',
      'First-party visitor cookie. Estimate.',
    ),

    downstream.sessions > 0
      ? measured('website_visits', 'Website visits', downstream.sessions, 'Confirmed landing sessions on the website.', 'Website tracking SDK.')
      : unavailable('website_visits', 'Website visits', 'Confirmed landing sessions on the website.', BLOCKED.websiteVisits),

    measured(
      'whatsapp_redirects', 'Redirects to WhatsApp', clickRow?.whatsappRedirects ?? 0,
      'Clicks we redirected to a WhatsApp destination. This is a proxy, not a confirmed app open.',
      'First-party click_events. Measured by this system.',
    ),

    unavailable(
      'whatsapp_opens', 'WhatsApp opens', 'Confirmed WhatsApp app opens.', BLOCKED.whatsappOpens,
    ),

    downstream.leadCount > 0
      ? measured('leads', 'Actual WhatsApp leads', downstream.leadCount, 'Distinct contacts with a valid inbound message event.', 'Interakt webhook ingestion.')
      : unavailable('leads', 'Actual WhatsApp leads', 'Distinct contacts with a valid inbound message event.', BLOCKED.leads),

    downstream.regCount > 0
      ? measured('registrations', 'Verified registrations', downstream.regCount, 'Completed accounts with a real external user ID.', 'Authorized registration integration.')
      : unavailable('registrations', 'Verified registrations', 'Completed accounts with a real external user ID.', BLOCKED.registrations),

    downstream.ftdCount > 0
      ? measured('ftd', 'Verified FTD', downstream.ftdCount, 'First genuine completed deposit per user. Excludes pending, failed, reversed and promotional credits.', 'Authorized transaction integration.')
      : unavailable('ftd', 'Verified FTD', 'First genuine completed deposit per user.', BLOCKED.ftd),

    spendRow?.spend != null
      ? measured('spend', 'Spend', Number(spendRow.spend), 'Actual spend imported for this range.', 'Imported campaign_costs.')
      : unavailable('spend', 'Spend', 'Actual spend imported for this range.', BLOCKED.spend),
  ];

  return {
    window,
    filter,
    metrics,
    clickBreakdown: {
      raw: rawRow?.raw ?? 0,
      filtered: rawRow?.filtered ?? 0,
      counted: clickRow?.counted ?? 0,
    },
    generatedAt: new Date(),
  };
}

export interface TrendPoint {
  date: string;
  clicks: number;
  filtered: number;
}

export async function clickTrend(
  db: Db,
  actor: ActorContext,
  rawFilter: unknown,
): Promise<TrendPoint[]> {
  requirePermission(actor, 'reports:read');
  const filter = parseInput(reportFilterSchema, rawFilter ?? {});
  const window = resolveWindow(filter);

  const rows = await db
    .select({
      date: sql<string>`to_char(${clickEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      clicks: sql<number>`count(*) filter (where not ${clickEvents.isFiltered})::int`,
      filtered: sql<number>`count(*) filter (where ${clickEvents.isFiltered})::int`,
    })
    .from(clickEvents)
    .innerJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .where(and(...clickConditions(filter, window, 'ignore')))
    .groupBy(sql`1`)
    .orderBy(asc(sql`1`));

  // Fill gaps so the chart shows a real zero day rather than skipping it.
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: TrendPoint[] = [];
  for (let t = window.from.getTime(); t <= window.to.getTime(); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const row = byDate.get(date);
    out.push({ date, clicks: row?.clicks ?? 0, filtered: row?.filtered ?? 0 });
  }
  return out;
}

export interface PublisherPerformanceRow {
  publisherId: string;
  publisherName: string;
  clicks: number;
  filteredClicks: number;
  uniqueEstimate: number;
  /** Publisher's own figures, kept separate — never reconciled away (PRD §11). */
  publisherReportedClicks: number | null;
  publisherReportedImpressions: number | null;
  /** Difference between the two click counts, as a signed count and a percentage. */
  clickDiscrepancy: number | null;
  clickDiscrepancyPct: number | null;
  spend: number | null;
  costPerClick: number | null;
}

export async function publisherPerformance(
  db: Db,
  actor: ActorContext,
  rawFilter: unknown,
): Promise<PublisherPerformanceRow[]> {
  requirePermission(actor, 'reports:read');
  const filter = parseInput(reportFilterSchema, rawFilter ?? {});
  const window = resolveWindow(filter);

  // The query scans unfiltered traffic so `filteredClicks` can be reported, but
  // `clicks` and `uniqueEstimate` must count the same rows as each other — a
  // unique estimate larger than the click count beside it reads as a bug, and
  // comparing a filtered count against an unfiltered one is not a comparison.
  const countedClicks = filter.includeFiltered
    ? sql<number>`count(*)::int`
    : sql<number>`count(*) filter (where not ${clickEvents.isFiltered})::int`;

  const countedUnique = filter.includeFiltered
    ? sql<number>`count(distinct ${clickEvents.visitorTokenHash})::int`
    : sql<number>`count(distinct ${clickEvents.visitorTokenHash}) filter (where not ${clickEvents.isFiltered})::int`;

  const clicks = await db
    .select({
      publisherId: publishers.id,
      publisherName: publishers.name,
      clicks: countedClicks,
      filteredClicks: sql<number>`count(*) filter (where ${clickEvents.isFiltered})::int`,
      uniqueEstimate: countedUnique,
    })
    .from(clickEvents)
    .innerJoin(publishers, eq(publishers.id, clickEvents.publisherId))
    .innerJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .where(and(...clickConditions(filter, window, 'ignore')))
    .groupBy(publishers.id, publishers.name)
    .orderBy(sql`2`);

  const reported = await db
    .select({
      publisherId: publisherReports.publisherId,
      clicks: sql<number | null>`sum(${publisherReports.publisherClicks})::int`,
      impressions: sql<number | null>`sum(${publisherReports.impressions})::int`,
    })
    .from(publisherReports)
    .where(
      and(
        gte(publisherReports.reportDate, window.from.toISOString().slice(0, 10)),
        lte(publisherReports.reportDate, window.to.toISOString().slice(0, 10)),
      ),
    )
    .groupBy(publisherReports.publisherId);

  const spend = await db
    .select({
      publisherId: campaigns.publisherId,
      spend: sql<string | null>`sum(${campaignCosts.amount})`,
    })
    .from(campaignCosts)
    .innerJoin(campaigns, eq(campaigns.id, campaignCosts.campaignId))
    .where(
      and(
        gte(campaignCosts.costDate, window.from.toISOString().slice(0, 10)),
        lte(campaignCosts.costDate, window.to.toISOString().slice(0, 10)),
      ),
    )
    .groupBy(campaigns.publisherId);

  const reportedBy = new Map(reported.map((r) => [r.publisherId, r]));
  const spendBy = new Map(spend.map((s) => [s.publisherId, Number(s.spend)]));

  return clicks.map((row) => {
    const rep = reportedBy.get(row.publisherId);
    const publisherClicks = rep?.clicks ?? null;
    const spendValue = spendBy.get(row.publisherId) ?? null;

    return {
      publisherId: row.publisherId,
      publisherName: row.publisherName,
      clicks: row.clicks,
      filteredClicks: row.filteredClicks,
      uniqueEstimate: row.uniqueEstimate,
      publisherReportedClicks: publisherClicks,
      publisherReportedImpressions: rep?.impressions ?? null,
      clickDiscrepancy: publisherClicks === null ? null : row.clicks - publisherClicks,
      clickDiscrepancyPct:
        publisherClicks === null || publisherClicks === 0
          ? null
          : ((row.clicks - publisherClicks) / publisherClicks) * 100,
      spend: spendValue,
      // N/A rather than a divide-by-zero or an infinity (PRD §10).
      costPerClick: spendValue === null || row.clicks === 0 ? null : spendValue / row.clicks,
    };
  });
}

export interface FunnelStage {
  key: string;
  label: string;
  value: number | null;
  availability: Availability;
  note: string;
}

export interface FunnelReport {
  channel: 'website' | 'whatsapp';
  stages: FunnelStage[];
}

/**
 * Website and WhatsApp funnels are returned separately and must never be
 * summed together — Backend Schema §9 lists mixing them as a failed
 * acceptance test.
 */
export async function funnels(
  db: Db,
  actor: ActorContext,
  rawFilter: unknown,
): Promise<FunnelReport[]> {
  requirePermission(actor, 'reports:read');
  const filter = parseInput(reportFilterSchema, rawFilter ?? {});
  const window = resolveWindow(filter);

  const [row] = await db
    .select({
      website: sql<number>`count(*) filter (where ${smartLinks.destinationType} = 'website')::int`,
      whatsapp: sql<number>`count(*) filter (where ${smartLinks.destinationType} = 'whatsapp')::int`,
    })
    .from(clickEvents)
    .innerJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .where(and(...clickConditions(filter, window)));

  return [
    {
      channel: 'website',
      stages: [
        { key: 'clicks', label: 'Clicks', value: row?.website ?? 0, availability: 'measured', note: 'Recorded on the redirect endpoint.' },
        { key: 'visits', label: 'Landing visits', value: null, availability: 'unavailable', note: BLOCKED.websiteVisits },
        { key: 'registrations', label: 'Registrations', value: null, availability: 'unavailable', note: BLOCKED.registrations },
        { key: 'ftd', label: 'FTD', value: null, availability: 'unavailable', note: BLOCKED.ftd },
      ],
    },
    {
      channel: 'whatsapp',
      stages: [
        { key: 'clicks', label: 'Clicks', value: row?.whatsapp ?? 0, availability: 'measured', note: 'Recorded on the redirect endpoint.' },
        { key: 'opens', label: 'WhatsApp opens', value: null, availability: 'unavailable', note: BLOCKED.whatsappOpens },
        { key: 'leads', label: 'Actual leads', value: null, availability: 'unavailable', note: BLOCKED.leads },
        { key: 'registrations', label: 'Registrations', value: null, availability: 'unavailable', note: BLOCKED.registrations },
        { key: 'ftd', label: 'FTD', value: null, availability: 'unavailable', note: BLOCKED.ftd },
      ],
    },
  ];
}

export interface AttributionCoverage {
  totalClicks: number;
  /** Clicks whose destination version still resolves to an approved destination. */
  resolvable: number;
  byConfidence: { confidence: string; count: number }[];
  note: string;
}

export async function attributionCoverage(
  db: Db,
  actor: ActorContext,
  rawFilter: unknown,
): Promise<AttributionCoverage> {
  requirePermission(actor, 'reports:read');
  const filter = parseInput(reportFilterSchema, rawFilter ?? {});
  const window = resolveWindow(filter);

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      resolvable: sql<number>`count(*) filter (where ${destinations.approvalStatus} = 'approved')::int`,
    })
    .from(clickEvents)
    .innerJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .innerJoin(destinationVersions, eq(destinationVersions.id, clickEvents.destinationVersionId))
    .innerJoin(destinations, eq(destinations.id, destinationVersions.destinationId))
    .where(and(...clickConditions(filter, window)));

  return {
    totalClicks: row?.total ?? 0,
    resolvable: row?.resolvable ?? 0,
    // No conversions exist to attribute yet. An empty breakdown is honest;
    // an invented one is what TRD §10 forbids.
    byConfidence: [],
    note:
      'No conversion source is connected, so no attribution decisions exist yet. ' +
      'When they do, unmatched conversions stay in an unknown bucket and are never ' +
      'distributed across campaigns (TRD §10).',
  };
}

export interface GeoRow {
  city: string | null;
  region: string | null;
  country: string | null;
  clicks: number;
  uniqueEstimate: number;
}

/**
 * Clicks grouped by estimated location.
 *
 * Always an estimate (PRD §5). On Indian mobile traffic in particular, city
 * accuracy is weak — carriers route through regional gateways, so a user in a
 * tier-2 city frequently resolves to the state capital. Rows where no location
 * could be derived are returned with null values and counted, rather than
 * dropped: a report that silently omits a third of its traffic is worse than
 * one that says "unknown".
 */
export async function geoBreakdown(
  db: Db,
  actor: ActorContext,
  rawFilter: unknown,
  limit = 50,
): Promise<GeoRow[]> {
  requirePermission(actor, 'reports:read');
  const filter = parseInput(reportFilterSchema, rawFilter ?? {});
  const window = resolveWindow(filter);

  return db
    .select({
      city: clickEvents.geoCity,
      region: clickEvents.geoRegion,
      country: clickEvents.geoCountry,
      clicks: sql<number>`count(*)::int`,
      uniqueEstimate: sql<number>`count(distinct ${clickEvents.visitorTokenHash})::int`,
    })
    .from(clickEvents)
    .innerJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .where(and(...clickConditions(filter, window)))
    .groupBy(clickEvents.geoCity, clickEvents.geoRegion, clickEvents.geoCountry)
    .orderBy(sql`4 desc`)
    .limit(limit);
}

/** Rows behind the clicks report, for CSV export and the Reports table. */
export async function clickDetail(
  db: Db,
  actor: ActorContext,
  rawFilter: unknown,
  limit = 5000,
) {
  requirePermission(actor, 'reports:read');
  const filter = parseInput(reportFilterSchema, rawFilter ?? {});
  const window = resolveWindow(filter);

  return db
    .select({
      occurredAt: clickEvents.occurredAt,
      clickId: clickEvents.clickId,
      publisher: publishers.name,
      campaign: campaigns.name,
      slug: smartLinks.slug,
      destinationType: smartLinks.destinationType,
      destinationVersion: destinationVersions.version,
      device: clickEvents.deviceType,
      os: clickEvents.os,
      publisherClickId: clickEvents.publisherClickId,
      isFiltered: clickEvents.isFiltered,
      botFlags: clickEvents.botFlags,
    })
    .from(clickEvents)
    .innerJoin(smartLinks, eq(smartLinks.id, clickEvents.smartLinkId))
    .innerJoin(campaigns, eq(campaigns.id, clickEvents.campaignId))
    .innerJoin(publishers, eq(publishers.id, clickEvents.publisherId))
    .innerJoin(destinationVersions, eq(destinationVersions.id, clickEvents.destinationVersionId))
    .where(and(...clickConditions(filter, window)))
    .orderBy(sql`${clickEvents.occurredAt} desc`)
    .limit(limit);
}
