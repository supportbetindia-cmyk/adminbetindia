/** GET, PATCH /api/v1/destinations/{id}. The URL itself is immutable. */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { getDestination, updateDestination } from '@/services/destinations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, params }) =>
  json({ data: await getDestination(db, actor, params.id) }),
);

export const PATCH = route(async ({ actor, params, body }) =>
  json({ data: await updateDestination(db, actor, params.id, (body ?? {}) as { label?: string | null }) }),
);
