/**
 * Publishers list (UI/UX §5).
 *
 * The permission columns are the point of this screen. "No publisher approval
 * is assumed" (§5), so a publisher with nothing recorded reads as unconfirmed
 * rather than as ready to run.
 */

import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { listPublishers } from '@/services/publishers';
import { formatMetric } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Badge, Card, EmptyState, PageHint, PermissionDenied, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Publishers — Smart Link Manager' };

export default async function PublishersPage() {
  const actor = await requireActor('/publishers');
  if (!can(actor.user.role, 'publishers:read')) return <PermissionDenied needed="publishers:read" />;

  const publishers = await listPublishers(db, actor);
  const mayWrite = can(actor.user.role, 'publishers:write');

  return (
    <>
      <PageHeader
        title="Publishers"
        description="Approved capabilities per publisher. Nothing is permitted until it is recorded here."
        actions={
          <>
            {mayWrite && <Link href="/publishers/new" className="btn btn--primary">Add publisher</Link>}
            <AccountMenu user={actor.user} />
          </>
        }
      />

      <div className="content">
        <PageHint>
          TRD §13: only capabilities explicitly approved by the publisher may be enabled. A campaign
          cannot be activated until its publisher is marked eligible, has approved the tracking URL,
          and has approved the destination type in use.
        </PageHint>

        <Card flush>
          {publishers.length === 0 ? (
            <EmptyState
              icon="◈"
              title="No publishers yet"
              body="Add a publisher once you have their written approval for the tracking URL and destination types."
              action={mayWrite ? <Link href="/publishers/new" className="btn btn--primary">Add publisher</Link> : undefined}
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Publisher</th>
                    <th>Status</th>
                    <th>Eligibility</th>
                    <th>Tracking URL</th>
                    <th>Destinations approved</th>
                    <th>Click macros</th>
                    <th className="num">Campaigns</th>
                  </tr>
                </thead>
                <tbody>
                  {publishers.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/publishers/${p.id}`}>{p.name}</Link>
                        {p.externalReference && <span className="cell-sub mono">{p.externalReference}</span>}
                      </td>
                      <td><StatusBadge status={p.status} /></td>
                      <td><StatusBadge status={p.eligibility} /></td>
                      <td>
                        {p.trackingUrlApproved
                          ? <Badge tone="ok">Approved</Badge>
                          : <Badge tone="warn">Not approved</Badge>}
                      </td>
                      <td>
                        {p.permittedDestinationTypes.length === 0
                          ? <Badge tone="warn">None</Badge>
                          : p.permittedDestinationTypes.map((t) => <Badge key={t} tone="info">{t}</Badge>)}
                      </td>
                      <td>
                        {p.trackingMacros.length === 0
                          ? <span className="subtle small">None recorded</span>
                          : <code>{p.trackingMacros.join(', ')}</code>}
                      </td>
                      <td className="num">{formatMetric(p.campaignCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
