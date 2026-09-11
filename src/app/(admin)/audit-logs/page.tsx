/**
 * Audit log (UI/UX §12).
 *
 * Actor, action, entity, before/after, timestamp and approval reference. The
 * before/after payloads are redacted by key name before they are written, so
 * no credential can appear here (Backend Schema §8).
 */

import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { listAuditActions, listAuditLogs } from '@/services/audit-log';
import { formatDateTime, formatMetric } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, EmptyState, PageHint, PermissionDenied } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit Logs — Smart Link Manager' };

const PAGE_SIZE = 50;

export default async function AuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entityType?: string; offset?: string }>;
}) {
  const actor = await requireActor('/audit-logs');
  if (!can(actor.user.role, 'audit:read')) return <PermissionDenied needed="audit:read" />;

  const { action, entityType, offset } = await searchParams;
  const start = Number(offset ?? 0) || 0;

  const [page, actions] = await Promise.all([
    listAuditLogs(db, actor, { action, entityType, limit: PAGE_SIZE, offset: start }),
    listAuditActions(db, actor),
  ]);

  const query = (next: number) => {
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (entityType) params.set('entityType', entityType);
    if (next > 0) params.set('offset', String(next));
    const qs = params.toString();
    return qs ? `/audit-logs?${qs}` : '/audit-logs';
  };

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description={`${formatMetric(page.total)} recorded events. Newest first.`}
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        <PageHint>
          Every administrative mutation writes a row here with before and after values. Audit rows
          are never edited or deleted — there is no code path in this system that does either.
        </PageHint>

        <form className="filterbar" method="get" action="/audit-logs">
          <div className="field">
            <label className="field__label" htmlFor="action">Action</label>
            <select id="action" name="action" defaultValue={action ?? ''}>
              <option value="">All actions</option>
              {actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="entityType">Entity</label>
            <select id="entityType" name="entityType" defaultValue={entityType ?? ''}>
              <option value="">All entities</option>
              {['publisher', 'campaign', 'creative', 'destination', 'smart_link', 'campaign_cost', 'admin_user']
                .map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div className="filterbar__spacer" />
          <button type="submit" className="btn btn--primary">Apply</button>
          <Link href="/audit-logs" className="btn">Reset</Link>
        </form>

        <Card flush>
          {page.data.length === 0 ? (
            <EmptyState icon="❐" title="No audit records match" body="Every administrative change appears here as soon as it happens." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th><th>Actor</th><th>Action</th><th>Entity</th>
                    <th>Summary</th><th>Approval ref</th><th>Before / after</th>
                  </tr>
                </thead>
                <tbody>
                  {page.data.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap">{formatDateTime(row.occurredAt)}</td>
                      <td>
                        {row.actorEmail ?? <span className="subtle">system</span>}
                        {row.actorRole && <span className="cell-sub">{row.actorRole}</span>}
                      </td>
                      <td><code>{row.action}</code></td>
                      <td>
                        {row.entityType}
                        <span className="cell-sub mono small">{row.entityId.slice(0, 8)}…</span>
                      </td>
                      <td>{row.summary ?? <span className="subtle">—</span>}</td>
                      <td>{row.approvalReference ?? <span className="subtle">—</span>}</td>
                      <td>
                        {row.beforeData || row.afterData ? (
                          <details>
                            <summary className="small muted">View</summary>
                            <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxWidth: 420 }}>
{JSON.stringify({ before: row.beforeData, after: row.afterData }, null, 2)}
                            </pre>
                          </details>
                        ) : <span className="subtle">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="row row--between">
          <span className="small muted">
            Showing {formatMetric(start + 1)}–{formatMetric(Math.min(start + PAGE_SIZE, page.total))} of {formatMetric(page.total)}
          </span>
          <div className="row">
            {start > 0 && <Link href={query(Math.max(0, start - PAGE_SIZE))} className="btn btn--sm">Previous</Link>}
            {start + PAGE_SIZE < page.total && <Link href={query(start + PAGE_SIZE)} className="btn btn--sm">Next</Link>}
          </div>
        </div>
      </div>
    </>
  );
}
