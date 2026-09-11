/**
 * REST transport for the admin API (TRD §6).
 *
 * Thin on purpose: every handler resolves the actor, calls a service and maps
 * the result. All authorisation, validation and audit logging lives in the
 * service layer, so the API and the admin UI cannot enforce different rules.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { ServiceError } from '@/lib/errors';
import { fieldErrors } from '@/lib/validation';
import { currentActor } from '@/lib/auth/current';
import type { ActorContext } from '@/lib/auth/context';

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data as object, { status, headers: SECURITY_HEADERS });
}

export function apiError(code: string, message: string, status: number, fields?: Record<string, string>) {
  return NextResponse.json<ApiErrorBody>(
    { error: { code, message, ...(fields ? { fields } : {}) } },
    { status, headers: SECURITY_HEADERS },
  );
}

/**
 * Maps a thrown error to a response.
 *
 * Only ServiceError and ZodError produce a message the caller sees. Anything
 * else is logged server-side and returned as a generic 500, so an internal
 * failure never leaks a query, a path or a stack trace (TRD §14).
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    return apiError(err.code, err.message, err.status, Object.keys(err.fields).length ? err.fields : undefined);
  }
  if (err instanceof ZodError) {
    const fields = fieldErrors(err);
    return apiError('validation_failed', Object.values(fields)[0] ?? 'Invalid input', 422, fields);
  }
  console.error('[api] unhandled error:', err);
  return apiError('internal_error', 'Something went wrong.', 500);
}

type Handler = (ctx: {
  request: NextRequest;
  actor: ActorContext;
  params: Record<string, string>;
  body: unknown;
  searchParams: URLSearchParams;
}) => Promise<NextResponse> | NextResponse;

/**
 * Wraps a route handler with authentication, body parsing and error mapping.
 *
 * Authentication only — the permission check belongs to the service, so it
 * cannot be forgotten on a route that skips this wrapper.
 */
export function route(handler: Handler) {
  // `context` is required rather than optional so the signature satisfies the
  // route types Next generates at build time, which expect it on every handler
  // including those with no dynamic segment.
  return async (
    request: NextRequest,
    context: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    try {
      const actor = await currentActor();
      if (!actor) return apiError('unauthenticated', 'Sign in required', 401);

      const params = context?.params ? await context.params : {};
      const url = new URL(request.url);

      let body: unknown = undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const contentType = request.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const text = await request.text();
          body = text ? JSON.parse(text) : {};
        } else if (contentType.includes('form')) {
          body = Object.fromEntries((await request.formData()).entries());
        } else {
          body = {};
        }
      }

      return await handler({ request, actor, params, body, searchParams: url.searchParams });
    } catch (err) {
      if (err instanceof SyntaxError) return apiError('validation_failed', 'Request body is not valid JSON', 422);
      return toErrorResponse(err);
    }
  };
}

/** Query string → plain object, so route filters reuse the zod schemas. */
export function queryObject(searchParams: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of searchParams) if (value !== '') out[key] = value;
  return out;
}
