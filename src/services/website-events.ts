/**
 * Website event ingestion (TRD §6, §7; PRD §6).
 *
 * Receives first-party events from betindia.bet so a landing visit can be tied
 * back to the click that produced it.
 *
 * The rule this service exists to hold: **a form submission is not a
 * registration.** PRD §6 and TRD §9 both require a registration to have a real
 * external user ID and a completed account, which only the betting platform
 * can confirm. So `registration_submitted` is recorded as a website event and
 * never as a registration — it populates the website funnel, not the
 * registration count.
 *
 * No personal data is accepted. The click ID is a random event identifier and
 * the session token arrives already hashed; nothing here can identify a person
 * (PRD §13, Schema §8).
 *
 * Free of Next.js types so it can be tested directly against the database.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { clickEvents, websiteEvents, websiteSessions } from '@/db/schema';

type Db = typeof Database;

/**
 * Accepted event types. A closed set on purpose: an open one becomes a dumping
 * ground, and every type here has to mean something specific in the funnel.
 */
export const WEBSITE_EVENT_TYPES = [
  'landing',
  'page_view',
  'cta_click',
  'registration_started',
  /** Submitted, NOT completed. Verification comes from the platform, not here. */
  'registration_submitted',
] as const;

export type WebsiteEventType = (typeof WEBSITE_EVENT_TYPES)[number];

export type ConsentStatus = 'granted' | 'denied' | 'unknown';

export interface WebsiteEventInput {
  /** Click ID from the smart link, if the visitor arrived through one. */
  clickId: string | null;
  /** Salted hash of the site's own session token. The raw token stays in the browser. */
  sessionTokenHash: string;
  eventType: WebsiteEventType;
  /** Caller-supplied idempotency key; a retry with the same key is absorbed. */
  eventKey: string;
  pagePath: string | null;
  landingUrl: string | null;
  consent: ConsentStatus;
  occurredAt?: Date;
  metadata?: Record<string, unknown> | null;
}

export type WebsiteEventResult =
  | { status: 'recorded'; sessionId: string; attribution: AttributionStatus }
  | { status: 'duplicate'; sessionId: string };

/**
 * Whether the event could be tied to a real click.
 *
 * `unmatched` is a first-class outcome, not a failure — TRD §10 requires
 * unknown attribution stay unknown rather than be guessed at.
 */
export type AttributionStatus = 'matched' | 'unmatched';

/** Cheap sanity check before a value is used as a lookup key. */
const CLICK_ID_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Records one website event, creating or reusing its session.
 *
 * The click ID is verified against `click_events` rather than trusted. Anyone
 * can post an arbitrary string to a public endpoint, and an unverified one
 * would manufacture attribution out of nothing.
 */
