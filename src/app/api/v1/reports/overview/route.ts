/** GET /api/v1/reports/overview — KPI cards with per-metric availability. */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { overviewReport } from '@/services/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) =>
  json(await overviewReport(db, actor, queryObject(searchParams))),
);
