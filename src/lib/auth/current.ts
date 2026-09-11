/**
 * Request-scoped actor resolution for the App Router.
 *
 * Server Components, Server Actions and route handlers all go through here, so
 * there is exactly one place that turns a cookie into an ActorContext.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { db } from '@/db';
import { clientIpFrom } from '@/lib/client-signals';
import { hashIp } from '@/lib/privacy';
import { unauthenticated } from '@/lib/errors';
import type { ActorContext } from './context';
import { can, type Permission } from './rbac';
import { resolveSession, SESSION_COOKIE, type SessionUser } from './session';

/**
 * `cache` deduplicates the session lookup within a single request, so a page
 * that checks permissions in five components still issues one query.
 */
export const currentActor = cache(async (): Promise<ActorContext | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value ?? null;
  if (!token) return null;

  const user = await resolveSession(db, token);
  if (!user) return null;

  const headerList = await headers();
  return { user, ipHash: hashIp(clientIpFrom(headerList)) };
});

/** For pages: sends an unauthenticated visitor to the sign-in screen. */
export async function requireActor(returnTo?: string): Promise<ActorContext> {
  const actor = await currentActor();
  if (!actor) {
    const target = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login';
    redirect(target);
  }
  return actor;
}

/** For Server Actions and route handlers: throws rather than redirecting. */
export async function requireActorOrThrow(): Promise<ActorContext> {
  const actor = await currentActor();
  if (!actor) throw unauthenticated();
  return actor;
}

export async function currentUser(): Promise<SessionUser | null> {
  return (await currentActor())?.user ?? null;
}

export async function actorCan(permission: Permission): Promise<boolean> {
  const actor = await currentActor();
  return actor ? can(actor.user.role, permission) : false;
}
