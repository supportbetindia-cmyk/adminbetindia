/**
 * The actor performing an operation, plus the permission gate every service
 * mutation runs through.
 *
 * A service never reads a cookie or a header: it receives an ActorContext.
 * That keeps the permission decision in one testable place and makes it
 * impossible for a code path to reach a service without one.
 */

import { can, type AdminRole, type Permission } from './rbac';
import { SYSTEM_USER_ID, type SessionUser } from './session';
import { forbidden, unauthenticated } from '@/lib/errors';

export interface ActorContext {
  user: SessionUser;
  /** Salted hash of the request IP, recorded on the audit row. Never the raw IP. */
  ipHash: string | null;
}

export function requirePermission(actor: ActorContext | null, permission: Permission): ActorContext {
  if (!actor) throw unauthenticated();
  if (!can(actor.user.role, permission)) {
    // The permission is named verbatim so the message is actionable: whoever
    // reads it can look the string up in the role table on the Settings page.
    throw forbidden(
      `Your role (${actor.user.role}) does not have the "${permission}" permission.`,
    );
  }
  return actor;
}

export function actorRole(actor: ActorContext): AdminRole {
  return actor.user.role;
}

/**
 * A system actor for work with no signed-in user behind it — migrations,
 * seeds and scheduled jobs. Never reachable from a request.
 */
export const SYSTEM_ACTOR: ActorContext = {
  user: {
    id: SYSTEM_USER_ID,
    email: 'system@betindia.bet',
    name: 'System',
    role: 'super_admin',
    status: 'active',
    mfaEnrolled: false,
  },
  ipHash: null,
};
