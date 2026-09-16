/**
 * POST /api/v1/webhooks/registrations — authorized registration ingestion
 * (TRD §6, §9; Backend Schema §5).
 *
 * Called **server to server** by betindia.bet when an account is actually
 * created. That is what separates it from the browser event: a visitor's
 * browser cannot be trusted to say "a registration happened", but an
 * authenticated backend holding the platform's own user ID can.
 *
 * Requires a shared secret. Without one configured the endpoint refuses
 * everything — an unauthenticated registration feed would let anyone inflate
 * conversion counts, and conversions are what publishers get paid on.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { db } from '@/db';
import { recordRegistration } from '@/services/registrations';
import { clientIpFrom } from '@/lib/client-signals';
import { hashIp } from '@/lib/privacy';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body as object, {
    status,
    headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

/**
 * Shared-secret check, constant time.
 *
 * Deliberately fails closed: if REGISTRATION_WEBHOOK_SECRET is unset the
 * endpoint returns 503 rather than accepting anything. Compare with the
 * Interakt capture endpoint, which accepts unauthenticated events on purpose —
 * that one only stores raw payloads for inspection, this one creates verified
 * conversions.
 */
function authorised(request: NextRequest): boolean {
  const expected = process.env.REGISTRATION_WEBHOOK_SECRET;
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!process.env.REGISTRATION_WEBHOOK_SECRET) {
    console.error('[webhook:registrations] REGISTRATION_WEBHOOK_SECRET is not set — refusing');
    return json({ accepted: false, reason: 'not_configured' }, 503);
  }

  const ipHash = hashIp(clientIpFrom(request.headers));
  const limit = rateLimit(`registrations:${ipHash ?? 'unknown'}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) return json({ accepted: false, reason: 'rate_limited' }, 429);

  if (!authorised(request)) {
    console.warn('[webhook:registrations] rejected: bad or missing bearer token');
    return json({ accepted: false, reason: 'unauthorized' }, 401);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ accepted: false, reason: 'unreadable_body' }, 400);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return json({ accepted: false, reason: 'payload_too_large' }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ accepted: false, reason: 'invalid_json' }, 400);
  }

  const externalUserId = typeof body.externalUserId === 'string' ? body.externalUserId.trim() : '';
  if (!externalUserId || externalUserId.length > 200) {
    // TRD §9: no external user ID means no verified registration. Refusing is
    // the point — accepting it would put an unverifiable row in the funnel.
    return json({ accepted: false, reason: 'external_user_id_required' }, 422);
  }

  const registeredAt = parseDate(body.registeredAt) ?? new Date();
  if (registeredAt.getTime() > Date.now() + 5 * 60_000) {
    return json({ accepted: false, reason: 'registered_at_in_future' }, 422);
  }

  try {
    const result = await recordRegistration(db, {
      sourceSystem: typeof body.sourceSystem === 'string' && body.sourceSystem.trim()
        ? body.sourceSystem.trim().slice(0, 100)
        : 'betindia-web',
      externalUserId,
      registeredAt,
      clickId: typeof body.clickId === 'string' ? body.clickId : null,
      lastClickId: typeof body.lastClickId === 'string' ? body.lastClickId : null,
      phone: typeof body.phone === 'string' ? body.phone : null,
      sourceEventId: typeof body.sourceEventId === 'string' ? body.sourceEventId.slice(0, 200) : null,
    });

    if (result.status === 'duplicate') {
      // Not an error: a redelivery of a registration we already hold is a
      // success, and a 4xx would make the caller retry forever.
      return json({ accepted: true, duplicate: true, registrationId: result.registrationId }, 200);
    }

    // The attribution outcome is returned so the website team can confirm the
    // click ID is arriving and matching, rather than guessing during setup.
    return json({
      accepted: true,
      duplicate: false,
      registrationId: result.registrationId,
      attribution: {
        confidence: result.attribution.confidence,
        clickId: result.attribution.clickId,
        reason: result.attribution.reason,
      },
    }, 201);
  } catch (err) {
    console.error('[webhook:registrations] failed to record:', err);
    return json({ accepted: false, reason: 'storage_error' }, 500);
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
