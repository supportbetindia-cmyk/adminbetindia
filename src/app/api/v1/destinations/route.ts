/** GET, POST /api/v1/destinations — the approved destination registry (TRD §5). */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { createDestination, listDestinations, type DestinationFilter } from '@/services/destinations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) => {
  const q = queryObject(searchParams);
  const filter: DestinationFilter = {
    type: q.type as DestinationFilter['type'],
    approvalStatus: q.approvalStatus as DestinationFilter['approvalStatus'],
    publisherId: q.publisherId,
  };
  return json({ data: await listDestinations(db, actor, filter) });
});

export const POST = route(async ({ actor, body }) =>
  json({ data: await createDestination(db, actor, body) }, 201),
);
