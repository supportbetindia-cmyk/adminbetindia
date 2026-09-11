/** Publisher detail (UI/UX §5): approvals, campaigns and the change history. */

import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { getPublisher, publisherPermits } from '@/services/publishers';
import { listCampaigns } from '@/services/campaigns';
import { entityHistory } from '@/services/audit-log';
import { formatDateTime, formatMetric } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Badge, Card, EmptyState, Notice, PermissionDenied, StatusBadge } from '@/components/ui';
import { PublisherForm } from '@/components/publisher-form';

export const dynamic = 'force-dynamic';

export default async function PublisherDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireActor(`/publishers/${id}`);
  if (!can(actor.user.role, 'publishers:read')) return <PermissionDenied needed="publishers:read" />;

  const publisher = await getPublisher(db, actor, id);
  const campaigns = can(actor.user.role, 'campaigns:read')
    ? await listCampaigns(db, actor, { publisherId: id })
    : [];
  const history = can(actor.user.role, 'audit:read')
    ? await entityHistory(db, actor, 'publisher', id)
    : [];

  const website = publisherPermits(publisher, 'website');
  const whatsapp = publisherPermits(publisher, 'whatsapp');
  const mayWrite = can(actor.user.role, 'publishers:write');

  return (
    <>
      <PageHeader
        title={publisher.name}
        description={<>Publisher · <StatusBadge status={publisher.status} /></>}
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        <Card title="Can this publisher run traffic?" description="Evaluated the same way campaign activation evaluates it.">
          <div className="stack">
            <div className="row">
              <strong style={{ width: 120 }}>Website</strong>
              {website.permitted
                ? <Badge tone="ok">Permitted</Badge>
                : <><Badge tone="danger">Blocked</Badge> <span className="muted">{website.reason}</span></>}
            </div>
            <div className="row">
              <strong style={{ width: 120 }}>WhatsApp</strong>
              {whatsapp.permitted
                ? <Badge tone="ok">Permitted</Badge>
                : <><Badge tone="danger">Blocked</Badge> <span className="muted">{whatsapp.reason}</span></>}
            </div>
          </div>
        </Card>

        <Card title="Campaigns" flush>
          {campaigns.length === 0 ? (
            <EmptyState title="No campaigns for this publisher yet" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Campaign</th><th>Status</th><th className="num">Links</th><th className="num">Clicks</th></tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id}>
                      <td><Link href={`/campaigns/${c.id}`}>{c.name}</Link></td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="num">{formatMetric(c.linkCount)}</td>
                      <td className="num">{formatMetric(c.clickCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {mayWrite ? (
          <Card title="Approvals and details" description="Changing any of these writes an audit record.">
            <PublisherForm publisher={publisher} />
          </Card>
        ) : (
          <Card title="Approvals and details">
            <Notice>Your role can view publishers but not change them.</Notice>
          </Card>
        )}

        {history.length > 0 && (
          <Card title="Change history" flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>When</th><th>Actor</th><th>Action</th><th>Summary</th></tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap">{formatDateTime(row.occurredAt)}</td>
                      <td>{row.actorEmail ?? '—'}<span className="cell-sub">{row.actorRole ?? ''}</span></td>
                      <td><code>{row.action}</code></td>
                      <td>{row.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
