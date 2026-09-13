/**
 * Redirect engine — the core of the system.
 *
 * Implements TRD §5 and Backend Schema §9:
 *   1. validate link status, date window and approved destination version
 *   2. mint a cryptographically random click_id
 *   3. record the click durably BEFORE redirecting
 *   4. return 302 with a Location taken only from the approved registry
 *
 * "A click record must not depend on the destination successfully loading"
 * (TRD §5) — so the write happens first, and nothing about the user's browser
 * reaching the destination can change whether the click was counted.
 *
 * Kept free of Next.js types so it can be tested directly against the database.
 */

import { and, eq } from 'drizzle-orm';
import type { db as Database } from '@/db';
import {
  campaigns, clickEvents, destinations, destinationVersions, publishers, smartLinks,
} from '@/db/schema';
import { generateClickId } from '@/lib/ids';
import { buildRedirectUrl, UnsafeDestinationError } from '@/lib/destination-url';
import type { ClientSignals } from '@/lib/client-signals';
import { UNKNOWN_GEO, type GeoEstimate } from '@/lib/geo';

export type RedirectOutcome =
  | { status: 'redirect'; url: string; clickId: string; filtered: boolean }
  | { status: 'not_found' }
  | { status: 'not_active'; reason: 'draft' | 'paused' | 'ended' }
  | { status: 'expired' }
  | { status: 'campaign_window' }
  | { status: 'no_approved_destination' }
  | { status: 'unsafe_destination'; detail: string };

export interface RedirectRequest {
  slug: string;
  signals: ClientSignals;
  referrer: string | null;
  ipHash: string | null;
  /**
   * Already resolved by the caller, which holds the raw IP. The address itself
   * never enters this service or the database — only its salted hash and this
   * estimate (PRD §13, Schema §8).
   */
  geo?: GeoEstimate;
  visitorTokenHash: string | null;
  /** Publisher click ID captured from an approved macro parameter. */
  publisherClickId: string | null;
  utm: {
    source: string | null;
    medium: string | null;
    campaign: string | null;
    content: string | null;
    term: string | null;
  };
  now?: Date;
}

type Db = typeof Database;

export async function resolveAndRecordClick(
  db: Db,
  req: RedirectRequest,
): Promise<RedirectOutcome> {
  const now = req.now ?? new Date();

  // ── 1. resolve link, campaign, publisher, destination and pinned version ──
  const rows = await db
    .select({
      link: {
        id: smartLinks.id,
        status: smartLinks.status,
        expiresAt: smartLinks.expiresAt,
        creativeId: smartLinks.creativeId,
        destinationType: smartLinks.destinationType,
        activeVersion: smartLinks.activeDestinationVersion,
      },
      campaign: {
        id: campaigns.id,
        status: campaigns.status,
        startsAt: campaigns.startsAt,
        endsAt: campaigns.endsAt,
      },
      publisher: { id: publishers.id, status: publishers.status },
      version: { id: destinationVersions.id, version: destinationVersions.version },
      destination: {
        id: destinations.id,
        url: destinations.url,
        type: destinations.type,
        approvalStatus: destinations.approvalStatus,
      },
    })
    .from(smartLinks)
    .innerJoin(campaigns, eq(campaigns.id, smartLinks.campaignId))
    .innerJoin(publishers, eq(publishers.id, campaigns.publisherId))
    .leftJoin(
      destinationVersions,
      and(
        eq(destinationVersions.smartLinkId, smartLinks.id),
        eq(destinationVersions.version, smartLinks.activeDestinationVersion),
      ),
    )
    .leftJoin(destinations, eq(destinations.id, destinationVersions.destinationId))
    .where(eq(smartLinks.slug, req.slug))
    .limit(1);

  const row = rows[0];
  if (!row) return { status: 'not_found' };

  // ── 2. validate ──────────────────────────────────────────────
  if (row.link.status !== 'active') {
    return { status: 'not_active', reason: row.link.status as 'draft' | 'paused' | 'ended' };
  }

  if (row.link.expiresAt && row.link.expiresAt.getTime() <= now.getTime()) {
    return { status: 'expired' };
  }

  if (row.campaign.status === 'paused' || row.campaign.status === 'ended') {
    return { status: 'campaign_window' };
  }

  if (row.campaign.startsAt && now.getTime() < row.campaign.startsAt.getTime()) {
    return { status: 'campaign_window' };
  }

  if (row.campaign.endsAt && now.getTime() > row.campaign.endsAt.getTime()) {
    return { status: 'campaign_window' };
  }

  // Never silently fall back to an unapproved destination (PRD §4).
  if (!row.version || !row.destination) return { status: 'no_approved_destination' };
  if (row.destination.approvalStatus !== 'approved') {
    return { status: 'no_approved_destination' };
  }

  // ── 3. mint click ID and build the destination ───────────────
  const clickId = generateClickId();

  let url: string;
  try {
    url = buildRedirectUrl({
      destinationUrl: row.destination.url,
      kind: row.destination.type,
      clickId,
      // Campaign reference for WhatsApp is derived from the slug so it is
      // stable and reversible. Still unverified end to end — see PRD §7.
      campaignReference:
        row.destination.type === 'whatsapp' ? `BI-${req.slug.toUpperCase()}` : null,
    });
  } catch (err) {
    if (err instanceof UnsafeDestinationError) {
      return { status: 'unsafe_destination', detail: err.message };
    }
    throw err;
  }

  // ── 4. record the click durably, before redirecting ──────────
  await db.insert(clickEvents).values({
    clickId,
    smartLinkId: row.link.id,
    campaignId: row.campaign.id,
    publisherId: row.publisher.id,
    creativeId: row.link.creativeId,
    destinationVersionId: row.version.id,
    occurredAt: now,
    visitorTokenHash: req.visitorTokenHash,
    publisherClickId: req.publisherClickId,
    deviceType: req.signals.deviceType,
    os: req.signals.os,
    referrer: req.referrer,
    ipHash: req.ipHash,
    geoCountry: (req.geo ?? UNKNOWN_GEO).country,
    geoRegion: (req.geo ?? UNKNOWN_GEO).region,
    geoCity: (req.geo ?? UNKNOWN_GEO).city,
    geoSource: (req.geo ?? UNKNOWN_GEO).source,
    utmSource: req.utm.source,
    utmMedium: req.utm.medium,
    utmCampaign: req.utm.campaign,
    utmContent: req.utm.content,
    utmTerm: req.utm.term,
    botScore: req.signals.botScore,
    botFlags: req.signals.botFlags.length ? req.signals.botFlags.join(',') : null,
    isFiltered: req.signals.isFiltered,
  });

  return { status: 'redirect', url, clickId, filtered: req.signals.isFiltered };
}
