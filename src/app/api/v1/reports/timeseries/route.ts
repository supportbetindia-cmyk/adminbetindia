/** GET /api/v1/reports/timeseries — daily clicks, with filtered traffic shown separately. */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { clickTrend } from '@/services/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) =>
  json({ data: await clickTrend(db, actor, queryObject(searchParams)) }),
);
