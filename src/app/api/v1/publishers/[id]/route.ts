/** GET, PATCH /api/v1/publishers/{id} */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { getPublisher, updatePublisher } from '@/services/publishers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, params }) =>
  json({ data: await getPublisher(db, actor, params.id) }),
);

export const PATCH = route(async ({ actor, params, body }) =>
  json({ data: await updatePublisher(db, actor, params.id, body) }),
);
