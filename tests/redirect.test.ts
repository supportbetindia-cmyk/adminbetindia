/**
 * Acceptance tests for the redirect engine.
 *
 * These map directly onto Backend Database Schema §9 "Acceptance tests" and
 * TRD §16, and run against a real PostgreSQL database rather than mocks —
 * the constraints being tested (uniqueness, version pinning, foreign keys)
 * only exist in the database.
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../src/db';
import {
  adminUsers, campaigns, clickEvents, creatives, destinations,
  destinationVersions, publishers, smartLinks,
} from '../src/db/schema';
import { resolveAndRecordClick } from '../src/services/redirect';
import { deriveClientSignals } from '../src/lib/client-signals';
import { assertSafeDestination, buildRedirectUrl, UnsafeDestinationError } from '../src/lib/destination-url';

const HUMAN = deriveClientSignals({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  purposeHeaders: [],
  method: 'GET',
});

function request(slug: string, overrides: Partial<Parameters<typeof resolveAndRecordClick>[1]> = {}) {
  return {
    slug,
    signals: HUMAN,
    referrer: null,
    ipHash: null,
    visitorTokenHash: null,
    publisherClickId: null,
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
    ...overrides,
  };
}

/** Builds an isolated publisher → campaign → link graph for one test. */
async function fixture(opts: {
  slug: string;
  linkStatus?: 'draft' | 'active' | 'paused' | 'ended';
  destinationUrl?: string;
  destinationType?: 'website' | 'whatsapp';
  approvalStatus?: 'pending' | 'approved' | 'rejected' | 'revoked';
  expiresAt?: Date | null;
  campaignStartsAt?: Date | null;
  campaignEndsAt?: Date | null;
}) {
  const [admin] = await db
    .insert(adminUsers)
    .values({ email: `test-${opts.slug}@example.test`, role: 'super_admin' })
    .returning();
  const [publisher] = await db
    .insert(publishers)
    .values({ name: `Test Publisher ${opts.slug}` })
    .returning();
  const [campaign] = await db
    .insert(campaigns)
    .values({
      publisherId: publisher.id,
      name: `Test Campaign ${opts.slug}`,
      status: 'active',
      startsAt: opts.campaignStartsAt ?? new Date(Date.now() - 86_400_000),
      endsAt: opts.campaignEndsAt ?? new Date(Date.now() + 86_400_000),
    })
    .returning();
  const [creative] = await db
    .insert(creatives)
    .values({ campaignId: campaign.id, name: 'Test creative', approvalStatus: 'approved' })
    .returning();
  const [destination] = await db
    .insert(destinations)
    .values({
      type: opts.destinationType ?? 'website',
      url: opts.destinationUrl ?? 'https://www.betindia.bet/promo/test',
      approvalStatus: opts.approvalStatus ?? 'approved',
      approvedBy: admin.id,
      approvedAt: new Date(),
    })
    .returning();
  const [link] = await db
    .insert(smartLinks)
    .values({
      campaignId: campaign.id,
      creativeId: creative.id,
      slug: opts.slug,
      destinationType: destination.type,
      activeDestinationId: destination.id,
      activeDestinationVersion: 1,
      status: opts.linkStatus ?? 'active',
      expiresAt: opts.expiresAt ?? null,
      createdBy: admin.id,
    })
    .returning();
  const [version] = await db
    .insert(destinationVersions)
    .values({ smartLinkId: link.id, destinationId: destination.id, version: 1, changedBy: admin.id })
    .returning();

  return { admin, publisher, campaign, creative, destination, link, version };
}

const uniq = () => Math.random().toString(36).slice(2, 8);

// ─────────────────────────────────────────────────────────────

test('one click creates one unique click ID and redirects to the approved destination', async () => {
  const slug = `t-ok-${uniq()}`;
  const f = await fixture({ slug });

  const outcome = await resolveAndRecordClick(db, request(slug));

  assert.equal(outcome.status, 'redirect');
  if (outcome.status !== 'redirect') return;

  assert.ok(outcome.url.startsWith('https://www.betindia.bet/promo/test'));
  assert.ok(outcome.url.includes(`bi_click=${outcome.clickId}`));

  const rows = await db.select().from(clickEvents).where(eq(clickEvents.clickId, outcome.clickId));
  assert.equal(rows.length, 1, 'exactly one click row written');
  assert.equal(rows[0].smartLinkId, f.link.id);
  assert.equal(rows[0].destinationVersionId, f.version.id, 'click pins the destination version');
  assert.equal(rows[0].deviceType, 'mobile');
  assert.equal(rows[0].os, 'Android');
});

