/** Campaign detail: schedule, creatives, links, spend and change history. */

import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { getCampaign } from '@/services/campaigns';
import { listCreatives } from '@/services/creatives';
import { listSmartLinks } from '@/services/smart-links';
import { listCampaignCosts } from '@/services/costs';
import { entityHistory } from '@/services/audit-log';
import { publisherPermits } from '@/services/publishers';
import { formatDate, formatDateTime, formatMetric, formatMoney } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Badge, Card, EmptyState, Notice, PermissionDenied, StatusBadge } from '@/components/ui';
import { CampaignForm } from '@/components/campaign-form';
import { CampaignStatusControls, CostForm, CreativeForm } from '@/components/campaign-controls';

export const dynamic = 'force-dynamic';

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireActor(`/campaigns/${id}`);
  if (!can(actor.user.role, 'campaigns:read')) return <PermissionDenied needed="campaigns:read" />;

  const campaign = await getCampaign(db, actor, id);
  const [creatives, links, costs, history] = await Promise.all([
    can(actor.user.role, 'creatives:read') ? listCreatives(db, actor, { campaignId: id }) : [],
    can(actor.user.role, 'links:read') ? listSmartLinks(db, actor, { campaignId: id }) : [],
    can(actor.user.role, 'costs:read') ? listCampaignCosts(db, actor, id) : [],
    can(actor.user.role, 'audit:read') ? entityHistory(db, actor, 'campaign', id) : [],
  ]);

  const mayWrite = can(actor.user.role, 'campaigns:write');
  const totalSpend = costs.reduce((sum, c) => sum + Number(c.amount), 0);
  const hasApprovedLink = links.some((l) => l.destinationApproval === 'approved');
  const website = publisherPermits(campaign.publisher, 'website');
  const whatsapp = publisherPermits(campaign.publisher, 'whatsapp');
  const blockers: string[] = [];
  if (!hasApprovedLink) blockers.push('No link on this campaign points at an approved destination.');
  if (!website.permitted && !whatsapp.permitted) blockers.push(website.reason);

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={
          <>
            <Link href={`/publishers/${campaign.publisherId}`}>{campaign.publisher.name}</Link>
            {' · '}<StatusBadge status={campaign.status} />
            {campaign.placement && ` · ${campaign.placement}`}
          </>
        }
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        {campaign.status !== 'active' && blockers.length > 0 && mayWrite && (
          <Notice tone="warn" title="This campaign cannot be activated yet">
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </Notice>
        )}

        <Card title="Status">
          <div className="row row--between">
            <div className="row" style={{ gap: 32 }}>
              <div>
                <div className="metric__label">Schedule</div>
                <div>{formatDate(campaign.startsAt)} → {formatDate(campaign.endsAt)}</div>
                <div className="small muted">{campaign.timezone}</div>
              </div>
              <div>
                <div className="metric__label">Planned budget</div>
                <div>{campaign.budgetAmount ? formatMoney(campaign.budgetAmount, campaign.currency) : <span className="subtle">Not set</span>}</div>
              </div>
              <div>
                <div className="metric__label">Actual spend recorded</div>
                <div>{costs.length ? formatMoney(totalSpend, campaign.currency) : <span className="subtle">N/A</span>}</div>
              </div>
              <div>
                <div className="metric__label">Attribution window</div>
                <div>{campaign.attributionWindowDays} days</div>
                <div className="small muted">Model not yet approved</div>
              </div>
            </div>
            {mayWrite && <CampaignStatusControls id={campaign.id} status={campaign.status} />}
          </div>
        </Card>

        <Card
          title="Smart links"
          description="Each link resolves to exactly one approved destination."
          actions={can(actor.user.role, 'links:write')
            ? <Link href={`/smart-links/new?campaignId=${campaign.id}`} className="btn btn--sm btn--primary">New link</Link>
            : undefined}
          flush
        >
          {links.length === 0 ? (
            <EmptyState title="No links yet" body="A campaign needs at least one link pointing at an approved destination before it can run." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Slug</th><th>Type</th><th>Destination</th><th>Version</th><th>Status</th><th className="num">Clicks</th></tr>
                </thead>
                <tbody>
                  {links.map((l) => (
                    <tr key={l.id}>
                      <td><Link href={`/smart-links/${l.id}`}><code>/c/{l.slug}</code></Link></td>
                      <td>{l.destinationType}</td>
                      <td>
                        <span className="truncate" title={l.destinationUrl ?? ''}>{l.destinationUrl ?? '—'}</span>
                        <span className="cell-sub"><StatusBadge status={l.destinationApproval} /></span>
                      </td>
                      <td>v{l.activeDestinationVersion}</td>
                      <td><StatusBadge status={l.status} /></td>
                      <td className="num">{formatMetric(l.clickCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Creatives"
          description="Only approved creatives can be attached to a smart link."
          flush
        >
          {creatives.length === 0 ? (
            <EmptyState title="No creatives recorded" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Creative</th><th>Format</th><th>Placement ID</th><th>Approval</th><th className="num">Links</th><th className="num">Clicks</th></tr>
                </thead>
                <tbody>
                  {creatives.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.format ?? '—'}</td>
                      <td>{c.placementId ?? '—'}</td>
                      <td><StatusBadge status={c.approvalStatus} /></td>
                      <td className="num">{formatMetric(c.linkCount)}</td>
                      <td className="num">{formatMetric(c.clickCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {can(actor.user.role, 'creatives:write') && (
          <Card title="Add a creative"><CreativeForm campaignId={campaign.id} /></Card>
        )}

        <Card
          title="Recorded spend"
          description="Actual spend, imported per day and per source. Kept separate from the planned budget."
          flush
        >
          {costs.length === 0 ? (
            <EmptyState
              title="No spend recorded"
              body="Cost-per-click, cost-per-lead and cost-per-FTD show N/A until spend is imported. PRD §16 requires the cost import process to be confirmed."
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Date</th><th className="num">Amount</th><th>Source</th><th>Reference</th></tr></thead>
                <tbody>
                  {costs.map((c) => (
                    <tr key={c.id}>
                      <td>{formatDate(c.costDate)}</td>
                      <td className="num">{formatMoney(c.amount, c.currency)}</td>
                      <td><code>{c.source}</code></td>
                      <td>{c.externalReference ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {can(actor.user.role, 'costs:write') && (
          <Card title="Record spend"><CostForm campaignId={campaign.id} currency={campaign.currency} /></Card>
        )}

        {mayWrite && (
          <Card title="Campaign details" description="Changes are audit-logged with before and after values.">
            <CampaignForm campaign={campaign} publishers={[{ value: campaign.publisherId, label: campaign.publisher.name }]} />
          </Card>
        )}

        {history.length > 0 && (
          <Card title="Change history" flush>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Summary</th><th>Approval ref</th></tr></thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap">{formatDateTime(row.occurredAt)}</td>
                      <td>{row.actorEmail ?? '—'}</td>
                      <td><code>{row.action}</code></td>
                      <td>{row.summary}</td>
                      <td>{row.approvalReference ?? <span className="subtle">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <div className="row">
          <Badge tone="neutral">Campaign ID</Badge>
          <code className="small">{campaign.id}</code>
        </div>
      </div>
    </>
  );
}
