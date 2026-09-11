/** POST /api/v1/destinations/{id}/reject */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { rejectDestination } from '@/services/destinations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async ({ actor, params, body }) =>
  json({ data: await rejectDestination(db, actor, params.id, body) }),
);
