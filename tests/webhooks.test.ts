/**
 * Acceptance tests for webhook capture (Feature 5, capture layer).
 *
 * Maps onto Backend Schema §9 ("Duplicate webhook delivery does not duplicate
 * a lead, registration or FTD" and "WhatsApp redirect without incoming message
 * does not create a lead"), TRD §6 and TRD §15.
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { leads, webhookInbox, whatsappEvents } from '../src/db/schema';
import { captureWebhook, deriveEventId, describeHeaders, inboxSummary } from '../src/services/webhooks';

const uniq = () => Math.random().toString(36).slice(2, 10);

function input(payload: unknown, overrides: Record<string, unknown> = {}) {
  const rawBody = JSON.stringify(payload);
  return {
    provider: 'interakt' as const,
    payload,
    headers: { 'content-type': 'application/json' },
    rawBody,
    sourceIpHash: null,
    signatureStatus: 'not_configured' as const,
    ...overrides,
  };
}

// ─── Deduplication (Backend Schema §9) ───────────────────────

test('the same event delivered twice is stored once', async () => {
  const payload = { id: `evt-${uniq()}`, type: 'message_received' };

  const first = await captureWebhook(db, input(payload));
  const second = await captureWebhook(db, input(payload));

  assert.equal(first.status, 'stored');
  assert.equal(second.status, 'duplicate');
  assert.equal(first.id, second.id, 'the redelivery maps onto the original row');

  const rows = await db
    .select()
    .from(webhookInbox)
    .where(eq(webhookInbox.externalEventId, payload.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].duplicateCount, 1, 'the redelivery is counted, not stored');
});

test('a redelivered event increments the counter each time', async () => {
  const payload = { id: `evt-${uniq()}` };
  await captureWebhook(db, input(payload));
  await captureWebhook(db, input(payload));
  await captureWebhook(db, input(payload));

  const [row] = await db
    .select()
    .from(webhookInbox)
    .where(eq(webhookInbox.externalEventId, payload.id));
  assert.equal(row.duplicateCount, 2);
});

test('two genuinely different events are both stored', async () => {
  const a = { id: `evt-${uniq()}` };
  const b = { id: `evt-${uniq()}` };

  const ra = await captureWebhook(db, input(a));
  const rb = await captureWebhook(db, input(b));

  assert.equal(ra.status, 'stored');
  assert.equal(rb.status, 'stored');
  assert.notEqual(ra.id, rb.id);
});

// ─── Event ID derivation ─────────────────────────────────────

test('an event ID is found wherever the provider puts it', () => {
  assert.deepEqual(deriveEventId({ id: 'a1' }, '{}'), { externalEventId: 'a1', eventIdSource: 'id' });
  assert.deepEqual(deriveEventId({ event_id: 'b2' }, '{}'), { externalEventId: 'b2', eventIdSource: 'event_id' });
  assert.deepEqual(deriveEventId({ data: { message_id: 'c3' } }, '{}'), {
    externalEventId: 'c3', eventIdSource: 'data.message_id',
  });
  // Numeric identifiers are accepted; some providers send them unquoted.
  assert.equal(deriveEventId({ id: 12345 }, '{}').externalEventId, '12345');
});

test('an unrecognised payload falls back to a body hash, and says so', () => {
  const body = JSON.stringify({ something: 'unexpected' });
  const result = deriveEventId(JSON.parse(body), body);

  assert.match(result.externalEventId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    result.eventIdSource, 'body_sha256',
    'a fallback key must be identifiable, so it is never mistaken for a real provider ID',
  );
});

test('identical unrecognised bodies deduplicate; different ones do not', async () => {
  const body = { contact: `+9190000${uniq().slice(0, 5)}`, text: 'hi' };

  const first = await captureWebhook(db, input(body));
  const second = await captureWebhook(db, input(body));
  const third = await captureWebhook(db, input({ ...body, text: 'different' }));

  assert.equal(first.status, 'stored');
  assert.equal(second.status, 'duplicate');
  assert.equal(third.status, 'stored');
});

// ─── Real Interakt payloads (captured 12 Sept 2026) ──────────

/**
 * Trimmed from an actual `message_received` event. Phone number replaced.
 *
 * This shape is no longer an assumption: it was captured from Interakt after
 * enabling "Message received from customers", which is what PRD §7 and TRD §8
 * required be verified before anything was built on it.
 */
