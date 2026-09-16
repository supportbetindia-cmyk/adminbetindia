/**
 * Acceptance tests for website event ingestion (TRD §6, §7; PRD §6).
 *
 * The rule under test throughout: a website event is evidence of a visit, not
 * of a registration. PRD §6 — "A form click is not a registration" — and
 * TRD §9 require a real external user ID and a completed account, neither of
 * which a browser can supply.
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../src/db';
import {
  adminUsers, campaigns, clickEvents, destinations, destinationVersions,
  publishers, registrations, smartLinks, websiteEvents, websiteSessions,
} from '../src/db/schema';
import { recordWebsiteEvent, websiteFunnelSummary } from '../src/services/website-events';
import { resolveAndRecordClick } from '../src/services/redirect';
import { deriveClientSignals } from '../src/lib/client-signals';

const uniq = () => Math.random().toString(36).slice(2, 10);

const HUMAN = deriveClientSignals({
  userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile',
  purposeHeaders: [],
  method: 'GET',
});

/** Produces a real click, so a click ID can be tested against a genuine one. */
async function realClick(): Promise<string> {
  const slug = `t-web-${uniq()}`;
  const [admin] = await db.insert(adminUsers)
    .values({ email: `web-${slug}@example.test`, role: 'super_admin' }).returning();
  const [publisher] = await db.insert(publishers).values({ name: `Web ${slug}` }).returning();
  const [campaign] = await db.insert(campaigns).values({
    publisherId: publisher.id, name: `Web ${slug}`, status: 'active',
    startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000),
  }).returning();
  const [destination] = await db.insert(destinations).values({
    type: 'website', url: `https://www.betindia.bet/promo/${slug}`,
    approvalStatus: 'approved', approvedBy: admin.id, approvedAt: new Date(),
  }).returning();
  const [link] = await db.insert(smartLinks).values({
    campaignId: campaign.id, slug, destinationType: 'website',
    activeDestinationId: destination.id, activeDestinationVersion: 1,
    status: 'active', createdBy: admin.id,
  }).returning();
  await db.insert(destinationVersions).values({
    smartLinkId: link.id, destinationId: destination.id, version: 1, changedBy: admin.id,
  });

  const outcome = await resolveAndRecordClick(db, {
    slug, signals: HUMAN, referrer: null, ipHash: null, visitorTokenHash: null,
    publisherClickId: null,
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
  });
  if (outcome.status !== 'redirect') throw new Error('fixture click failed');
  return outcome.clickId;
}

function event(overrides: Partial<Parameters<typeof recordWebsiteEvent>[1]> = {}) {
  const token = `sess-${uniq()}`;
  return {
    clickId: null,
    sessionTokenHash: token,
    eventType: 'landing' as const,
    eventKey: `key-${uniq()}`,
    pagePath: '/promo/welcome',
    landingUrl: 'https://www.betindia.bet/promo/welcome',
    consent: 'unknown' as const,
    ...overrides,
  };
}

// ─── Attribution is verified, never trusted ──────────────────

test('a real click ID is matched to its click', async () => {
  const clickId = await realClick();
  const result = await recordWebsiteEvent(db, event({ clickId }));

  assert.equal(result.status, 'recorded');
  if (result.status !== 'recorded') return;
  assert.equal(result.attribution, 'matched');

  const [session] = await db.select().from(websiteSessions)
    .where(eq(websiteSessions.id, result.sessionId));
  assert.equal(session.clickId, clickId);
});

test('an invented click ID is discarded, not stored as attribution', async () => {
  const result = await recordWebsiteEvent(db, event({ clickId: 'AAAAAAAAAAAAAAAAAAAAAA' }));

  assert.equal(result.status, 'recorded');
  if (result.status !== 'recorded') return;
  assert.equal(result.attribution, 'unmatched');

  const [session] = await db.select().from(websiteSessions)
    .where(eq(websiteSessions.id, result.sessionId));
  assert.equal(
    session.clickId, null,
    'a public endpoint must not let anyone manufacture attribution by posting a string',
  );
});

test('a malformed click ID is ignored rather than rejected', async () => {
  const result = await recordWebsiteEvent(db, event({ clickId: '<script>alert(1)</script>' }));
  assert.equal(result.status, 'recorded', 'the visit is still real even if the id is junk');
  if (result.status !== 'recorded') return;
  assert.equal(result.attribution, 'unmatched');
});

// ─── Sessions group, they do not multiply ────────────────────

test('several events on one visit share a session', async () => {
  const clickId = await realClick();
  const token = `sess-${uniq()}`;

  const landing = await recordWebsiteEvent(db, event({
    clickId, sessionTokenHash: token, eventType: 'landing',
  }));
  const pageView = await recordWebsiteEvent(db, event({
    clickId: null, sessionTokenHash: token, eventType: 'page_view',
  }));

  assert.equal(landing.sessionId, pageView.sessionId, 'a visit is one session, not one per page');

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
    .from(websiteEvents).where(eq(websiteEvents.sessionId, landing.sessionId));
  assert.equal(n, 2);
});

