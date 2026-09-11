/** GET /api/v1/audit-logs */

import { db } from '@/db';
import { json, queryObject, route } from '@/lib/api';
import { listAuditLogs } from '@/services/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async ({ actor, searchParams }) => {
  const q = queryObject(searchParams);
  return json(
    await listAuditLogs(db, actor, {
      entityType: q.entityType,
      entityId: q.entityId,
      actorId: q.actorId,
      action: q.action,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    }),
  );
});
