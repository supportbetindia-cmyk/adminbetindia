/**
 * POST /api/v1/destinations/{id}/revoke
 *
 * Withdraws an approval already granted. Links pointing at it stop redirecting
 * immediately — see services/destinations.ts.
 */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { revokeDestination } from '@/services/destinations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async ({ actor, params, body }) =>
  json({ data: await revokeDestination(db, actor, params.id, body) }),
);