function interaktMessageReceived(overrides: {
  messageId?: string;
  text?: string;
  contentType?: string;
  chatMessageType?: string;
} = {}) {
  return {
    data: {
      message: {
        id: overrides.messageId ?? `06aa5047-${uniq()}-7751-8000-dc912733ef76`,
        message: overrides.text ?? 'Hi [BI-TEST-001]',
        media_url: null,
        campaign_id: null,
        campaign_name: '',
        message_status: 'Sent',
        received_at_utc: '2026-09-12T07:51:31.000000',
        chat_message_type: overrides.chatMessageType ?? 'CustomerMessage',
        is_template_message: false,
        message_content_type: overrides.contentType ?? 'Text',
      },
      customer: {
        id: '0f452ba4-83f0-43a1-b5dd-e631d77aa635',
        traits: { name: '', whatsapp_opted_in: true, _internal_lead_source: 'Whatsapp' },
        country_code: '+91',
        phone_number: '9000000000',
        channel_phone_number: '919000000000',
      },
      channel_type: 'Whatsapp',
      whatsapp_api_number: '918766250172',
    },
    type: 'message_received',
    version: '1.0',
    timestamp: '2026-09-12T07:51:31.532562',
  };
}

test('a real Interakt event is keyed on its message id, not a body hash', () => {
  const payload = interaktMessageReceived({ messageId: '06aa5047-ad29-7751-8000-dc912733ef76' });
  const result = deriveEventId(payload, JSON.stringify(payload));

  assert.equal(result.externalEventId, '06aa5047-ad29-7751-8000-dc912733ef76');
  assert.equal(result.eventIdSource, 'data.message.id');
});

test('Interakt redelivery of the same message collapses to one row', async () => {
  const payload = interaktMessageReceived({ messageId: `06aa50-${uniq()}-dedupe` });

  const first = await captureWebhook(db, input(payload));
  const second = await captureWebhook(db, input(payload));

  assert.equal(first.status, 'stored');
  assert.equal(second.status, 'duplicate');
  assert.equal(first.id, second.id);
});

test('two distinct messages with identical text are both kept', async () => {
  // Observed live: the same text sent twice arrives as two events with
  // different message ids. They are genuinely two messages, not a redelivery.
  const a = await captureWebhook(db, input(interaktMessageReceived({ text: 'Hi [BI-TEST-001]' })));
  const b = await captureWebhook(db, input(interaktMessageReceived({ text: 'Hi [BI-TEST-001]' })));

  assert.equal(a.status, 'stored');
  assert.equal(b.status, 'stored');
  assert.notEqual(a.id, b.id);
});

test('a captured Interakt message still creates no lead', async () => {
  const before = (await db.select({ n: sql<number>`count(*)::int` }).from(leads))[0].n;
  await captureWebhook(db, input(interaktMessageReceived()));
  const after = (await db.select({ n: sql<number>`count(*)::int` }).from(leads))[0].n;

  assert.equal(after, before, 'capture stores; it does not interpret (PRD §6)');
});

// ─── Credential handling (Backend Schema §8) ─────────────────

