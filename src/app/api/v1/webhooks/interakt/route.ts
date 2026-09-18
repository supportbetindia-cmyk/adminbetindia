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
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@/db';
import { captureWebhook, type SignatureStatus } from '@/services/webhooks';
import { clientIpFrom } from '@/lib/client-signals';
import { hashIp } from '@/lib/privacy';
import { rateLimit } from '@/lib/rate-limit';
import { processInteraktInboxRow } from '@/services/interakt-leads';

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
 * Signature verification (TRD §6).
 *
 * Interakt sends `interakt-signature`, observed as 71 characters beginning
 * "sha256" — i.e. `sha256=<64 hex>`, an HMAC-SHA256 over the request body.
 * The header name and shape are confirmed from a captured event; the exact
 * signing input is not documented here, so this computes the conventional
 * HMAC of the raw body.
 *
 * Deliberately OBSERVE-ONLY by default. If this computation is wrong and the
 * endpoint rejected on mismatch, every genuine event would be refused and
 * lost — the opposite of what a durable inbox is for. So the result is
 * recorded on each row and requests are still accepted, until
 * INTERAKT_REQUIRE_VALID_SIGNATURE=true is set once `valid` is confirmed on
 * real traffic.
 */
const SIGNATURE_HEADER = process.env.INTERAKT_SIGNATURE_HEADER ?? 'interakt-signature';

function verifySignature(request: NextRequest, rawBody: string): SignatureStatus {
  const secret = process.env.INTERAKT_WEBHOOK_SECRET;
  if (!secret) return 'not_configured';

  const header = request.headers.get(SIGNATURE_HEADER);
  if (!header) return 'invalid';

  // Accept both "sha256=<hex>" and a bare hex digest.
  const provided = header.includes('=') ? header.slice(header.indexOf('=') + 1).trim() : header.trim();
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  const a = Buffer.from(provided.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return 'invalid';
  return timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

/** Only refuse on a bad signature once the computation is proven on real events. */
function enforcingSignature(): boolean {
  return process.env.INTERAKT_REQUIRE_VALID_SIGNATURE === 'true';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ipHash = hashIp(clientIpFrom(request.headers));

  const limit = rateLimit(`webhook:interakt:${ipHash ?? 'unknown'}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return ack({ accepted: false, reason: 'rate_limited' }, 429);
  }

  // The body is read first: the signature is computed over it, so it cannot be
  // verified before it exists.
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

  const signatureStatus = verifySignature(request, rawBody);

  if (signatureStatus === 'invalid' && enforcingSignature()) {
    console.warn('[webhook:interakt] rejected: signature did not verify');
    return ack({ accepted: false, reason: 'unauthorized' }, 401);
  }

  if (signatureStatus === 'invalid') {
    // Recorded, not refused. Until the signing input is proven against real
    // traffic, rejecting would discard genuine events over our own bug.
    console.warn('[webhook:interakt] signature did not verify (observe mode, event still stored)');
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

    if (signatureStatus === 'valid') await processInteraktInboxRow(db, result.id);

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
