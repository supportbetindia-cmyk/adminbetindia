/** PATCH /api/v1/creatives/{id} */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { updateCreative } from '@/services/creatives';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(async ({ actor, params, body }) =>
  json({ data: await updateCreative(db, actor, params.id, body) }),
);
