/**
 * GET /api/health — liveness and readiness.
 *
 * Unauthenticated by necessity: a load balancer cannot sign in. It therefore
 * reveals nothing an attacker could use — no version, no hostname, no
 * connection string, no error text. Just whether this instance can serve.
 *
 * `?deep=1` additionally checks the database. Keep the plain check for
 * liveness probes and the deep one for readiness, so a database blip restarts
 * nothing: the process is healthy even when its dependency is not.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DB_TIMEOUT_MS = 4000;

function respond(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const deep = new URL(request.url).searchParams.get('deep') === '1';

  if (!deep) {
    return respond({ status: 'ok' }, 200);
  }

  const startedAt = Date.now();

  try {
    // Bounded: a hung connection must fail the probe rather than hold it open
    // until the load balancer's own timeout.
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('database check timed out')), DB_TIMEOUT_MS),
      ),
    ]);

    return respond({ status: 'ok', database: 'ok', latencyMs: Date.now() - startedAt }, 200);
  } catch (err) {
    // Logged server-side with detail; the response says only that it failed.
    console.error('[health] database check failed:', err);
    return respond({ status: 'degraded', database: 'unreachable' }, 503);
  }
}

export async function HEAD(): Promise<NextResponse> {
  return new NextResponse(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}