test('a later unattributed page view cannot erase a matched click', async () => {
  const clickId = await realClick();
  const token = `sess-${uniq()}`;

  await recordWebsiteEvent(db, event({ clickId, sessionTokenHash: token, eventType: 'landing' }));
  await recordWebsiteEvent(db, event({
    clickId: null, sessionTokenHash: token, eventType: 'page_view',
  }));

  const [session] = await db.select().from(websiteSessions)
    .where(eq(websiteSessions.sessionTokenHash, token));

  assert.equal(session.clickId, clickId, 'attribution survives subsequent events');
  assert.equal(session.attributionStatus, 'matched');
});

// ─── Idempotency (TRD §6) ────────────────────────────────────

test('the same event key delivered twice is stored once', async () => {
  const token = `sess-${uniq()}`;
  const key = `key-${uniq()}`;

  const first = await recordWebsiteEvent(db, event({ sessionTokenHash: token, eventKey: key }));
  const second = await recordWebsiteEvent(db, event({ sessionTokenHash: token, eventKey: key }));

  assert.equal(first.status, 'recorded');
  assert.equal(second.status, 'duplicate');

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
    .from(websiteEvents).where(eq(websiteEvents.eventKey, key));
  assert.equal(n, 1);
});

// ─── A submission is not a registration (PRD §6, TRD §9) ─────

test('registration_submitted creates no registration', async () => {
  const clickId = await realClick();
  const [before] = await db.select({ n: sql<number>`count(*)::int` }).from(registrations);

  await recordWebsiteEvent(db, event({ clickId, eventType: 'registration_submitted' }));

  const [after] = await db.select({ n: sql<number>`count(*)::int` }).from(registrations);
  assert.equal(
    after.n, before.n,
    'a form submission is not a registration — that needs a real external user ID (TRD §9)',
  );
});

test('the funnel reports submissions under their own name', async () => {
  await recordWebsiteEvent(db, event({ eventType: 'registration_submitted' }));
  const summary = await websiteFunnelSummary(db);

  const submitted = summary.byEventType.find((e) => e.eventType === 'registration_submitted');
  assert.ok(submitted && submitted.count > 0);
  assert.ok(
    !summary.byEventType.some((e) => e.eventType === 'registration'),
    'nothing in the funnel may be called a registration',
  );
});

test('the funnel separates matched from unmatched sessions', async () => {
  const clickId = await realClick();
  await recordWebsiteEvent(db, event({ clickId }));
  await recordWebsiteEvent(db, event({ clickId: null }));

  const summary = await websiteFunnelSummary(db);
  assert.ok(summary.matchedSessions > 0);
  assert.ok(summary.unmatchedSessions > 0);
  assert.equal(
    summary.sessions, summary.matchedSessions + summary.unmatchedSessions,
    'unmatched sessions are counted, not quietly dropped (TRD §10)',
  );
});

// ─── Consent (PRD §6, §13) ───────────────────────────────────

test('consent state is recorded as given, including unknown', async () => {
  for (const consent of ['granted', 'denied', 'unknown'] as const) {
    const result = await recordWebsiteEvent(db, event({ consent }));
    if (result.status !== 'recorded') throw new Error('expected recorded');
    const [session] = await db.select().from(websiteSessions)
      .where(eq(websiteSessions.id, result.sessionId));
    assert.equal(session.consentStatus, consent);
  }
});

test('a later event without consent info cannot downgrade a recorded decision', async () => {
  const token = `sess-${uniq()}`;

  await recordWebsiteEvent(db, event({
    sessionTokenHash: token, eventType: 'landing', consent: 'granted',
  }));
  // A subsequent page view that simply does not carry consent state.
  await recordWebsiteEvent(db, event({
    sessionTokenHash: token, eventType: 'page_view', consent: 'unknown',
  }));

  const [session] = await db.select().from(websiteSessions)
    .where(eq(websiteSessions.sessionTokenHash, token));
  assert.equal(
    session.consentStatus, 'granted',
    'consent records what the person chose, not what the last request happened to carry',
  );
});

test('an explicit withdrawal of consent is honoured', async () => {
  const token = `sess-${uniq()}`;

  await recordWebsiteEvent(db, event({
    sessionTokenHash: token, eventType: 'landing', consent: 'granted',
  }));
  await recordWebsiteEvent(db, event({
    sessionTokenHash: token, eventType: 'page_view', consent: 'denied',
  }));

  const [session] = await db.select().from(websiteSessions)
    .where(eq(websiteSessions.sessionTokenHash, token));
  assert.equal(session.consentStatus, 'denied', 'an explicit change must still take effect');
});

test('no raw click id leaks into a session that never had one', async () => {
  const result = await recordWebsiteEvent(db, event({ clickId: null }));
  if (result.status !== 'recorded') throw new Error('expected recorded');

  const [session] = await db.select().from(websiteSessions)
    .where(eq(websiteSessions.id, result.sessionId));
  assert.equal(session.clickId, null);
  assert.equal(session.attributionStatus, 'unmatched');
});

test.after(async () => {
  await pool.end();
});