test('credential-bearing header values are never stored', () => {
  const described = describeHeaders({
    'content-type': 'application/json',
    'authorization': 'Bearer sk-live-abcdefghijklmnop',
    'x-interakt-signature': 'a3f9c1b2d4e5f60718293a4b5c6d7e8f',
    'x-api-key': 'secret-value-here',
    'user-agent': 'Interakt-Webhook/1.0',
  });

  assert.equal(described['content-type'], 'application/json');
  assert.equal(described['user-agent'], 'Interakt-Webhook/1.0', 'harmless headers are kept in full');

  for (const key of ['authorization', 'x-interakt-signature', 'x-api-key']) {
    assert.match(described[key], /^<redacted: \d+ chars, starts "/, `${key} must be redacted`);
    assert.ok(!described[key].includes('abcdefghijklmnop'), 'the secret must not survive');
    assert.ok(!described[key].includes('secret-value-here'), 'the secret must not survive');
  }

  // Enough shape survives to identify the scheme.
  assert.match(described['x-interakt-signature'], /32 chars/);
});

test('captured headers reach the database with secrets already removed', async () => {
  const payload = { id: `evt-${uniq()}` };
  await captureWebhook(db, input(payload, {
    headers: { 'content-type': 'application/json', authorization: 'Bearer super-secret-token-value' },
  }));

  const [row] = await db
    .select()
    .from(webhookInbox)
    .where(eq(webhookInbox.externalEventId, payload.id));

  assert.ok(!JSON.stringify(row.headers).includes('super-secret-token-value'));
  assert.equal(row.contentType, 'application/json');
});

// ─── Capture is not interpretation (PRD §6, TRD §8) ──────────

test('capturing a webhook creates no lead and no whatsapp event', async () => {
  const before = {
    leads: (await db.select({ n: sql<number>`count(*)::int` }).from(leads))[0].n,
    events: (await db.select({ n: sql<number>`count(*)::int` }).from(whatsappEvents))[0].n,
  };

  await captureWebhook(db, input({
    id: `evt-${uniq()}`,
    type: 'message_received',
    // A payload that *looks* parseable must still not be interpreted, because
    // the real schema has not been verified (TRD §8).
    contact: { phone: '+919000000001' },
    message: { text: 'Hi [BI-DEMO-WA-SEP01]' },
  }));

  const after = {
    leads: (await db.select({ n: sql<number>`count(*)::int` }).from(leads))[0].n,
    events: (await db.select({ n: sql<number>`count(*)::int` }).from(whatsappEvents))[0].n,
  };

  assert.equal(after.leads, before.leads, 'a captured webhook is not a lead');
  assert.equal(after.events, before.events, 'nothing is parsed until the schema is verified');
});

test('an unparseable body is still captured rather than dropped', async () => {
  // Unique per run: the fallback key is a hash of the body, so a fixed string
  // would collide with the row left by the previous run of this suite.
  const rawBody = `this is not json at all ${uniq()}`;
  const result = await captureWebhook(db, {
    provider: 'interakt',
    payload: { _unparsed: true, _raw: rawBody },
    headers: { 'content-type': 'text/plain' },
    rawBody,
    sourceIpHash: null,
    signatureStatus: 'not_configured',
  });

  assert.equal(result.status, 'stored', 'discovering the body is not JSON is the point of this endpoint');

  const [row] = await db
    .select()
    .from(webhookInbox)
    .where(eq(webhookInbox.id, result.id));
  assert.equal((row.payload as { _raw: string })._raw, rawBody);
});

test('signature status is recorded explicitly, including when unconfigured', async () => {
  const unverified = await captureWebhook(db, input({ id: `evt-${uniq()}` }));
  const verified = await captureWebhook(db, input({ id: `evt-${uniq()}` }, { signatureStatus: 'valid' }));

  const [a] = await db.select().from(webhookInbox).where(eq(webhookInbox.id, unverified.id));
  const [b] = await db.select().from(webhookInbox).where(eq(webhookInbox.id, verified.id));

  assert.equal(a.signatureStatus, 'not_configured', 'an unauthenticated endpoint is visible in the data');
  assert.equal(b.signatureStatus, 'valid');
});

test('the summary reports what is known and what is guessed', async () => {
  await captureWebhook(db, input({ id: `evt-${uniq()}` }));
  const summary = await inboxSummary(db, 'interakt');

  assert.ok(summary.total > 0);
  assert.ok(summary.lastReceivedAt instanceof Date);
  assert.ok(
    summary.eventIdSources.some((s) => s.source === 'id' || s.source === 'body_sha256'),
    'the summary distinguishes a real provider ID from a hash fallback',
  );
});

test.after(async () => {
  await pool.end();
});
