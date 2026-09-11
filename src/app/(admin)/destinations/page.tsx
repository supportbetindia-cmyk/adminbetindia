/**
 * Destination registry (TRD §5).
 *
 * The registry is the only source of destination URLs. Nothing here accepts a
 * URL from a query parameter, and the redirect engine re-validates the host
 * and scheme on every request regardless of what is stored.
 */

import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { listDestinations } from '@/services/destinations';
import { listPublishers } from '@/services/publishers';
import { formatDateTime, formatMetric } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, EmptyState, Notice, PermissionDenied, StatusBadge } from '@/components/ui';
import { ApproveForm, DestinationForm, RejectForm } from '@/components/destination-controls';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Destinations — Smart Link Manager' };

export default async function DestinationsPage() {
  const actor = await requireActor('/destinations');
  if (!can(actor.user.role, 'destinations:read')) return <PermissionDenied needed="destinations:read" />;

  const [destinations, publishers] = await Promise.all([
    listDestinations(db, actor),
    can(actor.user.role, 'publishers:read') ? listPublishers(db, actor) : Promise.resolve([]),
  ]);

  const mayWrite = can(actor.user.role, 'destinations:write');
  const mayApprove = can(actor.user.role, 'destinations:approve');
  const pending = destinations.filter((d) => d.approvalStatus === 'pending').length;

  return (
    <>
      <PageHeader
        title="Destinations"
        description="The allowlisted registry every redirect resolves against."
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        <Notice tone="info" title="How a destination becomes usable">
          A destination is registered as <strong>pending</strong> and can carry no traffic. Approving
          it requires a recorded publisher approval reference. Withdrawing an approval stops every
          link pointing at it, immediately. The URL itself is never editable — historical clicks pin
          the version they used (Backend Schema §3).
          {!mayApprove && mayWrite && (
            <> Your role can register a destination but not approve one; ask a Super Admin.</>
          )}
        </Notice>

        {pending > 0 && (
          <Notice tone="warn" title={`${pending} destination${pending === 1 ? '' : 's'} awaiting approval`}>
            Links cannot point at these until they are approved.
          </Notice>
        )}

        <Card flush>
          {destinations.length === 0 ? (
            <EmptyState
              icon="⇥"
              title="No destinations registered"
              body="Register the exact approved URL a campaign should send traffic to."
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Destination</th>
                    <th>Type</th>
                    <th>Approval</th>
                    <th>Reference</th>
                    <th>Scope</th>
                    <th className="num">Links</th>
                    {mayApprove && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {destinations.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.label ?? 'Unlabelled'}</strong>
                        <span className="cell-sub mono truncate" title={d.url}>{d.url}</span>
                      </td>
                      <td>{d.type}</td>
                      <td>
                        <StatusBadge status={d.approvalStatus} />
                        {d.approvedAt && <span className="cell-sub">{formatDateTime(d.approvedAt)}</span>}
                      </td>
                      <td>
                        {d.approvalReference ?? <span className="subtle">—</span>}
                        {d.approvalNotes && <span className="cell-sub">{d.approvalNotes}</span>}
                      </td>
                      <td>{d.publisherName ?? <span className="subtle">Any publisher</span>}</td>
                      <td className="num">{formatMetric(d.linkCount)}</td>
                      {mayApprove && (
                        <td>
                          <div className="stack stack--tight" style={{ minWidth: 240 }}>
                            {d.approvalStatus !== 'approved' && <ApproveForm id={d.id} />}
                            {d.approvalStatus === 'pending' && <RejectForm id={d.id} mode="reject" />}
                            {d.approvalStatus === 'approved' && <RejectForm id={d.id} mode="revoke" />}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {mayWrite && (
          <Card title="Register a destination">
            <DestinationForm publishers={publishers.map((p) => ({ value: p.id, label: p.name }))} />
          </Card>
        )}
      </div>
    </>
  );
}
