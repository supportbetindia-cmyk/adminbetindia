/**
 * GET /api/v1/reports/publishers
 *
 * First-party clicks and publisher-reported clicks are returned as separate
 * fields with an explicit discrepancy. PRD §11 requires the gap be shown, not
 * reconciled away.
 */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { publisherPerformance } from '@/services/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) =>
  json({ data: await publisherPerformance(db, actor, queryObject(searchParams)) }),
);
