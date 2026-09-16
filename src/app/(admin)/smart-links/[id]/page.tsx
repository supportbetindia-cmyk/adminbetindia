/** Smart link detail: the live URL, destination version history, and controls. */

import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import {
  getSmartLink, previewDestination, shortUrlFor,
} from '@/services/smart-links';
import { listApprovedDestinations, listDestinationHistory } from '@/services/destinations';
import { entityHistory } from '@/services/audit-log';
import { formatDateTime, formatMetric } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, Notice, PermissionDenied, StatusBadge } from '@/components/ui';
import { CopyButton } from '@/components/form';
import { ChangeDestinationForm, SmartLinkStatusControls } from '@/components/smart-link-controls';

export const dynamic = 'force-dynamic';

export default async function SmartLinkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireActor(`/smart-links/${id}`);
  if (!can(actor.user.role, 'links:read')) return <PermissionDenied needed="links:read" />;

  const link = await getSmartLink(db, actor, id);
  const [versions, audit, destinations] = await Promise.all([
    listDestinationHistory(db, actor, id),
    can(actor.user.role, 'audit:read') ? entityHistory(db, actor, 'smart_link', id) : [],
    can(actor.user.role, 'links:write')
      ? listApprovedDestinations(db, actor, link.publisherId)
      : Promise.resolve([]),
  ]);

  // Built by the same function the redirect engine uses, so the preview cannot
  // disagree with what a real click does.
  const preview = link.activeDestinationId
    ? await previewDestination(db, actor, link.activeDestinationId).catch(() => null)
    : null;

  const mayWrite = can(actor.user.role, 'links:write');

  return (
    <>
      <PageHeader
        title={`/c/${link.slug}`}
        description={
          <>
            <Link href={`/campaigns/${link.campaignId}`}>{link.campaignName}</Link>
            {' · '}<Link href={`/publishers/${link.publisherId}`}>{link.publisherName}</Link>
            {' · '}<StatusBadge status={link.status} />
          </>
        }
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        {link.destinationApproval !== 'approved' && (
          <Notice tone="danger" title="This link has no approved destination">
            Its destination is <strong>{link.destinationApproval ?? 'missing'}</strong>. Clicks are
            refused with a 503 and no redirect is issued — the engine never falls back to a guessed
            URL (PRD §4).
          </Notice>
        )}

        <Card title="The link">
          <div className="stack">
            <div className="row">
              <code style={{ fontSize: 16 }}>{shortUrlFor(link.slug)}</code>
              <CopyButton value={shortUrlFor(link.slug)} label="Copy URL" />
            </div>
            <div>
              <span className="metric__label">Resolves to</span>
              <div><code className="truncate" title={preview ?? ''}>{preview ?? link.destinationUrl ?? '—'}</code></div>
            </div>
            {link.destinationType === 'whatsapp' && (
              <Notice tone="warn" title="Track banners with separate smart links">
                WhatsApp receives only the approved prefilled message. Use a different smart link for
                each banner to measure its redirect clicks. An incoming message cannot be matched back
                to a banner after the customer enters WhatsApp.
              </Notice>
            )}
          </div>
        </Card>

        <Card title="Status and lifecycle">
          <div className="row row--between">
            <div className="row" style={{ gap: 32 }}>
              <div>
                <div className="metric__label">Clicks recorded</div>
                <div className="metric__value">{formatMetric(link.clickCount)}</div>
              </div>
              <div>
                <div className="metric__label">Destination version</div>
                <div className="metric__value">v{link.activeDestinationVersion}</div>
              </div>
              <div>
                <div className="metric__label">Expires</div>
                <div>{link.expiresAt ? formatDateTime(link.expiresAt) : <span className="subtle">Never</span>}</div>
              </div>
            </div>
            {mayWrite && <SmartLinkStatusControls id={link.id} status={link.status} clickCount={link.clickCount} />}
          </div>
        </Card>

        <Card
          title="Destination version history"
          description="Every click stores the version it used. Changing the destination appends a version and never rewrites what came before (Backend Schema §3)."
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Version</th><th>Effective from</th><th>Destination</th><th>Type</th><th>Approval</th><th>Approval ref</th></tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version}>
                    <td>
                      v{v.version}
                      {v.version === link.activeDestinationVersion && <span className="cell-sub">live</span>}
                    </td>
                    <td className="nowrap">{formatDateTime(v.effectiveAt)}</td>
                    <td><span className="truncate mono" title={v.url}>{v.url}</span></td>
                    <td>{v.type}</td>
                    <td><StatusBadge status={v.approvalStatus} /></td>
                    <td>{v.approvalReference ?? <span className="subtle">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {mayWrite && (
          <Card title="Change destination" description="Points this link at a different approved destination.">
            <ChangeDestinationForm
              id={link.id}
              currentDestinationId={link.activeDestinationId}
              destinations={destinations.map((d) => ({
                value: d.id,
                label: `${d.label ?? d.url} (${d.type})`,
                url: d.url,
                type: d.type,
              }))}
            />
          </Card>
        )}

        {audit.length > 0 && (
          <Card title="Change history" flush>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Summary</th><th>Approval ref</th></tr></thead>
                <tbody>
                  {audit.map((row) => (
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
      </div>
    </>
  );
}
