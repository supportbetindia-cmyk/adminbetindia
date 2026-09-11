/** GET, POST /api/v1/campaigns */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { createCampaign, listCampaigns, type CampaignFilter } from '@/services/campaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) => {
  const q = queryObject(searchParams);
  const filter: CampaignFilter = {
    publisherId: q.publisherId,
    status: q.status as CampaignFilter['status'],
  };
  return json({ data: await listCampaigns(db, actor, filter) });
});

export const POST = route(async ({ actor, body }) =>
  json({ data: await createCampaign(db, actor, body) }, 201),
);
