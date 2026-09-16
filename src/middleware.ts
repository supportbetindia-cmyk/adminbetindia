
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', request.nextUrl.pathname);

  const response = NextResponse.next({ request: { headers } });

  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  /**
   * HSTS. Production only — sending it in development would pin localhost to
   * https in the browser and make the dev server unreachable until the pin
   * expires.
   *
   * Admin sessions are Secure cookies, so a single downgraded request is a
   * session-stealing opportunity. `preload` is deliberately omitted: getting
   * onto the preload list is easy and getting off it takes months.
   */
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

 
  const scriptSrc =
    process.env.NODE_ENV === 'production'
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

  response.headers.set(
    'content-security-policy',
    [
      "default-src 'self'",
      scriptSrc,
      // Fonts are self-hosted, so no external origin is needed for styles or
      // fonts. Tighter than allowing Google, and nothing to fail.
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
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
