/** PATCH /api/v1/users/{id} — role, status and password reset. */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { updateUser } from '@/services/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(async ({ actor, params, body }) =>
  json({ data: await updateUser(db, actor, params.id, body) }),
);
