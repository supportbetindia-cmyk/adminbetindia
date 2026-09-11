/**
 * Sets `x-pathname` so a Server Component layout can highlight the active
 * navigation item, and applies the security headers TRD §14 requires.
 *
 * Deliberately does NOT authenticate. Middleware cannot reach the database in
 * every deployment target, and a cookie-presence check would let a revoked
 * session past. Authentication happens in the (admin) layout, against the
 * session table, on every request.
 */

import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', request.nextUrl.pathname);

  const response = NextResponse.next({ request: { headers } });

  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // The admin UI loads no third-party script and no remote image. Google Fonts
  // is the only external origin, and it is allowed for styles and fonts only.
  //
  // `script-src 'unsafe-inline'` is required by Next's hydration bootstrap.
  // Tightening it needs a per-request nonce threaded through the document —
  // worth doing before production, and listed in README.md as an open item.
  //
  // `'unsafe-eval'` is added in development ONLY: the webpack dev runtime
  // evaluates modules with eval() for hot reloading, and without it every
  // chunk fails to execute and the app renders a blank page. It is never sent
  // in production, where the bundle is pre-compiled and needs no eval.
  const scriptSrc =
    process.env.NODE_ENV === 'production'
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

  response.headers.set(
    'content-security-policy',
    [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  );

  return response;
}

export const config = {
  /**
   * The redirect endpoint is excluded: it sets its own headers, and TRD §15
   * budgets p95 under 300 ms, so it takes no middleware hop it does not need.
   */
  matcher: ['/((?!c/|api/|_next/static|_next/image|favicon.ico).*)'],
};