test('two clicks on the same link produce two distinct click IDs', async () => {
  const slug = `t-two-${uniq()}`;
  await fixture({ slug });

  const a = await resolveAndRecordClick(db, request(slug));
  const b = await resolveAndRecordClick(db, request(slug));

  assert.equal(a.status, 'redirect');
  assert.equal(b.status, 'redirect');
  if (a.status !== 'redirect' || b.status !== 'redirect') return;
  assert.notEqual(a.clickId, b.clickId);
});

test('changing a destination creates a new version and does not alter historical clicks', async () => {
  const slug = `t-ver-${uniq()}`;
  const f = await fixture({ slug });

  const first = await resolveAndRecordClick(db, request(slug));
  assert.equal(first.status, 'redirect');
  if (first.status !== 'redirect') return;

  // Approve and switch to a new destination, as an admin action would.
  const [newDest] = await db
    .insert(destinations)
    .values({
      type: 'website',
      url: 'https://www.betindia.bet/promo/changed',
      approvalStatus: 'approved',
      approvedBy: f.admin.id,
      approvedAt: new Date(),
    })
    .returning();
  const [v2] = await db
    .insert(destinationVersions)
    .values({ smartLinkId: f.link.id, destinationId: newDest.id, version: 2, changedBy: f.admin.id })
    .returning();
  await db
    .update(smartLinks)
    .set({ activeDestinationId: newDest.id, activeDestinationVersion: 2 })
    .where(eq(smartLinks.id, f.link.id));

  const second = await resolveAndRecordClick(db, request(slug));
  assert.equal(second.status, 'redirect');
  if (second.status !== 'redirect') return;
  assert.ok(second.url.includes('/promo/changed'), 'new click uses the new destination');

  // The historical click still points at version 1 and its original URL.
  const [old] = await db.select().from(clickEvents).where(eq(clickEvents.clickId, first.clickId));
  assert.equal(old.destinationVersionId, f.version.id, 'historical click unchanged');
  assert.notEqual(old.destinationVersionId, v2.id);
});

test('paused, draft and ended links do not redirect', async () => {
  for (const status of ['paused', 'draft', 'ended'] as const) {
    const slug = `t-${status}-${uniq()}`;
    await fixture({ slug, linkStatus: status });
    const outcome = await resolveAndRecordClick(db, request(slug));
    assert.equal(outcome.status, 'not_active', `${status} link must not redirect`);
  }
});

test('an expired link does not redirect', async () => {
  const slug = `t-exp-${uniq()}`;
  await fixture({ slug, expiresAt: new Date(Date.now() - 1000) });
  const outcome = await resolveAndRecordClick(db, request(slug));
  assert.equal(outcome.status, 'expired');
});

test('a click outside the campaign window does not redirect', async () => {
  const slug = `t-win-${uniq()}`;
  await fixture({
    slug,
    campaignStartsAt: new Date(Date.now() - 10 * 86_400_000),
    campaignEndsAt: new Date(Date.now() - 86_400_000),
  });
  const outcome = await resolveAndRecordClick(db, request(slug));
  assert.equal(outcome.status, 'campaign_window');
});

test('an unapproved destination is never redirected to', async () => {
  const slug = `t-unappr-${uniq()}`;
  await fixture({ slug, approvalStatus: 'pending' });
  const outcome = await resolveAndRecordClick(db, request(slug));
  assert.equal(outcome.status, 'no_approved_destination');
});

test('a rejected link writes no click row', async () => {
  const slug = `t-noclick-${uniq()}`;
  const f = await fixture({ slug, linkStatus: 'paused' });
  await resolveAndRecordClick(db, request(slug));
  const rows = await db.select().from(clickEvents).where(eq(clickEvents.smartLinkId, f.link.id));
  assert.equal(rows.length, 0);
});

