/**
 * GET, PATCH /api/v1/smart-links/{id} — pause, resume and permitted edits.
 *
 * There is no DELETE. UI/UX §7: never destroy historical attribution.
 */

import { db } from '@/db';
import { json, route } from '@/lib/api';
import { getSmartLink, updateSmartLink } from '@/services/smart-links';
import { listDestinationHistory } from '@/services/destinations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, params }) =>
  json({
    data: await getSmartLink(db, actor, params.id),
    history: await listDestinationHistory(db, actor, params.id),
  }),
);

export const PATCH = route(async ({ actor, params, body }) =>
  json({ data: await updateSmartLink(db, actor, params.id, body) }),
);
