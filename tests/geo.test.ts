/**
 * Tests for IP-derived location.
 *
 * The behaviour that matters most here is what happens when geo is
 * *unavailable*: a redirect must never fail, and must never be delayed,
 * because a lookup table is missing (TRD §15). PRD §5 also requires the result
 * be treated as an estimate rather than a fact.
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { clickEvents } from '../src/db/schema';
import { lookupGeo, resetGeoReader, warmGeoReader, UNKNOWN_GEO } from '../src/lib/geo';

// ─── Graceful degradation ────────────────────────────────────

test('a missing database yields unknown rather than throwing', async () => {
  const original = process.env.GEOIP_DB_PATH;
  process.env.GEOIP_DB_PATH = './data/definitely-not-here.mmdb';
  resetGeoReader();

  try {
    const result = await lookupGeo('49.36.128.1');
    assert.deepEqual(result, UNKNOWN_GEO, 'a redirect must not depend on a lookup table existing');
  } finally {
    if (original === undefined) delete process.env.GEOIP_DB_PATH;
    else process.env.GEOIP_DB_PATH = original;
    resetGeoReader();
  }
});

test('a null or private address is not looked up', async () => {
  for (const ip of [null, '127.0.0.1', '::1', '192.168.1.1', '10.0.0.5', '172.16.0.1']) {
    const result = await lookupGeo(ip);
    assert.equal(result.source, 'unavailable', `${ip} must not resolve`);
    assert.equal(result.city, null);
  }
});

test('a warm lookup is fast enough for the redirect path', async () => {
  // Warm first: the initial call loads a 63MB database, which is a one-time
  // startup cost handled by warmGeoReader(), not a per-click cost.
  await warmGeoReader();
  await lookupGeo('49.36.128.1');

  const startedAt = performance.now();
  for (let i = 0; i < 100; i += 1) await lookupGeo('49.36.128.1');
  const perLookup = (performance.now() - startedAt) / 100;

  // TRD §15 budgets p95 under 300ms end to end. A local lookup is
  // sub-millisecond; anything approaching 10ms means a network call crept in.
  assert.ok(perLookup < 10, `geo lookup averaged ${perLookup.toFixed(2)}ms — it must not make a network call`);
});

test('the database is warmed at startup, not on the first click', async () => {
  resetGeoReader();

  const coldStart = performance.now();
  await warmGeoReader();
  const loadMs = performance.now() - coldStart;

  const afterWarm = performance.now();
  await lookupGeo('49.36.128.1');
  const lookupMs = performance.now() - afterWarm;

  // The load is the expensive part and belongs at boot. If a lookup ever costs
  // anything close to the load, warming has stopped working and the first
  // click after each restart is paying for it.
  assert.ok(
    lookupMs < Math.max(loadMs / 4, 5),
    `warming is not effective: load ${loadMs.toFixed(0)}ms vs lookup ${lookupMs.toFixed(2)}ms`,
  );
});

// ─── CDN headers take precedence ─────────────────────────────

test('CDN headers are used when present, and marked as such', async () => {
  const headers = new Headers({
    'cf-ipcity': 'Mumbai',
    'cf-ipcountry': 'in',
    'cf-region': 'Maharashtra',
  });

  const result = await lookupGeo('49.36.128.1', headers);

  assert.equal(result.city, 'Mumbai');
  assert.equal(result.country, 'IN', 'country is normalised to uppercase ISO-3166');
  assert.equal(result.region, 'Maharashtra');
  assert.equal(
    result.source, 'cdn_header',
    'the source must distinguish an edge-resolved value from a local database guess',
  );
});

test('percent-encoded CDN city names are decoded', async () => {
  const headers = new Headers({ 'x-vercel-ip-city': 'New%20Delhi' });
  const result = await lookupGeo('49.36.128.1', headers);
  assert.equal(result.city, 'New Delhi');
});

test('headers with no geo fields fall through rather than returning empty values', async () => {
  const headers = new Headers({ 'user-agent': 'Mozilla/5.0', 'content-type': 'text/html' });
  const result = await lookupGeo(null, headers);
  assert.equal(result.source, 'unavailable');
});

// ─── Storage (PRD §13, Schema §8) ────────────────────────────

test('the estimate is stored on the click and the raw IP is not', async () => {
  const { resolveAndRecordClick } = await import('../src/services/redirect');
  const { deriveClientSignals } = await import('../src/lib/client-signals');
  const { hashIp } = await import('../src/lib/privacy');
  const {
    adminUsers, campaigns, creatives, destinations, destinationVersions, publishers, smartLinks,
  } = await import('../src/db/schema');

  const slug = `t-geo-${Math.random().toString(36).slice(2, 8)}`;
  const rawIp = '49.36.128.77';

  const [admin] = await db.insert(adminUsers)
    .values({ email: `geo-${slug}@example.test`, role: 'super_admin' }).returning();
  const [publisher] = await db.insert(publishers).values({ name: `Geo ${slug}` }).returning();
  const [campaign] = await db.insert(campaigns).values({
    publisherId: publisher.id, name: `Geo ${slug}`, status: 'active',
    startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000),
  }).returning();
  const [creative] = await db.insert(creatives)
    .values({ campaignId: campaign.id, name: 'c', approvalStatus: 'approved' }).returning();
  const [destination] = await db.insert(destinations).values({
    type: 'website', url: `https://www.betindia.bet/promo/${slug}`,
    approvalStatus: 'approved', approvedBy: admin.id, approvedAt: new Date(),
  }).returning();
  const [link] = await db.insert(smartLinks).values({
    campaignId: campaign.id, creativeId: creative.id, slug,
    destinationType: 'website', activeDestinationId: destination.id,
    activeDestinationVersion: 1, status: 'active', createdBy: admin.id,
  }).returning();
  await db.insert(destinationVersions).values({
    smartLinkId: link.id, destinationId: destination.id, version: 1, changedBy: admin.id,
  });

  const outcome = await resolveAndRecordClick(db, {
    slug,
    signals: deriveClientSignals({ userAgent: 'Mozilla/5.0 (Android)', purposeHeaders: [], method: 'GET' }),
    referrer: null,
    ipHash: hashIp(rawIp),
    geo: { city: 'Pune', region: 'Maharashtra', country: 'IN', source: 'maxmind' },
    visitorTokenHash: null,
    publisherClickId: null,
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
  });

  assert.equal(outcome.status, 'redirect');
  if (outcome.status !== 'redirect') return;

  const [row] = await db.select().from(clickEvents).where(eq(clickEvents.clickId, outcome.clickId));

  assert.equal(row.geoCity, 'Pune');
  assert.equal(row.geoRegion, 'Maharashtra');
  assert.equal(row.geoCountry, 'IN');
  assert.equal(row.geoSource, 'maxmind', 'the provenance of the estimate is recorded');

  // The whole point of resolving before hashing.
  assert.ok(!JSON.stringify(row).includes(rawIp), 'the raw IP must never be persisted');
  assert.ok(row.ipHash && row.ipHash !== rawIp, 'only a salted hash is stored');
});

test('a click with no geo still records, with nulls', async () => {
  const { resolveAndRecordClick } = await import('../src/services/redirect');
  const { deriveClientSignals } = await import('../src/lib/client-signals');
  const {
    adminUsers, campaigns, destinations, destinationVersions, publishers, smartLinks,
  } = await import('../src/db/schema');

  const slug = `t-nogeo-${Math.random().toString(36).slice(2, 8)}`;
  const [admin] = await db.insert(adminUsers)
    .values({ email: `nogeo-${slug}@example.test`, role: 'super_admin' }).returning();
  const [publisher] = await db.insert(publishers).values({ name: `NoGeo ${slug}` }).returning();
  const [campaign] = await db.insert(campaigns).values({
    publisherId: publisher.id, name: `NoGeo ${slug}`, status: 'active',
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

  // No `geo` supplied at all — the common case before a database is installed.
  const outcome = await resolveAndRecordClick(db, {
    slug,
    signals: deriveClientSignals({ userAgent: 'Mozilla/5.0', purposeHeaders: [], method: 'GET' }),
    referrer: null,
    ipHash: null,
    visitorTokenHash: null,
    publisherClickId: null,
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
  });

  assert.equal(outcome.status, 'redirect', 'the click is recorded regardless');

  const [row] = await db.select().from(clickEvents).where(eq(clickEvents.clickId, outcome.clickId));
  assert.equal(row.geoCity, null);
  assert.equal(row.geoSource, 'unavailable', 'absence is recorded explicitly, not left null');
});

test.after(async () => {
  await pool.end();
});