test('an unknown slug returns not_found', async () => {
  const outcome = await resolveAndRecordClick(db, request(`missing-${uniq()}`));
  assert.equal(outcome.status, 'not_found');
});

test('WhatsApp destinations carry a campaign reference in the prefilled text', async () => {
  const slug = `t-wa-${uniq()}`;
  await fixture({
    slug,
    destinationType: 'whatsapp',
    destinationUrl: 'https://wa.me/919000000000?text=Hi',
  });

  const outcome = await resolveAndRecordClick(db, request(slug));
  assert.equal(outcome.status, 'redirect');
  if (outcome.status !== 'redirect') return;

  const url = new URL(outcome.url);
  assert.equal(url.hostname, 'wa.me');
  assert.ok(url.searchParams.get('text')?.includes(`BI-${slug.toUpperCase()}`));
  // The click ID must NOT be pushed into WhatsApp — it does not survive, and
  // pretending otherwise is exactly what PRD §7 warns against.
  assert.ok(!outcome.url.includes(outcome.clickId));
});

test('bot and preview-fetcher hits are recorded and flagged, not dropped', async () => {
  const slug = `t-bot-${uniq()}`;
  await fixture({ slug });

  const preview = deriveClientSignals({
    userAgent: 'WhatsApp/2.23.20.0 A',
    purposeHeaders: [],
    method: 'GET',
  });
  assert.ok(preview.botFlags.includes('link_preview_fetcher'));

  const outcome = await resolveAndRecordClick(db, request(slug, { signals: preview }));
  assert.equal(outcome.status, 'redirect');
  if (outcome.status !== 'redirect') return;

  const [row] = await db.select().from(clickEvents).where(eq(clickEvents.clickId, outcome.clickId));
  assert.ok(row, 'raw click row still written — raw counts are never silently altered');
  assert.equal(row.isFiltered, true);
  assert.ok((row.botScore ?? 0) >= 0.8);
  assert.match(row.botFlags ?? '', /link_preview_fetcher/);
});

test('open redirects are refused: destination hosts must be allowlisted', () => {
  assert.throws(
    () => assertSafeDestination('https://evil.example.com/steal'),
    UnsafeDestinationError,
  );
  assert.throws(() => assertSafeDestination('http://www.betindia.bet/'), UnsafeDestinationError);
  assert.throws(
    () => assertSafeDestination('https://user:pass@www.betindia.bet/'),
    UnsafeDestinationError,
  );
  assert.doesNotThrow(() => assertSafeDestination('https://www.betindia.bet/promo'));
});

test('an empty SMART_LINK_BASE_URL falls back rather than producing a relative URL', async () => {
  const { shortUrlBase, shortUrlFor } = await import('../src/services/smart-links');
  const original = process.env.SMART_LINK_BASE_URL;

  try {
    for (const blank of ['', '   ']) {
      process.env.SMART_LINK_BASE_URL = blank;
      assert.ok(
        shortUrlBase().startsWith('https://'),
        'a blank env var must not yield an empty base — the URL goes into a publisher banner',
      );
      assert.ok(shortUrlFor('x').startsWith('https://'));
    }

    process.env.SMART_LINK_BASE_URL = 'https://go.betindia.games/';
    assert.equal(shortUrlFor('abc'), 'https://go.betindia.games/c/abc', 'trailing slash is trimmed');
  } finally {
    if (original === undefined) delete process.env.SMART_LINK_BASE_URL;
    else process.env.SMART_LINK_BASE_URL = original;
  }
});

test('inbound query parameters are not forwarded to the destination', () => {
  const url = buildRedirectUrl({
    destinationUrl: 'https://www.betindia.bet/promo?keep=1',
    kind: 'website',
    clickId: 'abc123',
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('keep'), '1', 'destination’s own params are preserved');
  assert.equal(parsed.searchParams.get('bi_click'), 'abc123');
  assert.equal(parsed.searchParams.get('utm_source'), null, 'nothing inbound is added');
});

test.after(async () => {
  await pool.end();
});
