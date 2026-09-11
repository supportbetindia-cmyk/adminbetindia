/**
 * GET /api/v1/reports/funnel
 *
 * Website and WhatsApp funnels are returned as separate objects and must not
 * be summed — Backend Schema §9 treats mixing them as a failure.
 */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { attributionCoverage, funnels } from '@/services/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) => {
  const query = queryObject(searchParams);
  return json({
    funnels: await funnels(db, actor, query),
    attribution: await attributionCoverage(db, actor, query),
  });
});
