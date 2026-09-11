/** GET, POST /api/v1/publishers */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { createPublisher, listPublishers } from '@/services/publishers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor }) => json({ data: await listPublishers(db, actor) }));

export const POST = route(async ({ actor, body }) =>
  json({ data: await createPublisher(db, actor, body) }, 201),
);
