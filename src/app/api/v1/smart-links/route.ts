/** GET, POST /api/v1/smart-links */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { createSmartLink, listSmartLinks, type SmartLinkFilter } from '@/services/smart-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) => {
  const q = queryObject(searchParams);
  const filter: SmartLinkFilter = {
    campaignId: q.campaignId,
    publisherId: q.publisherId,
    status: q.status as SmartLinkFilter['status'],
  };
  return json({ data: await listSmartLinks(db, actor, filter) });
});

export const POST = route(async ({ actor, body }) =>
  json({ data: await createSmartLink(db, actor, body) }, 201),
);
