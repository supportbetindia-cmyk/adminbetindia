import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { listCampaigns } from '@/services/campaigns';
import { formatDate, formatMetric, formatMoney } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, EmptyState, PageHint, PermissionDenied, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Campaigns — Smart Link Manager' };

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; publisherId?: string }>;
}) {
  const actor = await requireActor('/campaigns');
  if (!can(actor.user.role, 'campaigns:read')) return <PermissionDenied needed="campaigns:read" />;

  const { status, publisherId } = await searchParams;
  const campaigns = await listCampaigns(db, actor, {
    publisherId,
    status: status as 'draft' | 'active' | 'paused' | 'ended' | undefined,
  });
  const mayWrite = can(actor.user.role, 'campaigns:write');

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="One publisher, one destination type, one approved destination per link."
        actions={
          <>
            {mayWrite && <Link href="/campaigns/new" className="btn btn--primary">New campaign</Link>}
            <AccountMenu user={actor.user} />
          </>
        }
      />

      <div className="content">
        <div className="row">
          {['', 'draft', 'active', 'paused', 'ended'].map((s) => (
            <Link
              key={s || 'all'}
              href={s ? `/campaigns?status=${s}` : '/campaigns'}
              className={`btn btn--sm${(status ?? '') === s ? ' btn--primary' : ''}`}
            >
              {s ? s[0].toUpperCase() + s.slice(1) : 'All'}
            </Link>
          ))}
        </div>

        <PageHint>
          Clicks below are raw counts against the campaign. Bot and link-preview filtering is applied
          on the Dashboard and in Reports, never to the stored events (PRD §5).
        </PageHint>

        <Card flush>
          {campaigns.length === 0 ? (
            <EmptyState
              icon="◎"
              title={status ? `No ${status} campaigns` : 'No campaigns yet'}
              body="A campaign needs a publisher whose approvals have been recorded first."
              action={mayWrite ? <Link href="/campaigns/new" className="btn btn--primary">New campaign</Link> : undefined}
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Publisher</th>
                    <th>Status</th>
                    <th>Schedule</th>
                    <th className="num">Budget</th>
                    <th className="num">Links</th>
                    <th className="num">Clicks (raw)</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/campaigns/${c.id}`}>{c.name}</Link>
                        {c.placement && <span className="cell-sub">{c.placement}</span>}
                      </td>
                      <td><Link href={`/publishers/${c.publisherId}`}>{c.publisherName}</Link></td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="nowrap">
                        {formatDate(c.startsAt)} → {formatDate(c.endsAt)}
                        <span className="cell-sub">{c.timezone}</span>
                      </td>
                      <td className="num">{c.budgetAmount ? formatMoney(c.budgetAmount, c.currency) : <span className="subtle">—</span>}</td>
                      <td className="num">{formatMetric(c.linkCount)}</td>
                      <td className="num">{formatMetric(c.clickCount)}</td>
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
