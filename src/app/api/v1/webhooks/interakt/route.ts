/**
 * POST /api/v1/webhooks/interakt — capture endpoint.
 *
 * Point Interakt's webhook configuration here, send a test WhatsApp message,
 * and the raw event appears on the Integrations screen. That is the purpose of
 * this route today: to discover what Interakt actually sends, because TRD §8
 * and PRD §7 both require the payload schema be verified rather than assumed.
 *
 * It deliberately does not interpret the body. No lead is created, nothing is
 * attributed. A redirect is not a lead, and neither is an unparsed webhook.
 *
 * Behaviour required by Backend Schema §5 and TRD §15:
 *  - store the raw event first, acknowledge second
 *  - acknowledge safely, so the provider does not retry events we already hold
 *  - deduplicate redelivery
 *  - never let an unrecognised shape cause an error response
 */

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { db } from '@/db';
import { captureWebhook, type SignatureStatus } from '@/services/webhooks';
import { clientIpFrom } from '@/lib/client-signals';
import { hashIp } from '@/lib/privacy';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Providers retry in bursts; this stops a loop from filling the table. */
const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;

/** Bodies larger than this are refused rather than stored. */
const MAX_BODY_BYTES = 512 * 1024;

function ack(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

/**
 * Shared-secret check.
 *
 * Interakt's actual authentication scheme is unknown — TRD §6 requires
 * provider-specific signature verification "where supported", and that cannot
 * be implemented against a scheme nobody has documentation for yet.
 *
 * So: if INTERAKT_WEBHOOK_SECRET is set, a matching secret is required in a
 * configurable header. If it is not set, the endpoint accepts unauthenticated
 * events and records them as such, so the gap is visible in the data rather
 * than silently assumed to be fine. Once the real scheme is known from a
 * captured payload, this is where it replaces the shared secret.
 */
function verifySecret(request: NextRequest): SignatureStatus {
  const expected = process.env.INTERAKT_WEBHOOK_SECRET;
  if (!expected) return 'not_configured';

  const headerName = process.env.INTERAKT_WEBHOOK_SECRET_HEADER ?? 'x-webhook-secret';
  const provided = request.headers.get(headerName) ?? '';

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return 'invalid';
  return timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ipHash = hashIp(clientIpFrom(request.headers));

  const limit = rateLimit(`webhook:interakt:${ipHash ?? 'unknown'}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return ack({ accepted: false, reason: 'rate_limited' }, 429);
  }

  const signatureStatus = verifySecret(request);
  if (signatureStatus === 'invalid') {
    // Refused, and deliberately not stored — an unauthenticated caller must
    // not be able to fill the inbox.
    console.warn('[webhook:interakt] rejected: secret did not match');
    return ack({ accepted: false, reason: 'unauthorized' }, 401);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return ack({ accepted: false, reason: 'unreadable_body' }, 400);
  }

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    console.warn('[webhook:interakt] rejected: body too large');
    return ack({ accepted: false, reason: 'payload_too_large' }, 413);
  }

  // A non-JSON body is still captured. Discovering that Interakt posts form
  // data rather than JSON is exactly the kind of thing this endpoint exists
  // to find out.
  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = { _unparsed: true, _raw: rawBody.slice(0, 10_000) };
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key] = value; });

  try {
    const result = await captureWebhook(db, {
      provider: 'interakt',
      payload,
      headers,
      rawBody,
      sourceIpHash: ipHash,
      signatureStatus,
    });

    // 200 either way: a duplicate is a successful outcome, not an error, and
    // reporting it as one would make the provider retry indefinitely.
    return ack({ accepted: true, duplicate: result.status === 'duplicate' });
  } catch (err) {
    // A 5xx tells the provider to retry, which is what we want if our own
    // storage failed — the event is not lost, it is redelivered.
    console.error('[webhook:interakt] capture failed:', err);
    return ack({ accepted: false, reason: 'storage_error' }, 500);
  }
}

/**
 * Some providers probe the URL with GET before accepting it, and some send a
 * challenge parameter to echo. Answering plainly avoids a failed setup for a
 * reason that has nothing to do with the integration.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const challenge = new URL(request.url).searchParams.get('challenge');
  if (challenge) return new NextResponse(challenge, { status: 200 });
  return ack({ ok: true, endpoint: 'interakt', method: 'POST' });
}