export async function recordWebsiteEvent(
  db: Db,
  input: WebsiteEventInput,
): Promise<WebsiteEventResult> {
  const occurredAt = input.occurredAt ?? new Date();

  let clickId: string | null = null;
  let attribution: AttributionStatus = 'unmatched';

  if (input.clickId && CLICK_ID_SHAPE.test(input.clickId)) {
    const [existing] = await db
      .select({ clickId: clickEvents.clickId })
      .from(clickEvents)
      .where(eq(clickEvents.clickId, input.clickId))
      .limit(1);

    if (existing) {
      clickId = existing.clickId;
      attribution = 'matched';
    }
    // A click ID we have no record of is discarded rather than stored. It
    // would otherwise look like attribution while pointing at nothing.
  }

  // One session per token. Later events reuse it rather than creating a new
  // one, so a visit is a visit and not one-visit-per-page.
  const [session] = await db
    .insert(websiteSessions)
    .values({
      clickId,
      sessionTokenHash: input.sessionTokenHash,
      startedAt: occurredAt,
      landingUrl: input.landingUrl,
      consentStatus: input.consent,
      attributionStatus: attribution,
    })
    .onConflictDoUpdate({
      target: websiteSessions.sessionTokenHash,
      set: {
        // Only fill in a click ID we did not already have; never overwrite a
        // matched attribution with a later unmatched page view.
        clickId: sql`coalesce(${websiteSessions.clickId}, excluded.click_id)`,
        attributionStatus: sql`
          case when ${websiteSessions.clickId} is not null
               then ${websiteSessions.attributionStatus}
               else excluded.attribution_status end`,
        /*
         * An explicit granted/denied is kept unless the visitor explicitly
         * changes it. A later event that simply does not know the consent
         * state must not silently downgrade a recorded decision to 'unknown' —
         * consent is a record of what the person chose, not of what the last
         * request happened to carry (PRD §13).
         */
        consentStatus: sql`
          case when excluded.consent_status = 'unknown'
               then ${websiteSessions.consentStatus}
               else excluded.consent_status end`,
      },
    })
    .returning({ id: websiteSessions.id, attributionStatus: websiteSessions.attributionStatus });

  const inserted = await db
    .insert(websiteEvents)
    .values({
      sessionId: session.id,
      eventType: input.eventType,
      occurredAt,
      eventKey: input.eventKey,
      metadata: input.metadata ?? null,
    })
    .onConflictDoNothing({ target: websiteEvents.eventKey })
    .returning({ id: websiteEvents.id });

  if (inserted.length === 0) {
    return { status: 'duplicate', sessionId: session.id };
  }

  return {
    status: 'recorded',
    sessionId: session.id,
    attribution: session.attributionStatus as AttributionStatus,
  };
}

export interface WebsiteFunnelSummary {
  sessions: number;
  matchedSessions: number;
  unmatchedSessions: number;
  byEventType: { eventType: string; count: number }[];
}

/**
 * Website funnel counts.
 *
 * `registration_submitted` is reported under its own name and deliberately not
 * called a registration — the distinction is the whole point (PRD §6).
 */
export async function websiteFunnelSummary(db: Db): Promise<WebsiteFunnelSummary> {
  const [sessions] = await db
    .select({
      total: sql<number>`count(*)::int`,
      matched: sql<number>`count(*) filter (where ${websiteSessions.attributionStatus} = 'matched')::int`,
    })
    .from(websiteSessions);

  const byType = await db
    .select({
      eventType: websiteEvents.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(websiteEvents)
    .groupBy(websiteEvents.eventType)
    .orderBy(sql`2 desc`);

  return {
    sessions: sessions?.total ?? 0,
    matchedSessions: sessions?.matched ?? 0,
    unmatchedSessions: (sessions?.total ?? 0) - (sessions?.matched ?? 0),
    byEventType: byType,
  };
}

/** Whether any website event has ever arrived — drives "source connected?" in reports. */
export async function hasWebsiteEvents(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(websiteEvents)
    .limit(1);
  return (row?.n ?? 0) > 0;
}

/** Recent sessions, for the Registrations screen and debugging an integration. */
export async function recentWebsiteSessions(db: Db, limit = 50) {
  return db
    .select({
      id: websiteSessions.id,
      clickId: websiteSessions.clickId,
      startedAt: websiteSessions.startedAt,
      landingUrl: websiteSessions.landingUrl,
      consentStatus: websiteSessions.consentStatus,
      attributionStatus: websiteSessions.attributionStatus,
      eventCount: sql<number>`(
        select count(*)::int from ${websiteEvents}
        where ${websiteEvents.sessionId} = ${websiteSessions.id}
      )`,
    })
    .from(websiteSessions)
    .orderBy(sql`${websiteSessions.startedAt} desc`)
    .limit(limit);
}

/** Matches a session whose click is known, used when checking an integration end to end. */
export async function findSessionByClickId(db: Db, clickId: string) {
  const [row] = await db
    .select()
    .from(websiteSessions)
    .where(and(eq(websiteSessions.clickId, clickId)))
    .limit(1);
  return row ?? null;
}
