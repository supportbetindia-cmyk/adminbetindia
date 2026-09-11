/** GET, POST /api/v1/users — Super Admin only (PRD §3). */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { createUser, listUsers } from '@/services/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor }) => json({ data: await listUsers(db, actor) }));

export const POST = route(async ({ actor, body }) =>
  json({ data: await createUser(db, actor, body) }, 201),
);
