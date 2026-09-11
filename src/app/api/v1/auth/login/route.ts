/** POST /api/v1/auth/login */

import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/db';
import { login } from '@/services/auth';
import { SESSION_COOKIE } from '@/lib/auth/session';
import { clientIpFrom } from '@/lib/client-signals';
import { hashIp } from '@/lib/privacy';
import { loginSchema, parseInput } from '@/lib/validation';
import { apiError, toErrorResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const credentials = parseInput(loginSchema, await request.json());

    const result = await login(db, {
      email: credentials.email,
      password: credentials.password,
      ipHash: hashIp(clientIpFrom(request.headers)),
      userAgent: request.headers.get('user-agent'),
    });

    if (result.status === 'rate_limited') {
      return NextResponse.json(
        { error: { code: 'rate_limited', message: 'Too many attempts. Try again shortly.' } },
        { status: 429, headers: { 'retry-after': String(result.retryAfterSeconds), 'cache-control': 'no-store' } },
      );
    }

    // A suspended account and a wrong password are reported identically, so
    // the endpoint cannot be used to enumerate valid accounts.
    if (result.status !== 'ok') {
      return apiError('invalid_credentials', 'Email or password is incorrect.', 401);
    }

    const response = NextResponse.json(
      { user: result.user, expiresAt: result.session.expiresAt.toISOString() },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    setSessionCookie(response, result.session.token, result.session.expiresAt);
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Local, not exported: a route module may only export handlers and route
 * config, and Next enforces that at build time.
 */
function setSessionCookie(response: NextResponse, token: string, expiresAt: Date): void {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // `strict` rather than `lax`: no cross-site request should ever carry an
    // admin session, which is most of CSRF protection on its own (TRD §14).
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}
