/**
 * GET /c/{slug} — the public redirect endpoint.
 *
 * This is the only route that publisher traffic touches, so it stays thin:
 * parse the request, call the service, respond. TRD §15 sets the budget at
 * p95 under 300 ms excluding destination latency, and the work here is one
 * indexed SELECT plus one INSERT.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/db';
import { resolveAndRecordClick } from '@/services/redirect';
import { clientIpFrom, deriveClientSignals } from '@/lib/client-signals';
import { hashIp, hashVisitorToken } from '@/lib/privacy';
import { generateVisitorToken } from '@/lib/ids';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VISITOR_COOKIE = 'bi_vid';
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // ~13 months

/**
 * Publisher click-ID macro parameters. Only parameters a publisher has been
 * approved to send are read (PRD §11) — extend this list per publisher as
 * their specifications are confirmed, rather than accepting anything.
 */
const PUBLISHER_CLICK_PARAMS = ['pcid', 'click_id', 'cid', 'subid', 'aff_click_id'];

function neutralResponse(status: number, message: string): NextResponse {
  // Deliberately plain: an invalid link must never redirect anywhere, and must
  // not leak whether a slug exists or why it is unavailable.
  return new NextResponse(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const url = new URL(request.url);
  const headers = request.headers;

  const signals = deriveClientSignals({
    userAgent: headers.get('user-agent'),
    purposeHeaders: [
      headers.get('purpose'),
      headers.get('x-purpose'),
      headers.get('sec-purpose'),
    ],
    method: request.method,
  });

  // First-party visitor token: used only for a deduplicated unique-visitor
  // estimate, never as proof of a person (TRD §7, §11).
  const existingToken = request.cookies.get(VISITOR_COOKIE)?.value ?? null;
  const visitorToken = existingToken ?? generateVisitorToken();

  let publisherClickId: string | null = null;
  for (const key of PUBLISHER_CLICK_PARAMS) {
    const value = url.searchParams.get(key);
    if (value) {
      publisherClickId = value.slice(0, 256);
      break;
    }
  }

  const outcome = await resolveAndRecordClick(db, {
    slug,
    signals,
    referrer: headers.get('referer')?.slice(0, 1024) ?? null,
    ipHash: hashIp(clientIpFrom(headers)),
    visitorTokenHash: hashVisitorToken(visitorToken),
    publisherClickId,
    utm: {
      source: url.searchParams.get('utm_source')?.slice(0, 255) ?? null,
      medium: url.searchParams.get('utm_medium')?.slice(0, 255) ?? null,
      campaign: url.searchParams.get('utm_campaign')?.slice(0, 255) ?? null,
      content: url.searchParams.get('utm_content')?.slice(0, 255) ?? null,
      term: url.searchParams.get('utm_term')?.slice(0, 255) ?? null,
    },
  });

  switch (outcome.status) {
    case 'not_found':
      return neutralResponse(404, 'This link is not available.');
    case 'not_active':
    case 'campaign_window':
      return neutralResponse(410, 'This campaign is not currently running.');
    case 'expired':
      return neutralResponse(410, 'This link has expired.');
    case 'no_approved_destination':
      // An active link with no approved destination is an operational fault,
      // not a user error. It must never fall through to a guessed URL.
      console.error(`[redirect] no approved destination for slug=${slug}`);
      return neutralResponse(503, 'This link is temporarily unavailable.');
    case 'unsafe_destination':
      console.error(`[redirect] unsafe destination for slug=${slug}: ${outcome.detail}`);
      return neutralResponse(503, 'This link is temporarily unavailable.');
    case 'redirect':
      break;
  }

  const response = NextResponse.redirect(outcome.url, 302);
  // A cached redirect is a lost click, and a stale destination is worse.
  response.headers.set('cache-control', 'no-store, max-age=0, must-revalidate');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-robots-tag', 'noindex, nofollow');

  if (!existingToken) {
    response.cookies.set(VISITOR_COOKIE, visitorToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: VISITOR_COOKIE_MAX_AGE,
      path: '/',
    });
  }

  return response;
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  // Preview fetchers use HEAD. Handled by the same path so the hit is still
  // recorded and flagged, rather than vanishing from the raw log.
  const res = await GET(request, context);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
