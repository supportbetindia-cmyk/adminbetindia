/**
 * Acceptance tests for verified registration ingestion (PRD §6, §8;
 * TRD §9, §10; Backend Schema §9).
 *
 * The rules under test:
 *  - a registration needs a real external user ID
 *  - duplicate delivery does not duplicate a registration
 *  - only an exact click_id join attributes; nothing is guessed
 *  - unmatched registrations stay unmatched and are still counted
 *  - the ad that produced a registration is the one that was clicked
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../src/db';
import {
  adminUsers, campaigns, clickEvents, conversionAttributions, creatives,
  destinations, destinationVersions, publishers, registrations, smartLinks,
} from '../src/db/schema';
import {
  listRegistrations, recordRegistration, registrationSummary,
} from '../src/services/registrations';
import { resolveAndRecordClick } from '../src/services/redirect';
import { deriveClientSignals } from '../src/lib/client-signals';

const uniq = () => Math.random().toString(36).slice(2, 10);

const HUMAN = deriveClientSignals({
  userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile',
  purposeHeaders: [],
  method: 'GET',
});

interface Fixture {
  clickId: string;
  creativeName: string;
  campaignName: string;
  publisherName: string;
  slug: string;
}

/** A full publisher → campaign → creative → link → click chain. */
async function clickFromAnAd(overrides: { windowDays?: number } = {}): Promise<Fixture> {
  const slug = `t-reg-${uniq()}`;
  const creativeName = `Banner 300x250 ${uniq()}`;
  const campaignName = `Campaign ${uniq()}`;
  const publisherName = `Publisher ${uniq()}`;

  const [admin] = await db.insert(adminUsers)
    .values({ email: `reg-${slug}@example.test`, role: 'super_admin' }).returning();
  const [publisher] = await db.insert(publishers).values({ name: publisherName }).returning();
  const [campaign] = await db.insert(campaigns).values({
    publisherId: publisher.id, name: campaignName, status: 'active',
    startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000),
    attributionWindowDays: overrides.windowDays ?? 30,
  }).returning();
  const [creative] = await db.insert(creatives).values({
    campaignId: campaign.id, name: creativeName, format: '300x250', approvalStatus: 'approved',
  }).returning();
  const [destination] = await db.insert(destinations).values({
    type: 'website', url: `https://www.betindia.bet/promo/${slug}`,
    approvalStatus: 'approved', approvedBy: admin.id, approvedAt: new Date(),
  }).returning();
  const [link] = await db.insert(smartLinks).values({
    campaignId: campaign.id, creativeId: creative.id, slug, destinationType: 'website',
    activeDestinationId: destination.id, activeDestinationVersion: 1,
    status: 'active', createdBy: admin.id,
  }).returning();
  await db.insert(destinationVersions).values({
    smartLinkId: link.id, destinationId: destination.id, version: 1, changedBy: admin.id,
  });

  const outcome = await resolveAndRecordClick(db, {
    slug, signals: HUMAN, referrer: null, ipHash: null, visitorTokenHash: null,
    publisherClickId: null,
    geo: { city: 'Pune', region: 'Maharashtra', country: 'IN', source: 'maxmind' },
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
  });
  if (outcome.status !== 'redirect') throw new Error('fixture click failed');

  return { clickId: outcome.clickId, creativeName, campaignName, publisherName, slug };
}

// ─── A registration needs a real user ID (TRD §9) ────────────

test('a registration without an external user ID is refused', async () => {
  await assert.rejects(
    () => recordRegistration(db, {
      sourceSystem: 'test', externalUserId: '   ', registeredAt: new Date(),
    }),
    /externalUserId is required/,
  );
});

// ─── Deduplication (Backend Schema §9) ───────────────────────

test('the same user delivered twice creates one registration', async () => {
  const externalUserId = `user-${uniq()}`;
  const input = { sourceSystem: 'betindia-web', externalUserId, registeredAt: new Date() };

  const first = await recordRegistration(db, input);
  const second = await recordRegistration(db, input);

  assert.equal(first.status, 'recorded');
  assert.equal(second.status, 'duplicate');
  assert.equal(first.registrationId, second.registrationId);

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
    .from(registrations).where(eq(registrations.externalUserId, externalUserId));
  assert.equal(n, 1);
});

test('the same user id from a different source system is a different registration', async () => {
  const externalUserId = `user-${uniq()}`;
  const a = await recordRegistration(db, { sourceSystem: 'betindia-web', externalUserId, registeredAt: new Date() });
  const b = await recordRegistration(db, { sourceSystem: 'partner-portal', externalUserId, registeredAt: new Date() });

  assert.equal(a.status, 'recorded');
  assert.equal(b.status, 'recorded');
  assert.notEqual(a.registrationId, b.registrationId);
});

// ─── Attribution is exact or unknown (TRD §10) ───────────────

