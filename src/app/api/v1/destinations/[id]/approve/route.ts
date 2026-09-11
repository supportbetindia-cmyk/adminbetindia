/**
 * POST /api/v1/destinations/{id}/approve
 *
 * Requires `destinations:approve`, which campaign_manager does not hold — see
 * the NEEDS SIGN-OFF note in lib/auth/rbac.ts.
 */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { approveDestination } from '@/services/destinations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async ({ actor, params, body }) =>
  json({ data: await approveDestination(db, actor, params.id, body) }),
);
