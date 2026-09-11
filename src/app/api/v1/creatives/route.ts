/** GET, POST /api/v1/creatives */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { createCreative, listCreatives } from '@/services/creatives';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) =>
  json({ data: await listCreatives(db, actor, { campaignId: queryObject(searchParams).campaignId }) }),
);

export const POST = route(async ({ actor, body }) =>
  json({ data: await createCreative(db, actor, body) }, 201),
);
