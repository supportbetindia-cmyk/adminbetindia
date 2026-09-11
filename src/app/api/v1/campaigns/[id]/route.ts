/** GET, PATCH /api/v1/campaigns/{id} — controlled updates, including activation. */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { getCampaign, updateCampaign } from '@/services/campaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, params }) =>
  json({ data: await getCampaign(db, actor, params.id) }),
);

export const PATCH = route(async ({ actor, params, body }) =>
  json({ data: await updateCampaign(db, actor, params.id, body) }),
);
