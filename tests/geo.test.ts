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
import { geoStatus, lookupGeo, resetGeoReader, warmGeoReader, UNKNOWN_GEO } from '../src/lib/geo';
import { clientIpSource } from '../src/lib/client-signals';

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

// ─── Diagnostics ─────────────────────────────────────────────

/**
 * The failure mode here is silent by design: with no database every click
 * records `unavailable` and nothing else changes, so there is no symptom to
 * notice. geoStatus() is what turns that into an answer on the Integrations
 * screen, which means what it reports has to be true — someone will move files
 * on a server based on it.
 */

test('geoStatus reports the path it actually tried when the file is missing', async () => {
  const original = process.env.GEOIP_DB_PATH;
  process.env.GEOIP_DB_PATH = '/home/nobody/geoip/GeoLite2-City.mmdb';
  resetGeoReader();

  try {
    const status = await geoStatus();

    assert.equal(status.loaded, false);
    assert.equal(status.fileExists, false);
    assert.equal(status.fileSizeMb, null);
    assert.equal(
      status.configuredPath, '/home/nobody/geoip/GeoLite2-City.mmdb',
      'the exact path must be shown, or the operator cannot check it',
    );
    assert.equal(status.pathFromEnv, true, 'an env-supplied path must not be reported as the default');
    assert.equal(status.sample, null, 'no sample may be claimed when nothing is loaded');
    assert.ok(status.error, 'the reason is reported rather than left to the server logs');
  } finally {
    if (original === undefined) delete process.env.GEOIP_DB_PATH;
    else process.env.GEOIP_DB_PATH = original;
    resetGeoReader();
  }
});

test('geoStatus distinguishes the built-in default from a configured path', async () => {
  const original = process.env.GEOIP_DB_PATH;
  delete process.env.GEOIP_DB_PATH;
  resetGeoReader();

  try {
    const status = await geoStatus();
    assert.equal(
      status.pathFromEnv, false,
      'falling back to a relative default is the thing that breaks on managed hosting — it must be visible',
    );
  } finally {
    if (original === undefined) delete process.env.GEOIP_DB_PATH;
    else process.env.GEOIP_DB_PATH = original;
    resetGeoReader();
  }
});

test('geoStatus proves a loaded database with a real lookup, not just a file check', async () => {
  resetGeoReader();
  const status = await geoStatus();

  // Skipped rather than failed when no database is installed locally: this
  // asserts the shape of a working install, and a developer without the 63MB
  // file is not a broken build.
  if (!status.fileExists) {
    assert.equal(status.loaded, false, 'a missing file must never report as loaded');
    return;
  }

  assert.equal(status.loaded, true);
  assert.ok(status.fileSizeMb && status.fileSizeMb > 1, 'the size tells a .tar.gz apart from the .mmdb');
  assert.ok(status.sample, 'a working database must be demonstrated, not asserted');
  assert.equal(status.sample?.result.source, 'maxmind');
  assert.equal(status.sample?.result.country, 'IN', 'the sample is a known Indian address');
});

test('geoStatus distinguishes an invisible parent from a missing file', async () => {
  const original = process.env.GEOIP_DB_PATH;

  try {
    // The shape seen when the app runs somewhere the configured absolute path
    // does not exist at all — a container, or a different account.
    process.env.GEOIP_DB_PATH = '/home/nobody-at-all/geoip/GeoLite2-City.mmdb';
    resetGeoReader();
    const invisible = await geoStatus();

    assert.equal(invisible.diagnostics.parentExists, false);
    assert.equal(invisible.diagnostics.errorCode, 'ENOENT');
    assert.ok(invisible.diagnostics.cwd, 'the working directory is a path the process is definitely inside');

    // The shape seen when the folder is right but the filename is not. The
    // listing is what makes the difference obvious.
    process.env.GEOIP_DB_PATH = './data/not-the-real-name.mmdb';
    resetGeoReader();
    const wrongName = await geoStatus();

    if (wrongName.diagnostics.parentExists) {
      assert.ok(
        Array.isArray(wrongName.diagnostics.parentEntries),
        'a readable parent must be listed, or the name mismatch stays invisible',
      );
    }
  } finally {
    if (original === undefined) delete process.env.GEOIP_DB_PATH;
    else process.env.GEOIP_DB_PATH = original;
    resetGeoReader();
  }
});

test('a corrected path is picked up without a restart', async () => {
  const original = process.env.GEOIP_DB_PATH;

  try {
    // Fail first, which latches the loader so clicks stop paying for a missing
    // file. This is the state an operator is in while fixing the path.
    process.env.GEOIP_DB_PATH = '/home/nobody-at-all/GeoLite2-City.mmdb';
    resetGeoReader();
    const before = await geoStatus();
    assert.equal(before.loaded, false);

    // Now point it at a real file, exactly as fixing the setting would.
    process.env.GEOIP_DB_PATH = './data/GeoLite2-City.mmdb';
    const after = await geoStatus();

    if (!after.fileExists) return; // no database installed locally

    assert.equal(
      after.loaded, true,
      'the latch must not outlive the fix, or the operator concludes the fix failed',
    );
    assert.ok(after.sample, 'and the claim is backed by a real lookup');

    // The panel must never claim more than a click would actually get.
    const click = await lookupGeo('49.36.128.1');
    assert.equal(click.source, 'maxmind', 'the redirect path sees the same reader');
  } finally {
    if (original === undefined) delete process.env.GEOIP_DB_PATH;
    else process.env.GEOIP_DB_PATH = original;
    resetGeoReader();
  }
});

test('clientIpSource names the header the address came from', () => {
  assert.deepEqual(
    clientIpSource(new Headers({ 'x-forwarded-for': '49.36.128.1, 10.0.0.1' })),
    { header: 'x-forwarded-for', ip: '49.36.128.1' },
    'only the leftmost entry is the client; the rest are proxies',
  );

  assert.deepEqual(
    clientIpSource(new Headers({ 'x-real-ip': '49.36.128.2' })),
    { header: 'x-real-ip', ip: '49.36.128.2' },
  );

  // The case the Integrations screen exists to surface: a proxy that forwards
  // nothing, which makes location unavailable however well the database is
  // installed.
  assert.deepEqual(
    clientIpSource(new Headers({ 'user-agent': 'Mozilla/5.0' })),
    { header: null, ip: null },
  );
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
