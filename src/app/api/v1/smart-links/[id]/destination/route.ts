/**
 * POST /api/v1/smart-links/{id}/destination
 *
 * Points the link at a different approved destination by appending a new
 * immutable version. Historical clicks keep their original version.
 */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { changeSmartLinkDestination } from '@/services/smart-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async ({ actor, params, body }) =>
  json({ data: await changeSmartLinkDestination(db, actor, params.id, body) }),
);