test('a click ID that passed through attributes the registration to that ad', async () => {
  const ad = await clickFromAnAd();

  const result = await recordRegistration(db, {
    sourceSystem: 'betindia-web',
    externalUserId: `user-${uniq()}`,
    registeredAt: new Date(),
    clickId: ad.clickId,
  });

  assert.equal(result.status, 'recorded');
  if (result.status !== 'recorded') return;
  assert.equal(result.attribution.confidence, 'exact');
  assert.equal(result.attribution.clickId, ad.clickId);

  const [row] = await listRegistrations(db, 200)
    .then((rows) => rows.filter((r) => r.clickId === ad.clickId));

  assert.equal(row.creativeName, ad.creativeName, 'the ad that was clicked');
  assert.equal(row.campaignName, ad.campaignName);
  assert.equal(row.publisherName, ad.publisherName);
  assert.equal(row.slug, ad.slug);
  assert.equal(row.device, 'mobile');
  assert.equal(row.geoCity, 'Pune');
  assert.ok(row.secondsToRegister !== null && row.secondsToRegister >= 0);
});

test('an invented click ID does not attribute anything', async () => {
  const result = await recordRegistration(db, {
    sourceSystem: 'betindia-web',
    externalUserId: `user-${uniq()}`,
    registeredAt: new Date(),
    clickId: 'AAAAAAAAAAAAAAAAAAAAAA',
  });

  assert.equal(result.status, 'recorded');
  if (result.status !== 'recorded') return;
  assert.equal(result.attribution.confidence, 'unknown');
  assert.equal(result.attribution.campaignId, null);
  assert.match(result.attribution.reason, /did not match/);
});

test('a registration with no click ID stays unknown rather than being guessed', async () => {
  // A click exists that a timing-based guess would happily grab.
  await clickFromAnAd();

  const result = await recordRegistration(db, {
    sourceSystem: 'betindia-web',
    externalUserId: `user-${uniq()}`,
    registeredAt: new Date(),
  });

  assert.equal(result.status, 'recorded');
  if (result.status !== 'recorded') return;
  assert.equal(
    result.attribution.confidence, 'unknown',
    'a recent click is not evidence — TRD §10 forbids inventing attribution',
  );
});

test('a click older than its campaign window is not eligible', async () => {
  const ad = await clickFromAnAd({ windowDays: 1 });

  // Registration two days later, against a one-day window.
  const result = await recordRegistration(db, {
    sourceSystem: 'betindia-web',
    externalUserId: `user-${uniq()}`,
    registeredAt: new Date(Date.now() + 2 * 86_400_000),
    clickId: ad.clickId,
  });

  assert.equal(result.status, 'recorded');
  if (result.status !== 'recorded') return;
  assert.equal(
    result.attribution.confidence, 'unknown',
    'a click outside its window is not stretched to fit',
  );
});

test('the last click is used when the first does not match', async () => {
  const ad = await clickFromAnAd();

  const result = await recordRegistration(db, {
    sourceSystem: 'betindia-web',
    externalUserId: `user-${uniq()}`,
    registeredAt: new Date(),
    clickId: 'ZZZZZZZZZZZZZZZZZZZZZZ',  // never issued
    lastClickId: ad.clickId,
  });

  assert.equal(result.status, 'recorded');
  if (result.status !== 'recorded') return;
  assert.equal(result.attribution.confidence, 'exact');
  assert.equal(result.attribution.clickId, ad.clickId);
});

// ─── Unknown is counted, never redistributed (TRD §10) ───────

test('every registration gets an attribution row, including unknown ones', async () => {
  const result = await recordRegistration(db, {
    sourceSystem: 'betindia-web',
    externalUserId: `user-${uniq()}`,
    registeredAt: new Date(),
  });
  if (result.status !== 'recorded') throw new Error('expected recorded');

  const [attribution] = await db.select().from(conversionAttributions)
    .where(eq(conversionAttributions.registrationId, result.registrationId));

  assert.ok(attribution, 'unknown attribution is written down, not left absent');
  assert.equal(attribution.confidence, 'unknown');
  assert.equal(attribution.campaignId, null);
  assert.match(attribution.policyVersion ?? '', /UNAPPROVED/,
    'decisions are stamped with the unapproved policy so they can be recomputed');
});

test('the summary accounts for every registration', async () => {
  const ad = await clickFromAnAd();
  await recordRegistration(db, {
    sourceSystem: 'betindia-web', externalUserId: `user-${uniq()}`,
    registeredAt: new Date(), clickId: ad.clickId,
  });
  await recordRegistration(db, {
    sourceSystem: 'betindia-web', externalUserId: `user-${uniq()}`, registeredAt: new Date(),
  });

  const summary = await registrationSummary(db);
  assert.equal(
    summary.total, summary.attributed + summary.unknown,
    'attributed + unknown must equal the total — nothing is dropped or double-counted',
  );
  assert.ok(summary.byCreative.some((c) => c.creativeName === ad.creativeName));
});

test('a phone number is normalised into a contact key', async () => {
  const result = await recordRegistration(db, {
    sourceSystem: 'betindia-web',
    externalUserId: `user-${uniq()}`,
    registeredAt: new Date(),
    phone: '98765 43210',
  });
  if (result.status !== 'recorded') throw new Error('expected recorded');

  const [row] = await db.select().from(registrations)
    .where(eq(registrations.id, result.registrationId));
  assert.equal(row.contactKey, '+919876543210');
});

test.after(async () => {
  await pool.end();
});
