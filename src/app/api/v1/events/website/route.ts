/**
 * POST /api/v1/events/website — first-party website events (TRD §6, §7).
 *
 * Called by bi-click.js on betindia.bet. It is cross-origin (betindia.bet →
 * go.betindia.games) and unauthenticated, because a visitor cannot sign in —
 * so it is protected by an origin allowlist, a rate limit, a body cap and a
 * closed set of event types, and it accepts no personal data.
 *
 * What it deliberately does NOT do: create a registration. PRD §6 and TRD §9
 * require a real external user ID and a completed account, which only the
 * betting platform can confirm. `registration_submitted` is a website event
 * and stays one.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/db';
import {
  recordWebsiteEvent, WEBSITE_EVENT_TYPES,
  type ConsentStatus, type WebsiteEventType,
} from '@/services/website-events';
import { clientIpFrom } from '@/lib/client-signals';
import { hashIp, hashVisitorToken } from '@/lib/privacy';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A busy landing page fires a handful of events per visit; this is generous. */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Origins permitted to post events.
 *
 * Not decoration: without it, anyone could post events claiming any click ID
 * and inflate the website funnel. The click ID is also verified against real
 * clicks in the service, so both layers have to be defeated to fabricate one.
 */
function allowedOrigins(): string[] {
  const configured = (process.env.WEBSITE_EVENT_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean);
  if (configured.length > 0) return configured;
  return ['https://www.betindia.bet', 'https://betindia.bet'];
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && allowedOrigins().includes(origin);
  return {
    ...(allowed ? { 'access-control-allow-origin': origin } : {}),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
    'cache-control': 'no-store',
  };
}

function json(body: unknown, status: number, origin: string | null): NextResponse {
  return NextResponse.json(body as object, { status, headers: corsHeaders(origin) });
}

/** Preflight. Browsers send this before a cross-origin POST with a JSON body. */
export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');

  if (!origin || !allowedOrigins().includes(origin)) {
    console.warn(`[events:website] rejected origin: ${origin ?? '(none)'}`);
    return json({ accepted: false, reason: 'origin_not_allowed' }, 403, origin);
  }

  const ipHash = hashIp(clientIpFrom(request.headers));
  const limit = rateLimit(`website-events:${ipHash ?? 'unknown'}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return json({ accepted: false, reason: 'rate_limited' }, 429, origin);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ accepted: false, reason: 'unreadable_body' }, 400, origin);
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return json({ accepted: false, reason: 'payload_too_large' }, 413, origin);
  }

  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ accepted: false, reason: 'invalid_json' }, 400, origin);
  }

  const eventType = String(body.eventType ?? '');
  if (!(WEBSITE_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return json({ accepted: false, reason: 'unknown_event_type' }, 422, origin);
  }

  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
  if (sessionToken.length < 8 || sessionToken.length > 200) {
    return json({ accepted: false, reason: 'invalid_session_token' }, 422, origin);
  }

  const eventKey = typeof body.eventKey === 'string' ? body.eventKey.trim() : '';
  if (eventKey.length < 8 || eventKey.length > 200) {
    return json({ accepted: false, reason: 'invalid_event_key' }, 422, origin);
  }

  const consent: ConsentStatus =
    body.consent === 'granted' || body.consent === 'denied' ? body.consent : 'unknown';

  try {
    const result = await recordWebsiteEvent(db, {
      // The site's raw session token is hashed here and never stored.
      sessionTokenHash: hashVisitorToken(sessionToken)!,
      clickId: typeof body.clickId === 'string' ? body.clickId : null,
      eventType: eventType as WebsiteEventType,
      eventKey,
      pagePath: typeof body.pagePath === 'string' ? body.pagePath.slice(0, 500) : null,
      landingUrl: typeof body.landingUrl === 'string' ? body.landingUrl.slice(0, 1000) : null,
      consent,
      metadata: isPlainObject(body.metadata) ? clampMetadata(body.metadata) : null,
    });

    return json(
      {
        accepted: true,
        duplicate: result.status === 'duplicate',
        // Returned so the website team can confirm the click ID is arriving
        // and matching, rather than guessing during integration.
        attribution: result.status === 'recorded' ? result.attribution : undefined,
      },
      200,
      origin,
    );
  } catch (err) {
    console.error('[events:website] failed to record:', err);
    return json({ accepted: false, reason: 'storage_error' }, 500, origin);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Caps what a caller can attach.
 *
 * The website must not be able to post arbitrary payloads into our database,
 * and metadata is exactly where personal data would leak in by accident.
 */
function clampMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, v] of Object.entries(value)) {
    if (count >= 20) break;
    if (typeof v === 'string') out[key.slice(0, 60)] = v.slice(0, 300);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key.slice(0, 60)] = v;
    count += 1;
  }
  return out;
}
