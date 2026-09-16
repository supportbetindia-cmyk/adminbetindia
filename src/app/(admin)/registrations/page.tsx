/**
 * Registrations (UI/UX §9).
 *
 * Shows verified registrations with the ad that produced them. Every column
 * after the user ID comes from the click record, which pinned the publisher,
 * campaign and creative at the moment it happened — so changing a campaign
 * today cannot rewrite what a registration last month is attributed to.
 *
 * Unattributed registrations are listed, not hidden. TRD §10 requires the
 * unknown bucket be visible rather than distributed across campaigns.
 */

import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { listRegistrations, registrationSummary } from '@/services/registrations';
import { formatDateTime, formatMetric, maskPhone } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Badge, Card, EmptyState, Notice, PermissionDenied } from '@/components/ui';
import { PendingIntegration } from '@/components/pending-integration';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Registrations — Smart Link Manager' };

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export default async function RegistrationsPage() {
  const actor = await requireActor('/registrations');
  if (!can(actor.user.role, 'registrations:read')) {
    return <PermissionDenied needed="registrations:read" />;
  }

  const summary = await registrationSummary(db);

  // Nothing has ever arrived: show what is blocked and on whom, rather than an
  // empty table that looks like zero performance.
  if (summary.total === 0) {
    return (
      <>
        <PageHeader
          title="Registrations"
          description="Verified accounts, and the ad each one came from."
          actions={<AccountMenu user={actor.user} />}
        />
        <PendingIntegration
          title="Registrations"
          summary={
            <>
              The ingestion endpoint is live at <code>POST /api/v1/webhooks/registrations</code>,
              but nothing has been sent to it yet. The website team needs to call it when an
              account is created.
            </>
          }
          definition={
            <>
              A registration requires an <strong>actual external user ID and a completed
              account</strong>, delivered from an authorized server. A form submission is not a
              registration (PRD §6, TRD §9) — those appear in the website funnel instead.
            </>
          }
          ceiling={
            <>
              A person who clicks on their phone and registers on a laptop breaks the chain, and no
              amount of engineering reconnects them without a login identity spanning both devices.
              Those registrations arrive with no click ID and stay in the unknown bucket.
            </>
          }
          blockers={[
            {
              what: 'Call POST /api/v1/webhooks/registrations on account creation',
              owner: 'Website / web team',
              consequence: 'No registration counts, and no click-to-registration rate.',
            },
            {
              what: 'Pass the bi_click value captured by bi-click.js',
              owner: 'Website / web team',
              consequence: 'Registrations arrive but cannot be tied to an ad — everything is unattributed.',
            },
            {
              what: 'A shared secret set as REGISTRATION_WEBHOOK_SECRET',
              owner: 'Whoever runs the deployment',
              consequence: 'The endpoint refuses every request until it is configured.',
            },
          ]}
          columns={['User ID', 'Registered', 'Publisher', 'Campaign', 'Ad', 'Click ID', 'Attribution']}
        />
      </>
    );
  }

  const rows = await listRegistrations(db, 100);
  const maySeePhone = can(actor.user.role, 'pii:reveal');

  return (
    <>
      <PageHeader
        title="Registrations"
        description="Verified accounts, and the ad each one came from."
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        <div className="metrics">
          <div className="metric">
            <span className="metric__label">Verified registrations</span>
            <span className="metric__value">{formatMetric(summary.total)}</span>
          </div>
          <div className="metric">
            <span className="metric__label">Attributed to an ad</span>
            <span className="metric__value">{formatMetric(summary.attributed)}</span>
            <span className="field__hint">Exact click ID match</span>
          </div>
          <div className="metric">
            <span className="metric__label">Unattributed</span>
            <span className="metric__value">{formatMetric(summary.unknown)}</span>
            <span className="field__hint">Stays unknown — never spread across campaigns</span>
          </div>
        </div>

        {summary.unknown > 0 && (
          <Notice tone="warn" title={`${summary.unknown} registration(s) could not be traced to an ad`}>
            Usually one of: the visitor arrived without clicking a smart link, the click ID was not
            passed through the signup, the cookie expired, or they clicked on one device and
            registered on another. TRD §10 forbids distributing these across campaigns to make the
            report look complete, so they are counted here and nowhere else.
          </Notice>
        )}

        {summary.byCreative.length > 0 && (
          <Card
            title="Which ad produced registrations"
            description="Grouped by the creative that was actually clicked, taken from the click record rather than the campaign's current settings."
            flush
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Ad</th><th>Format</th><th>Publisher</th><th>Campaign</th>
                    <th>Link</th><th className="num">Registrations</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byCreative.map((row, i) => (
                    <tr key={`${row.slug ?? 'none'}-${i}`}>
                      <td>{row.creativeName ?? <span className="subtle">No creative recorded</span>}</td>
                      <td>{row.creativeFormat ?? '—'}</td>
                      <td>{row.publisherName ?? '—'}</td>
                      <td>{row.campaignName ?? '—'}</td>
                      <td>{row.slug ? <code>/c/{row.slug}</code> : '—'}</td>
                      <td className="num">{formatMetric(row.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card title="Registrations" description="Most recent first." flush>
          {rows.length === 0 ? (
            <EmptyState title="No registrations yet" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>User ID</th>
                    <th>Registered</th>
                    <th>Phone</th>
                    <th>Publisher</th>
                    <th>Campaign</th>
                    <th>Ad</th>
                    <th>Link</th>
                    <th>Clicked</th>
                    <th>Device</th>
                    <th>Location</th>
                    <th>Attribution</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <code>{row.externalUserId}</code>
                        <span className="cell-sub">{row.sourceSystem}</span>
                      </td>
                      <td className="nowrap">{formatDateTime(row.registeredAt)}</td>
                      <td>
                        {/* Masked unless the role explicitly permits PII (UI/UX §9). */}
                        {row.contactKey
                          ? (maySeePhone ? row.contactKey : maskPhone(row.contactKey))
                          : <span className="subtle">—</span>}
                      </td>
                      <td>{row.publisherName ?? <span className="subtle">—</span>}</td>
                      <td>{row.campaignName ?? <span className="subtle">—</span>}</td>
                      <td>
                        {row.creativeName ?? <span className="subtle">—</span>}
                        {row.creativeFormat && <span className="cell-sub">{row.creativeFormat}</span>}
                      </td>
                      <td>{row.slug ? <code>/c/{row.slug}</code> : <span className="subtle">—</span>}</td>
                      <td className="nowrap">
                        {row.clickedAt ? formatDateTime(row.clickedAt) : <span className="subtle">—</span>}
                        {row.secondsToRegister !== null && (
                          <span className="cell-sub">{duration(row.secondsToRegister)} to register</span>
                        )}
                      </td>
                      <td>
                        {row.device ?? <span className="subtle">—</span>}
                        {row.os && <span className="cell-sub">{row.os}</span>}
                      </td>
                      <td>
                        {row.geoCity ?? <span className="subtle">—</span>}
                        {row.geoRegion && <span className="cell-sub">≈ {row.geoRegion}</span>}
                      </td>
                      <td>
                        {row.confidence === 'exact'
                          ? <Badge tone="ok">exact</Badge>
                          : <Badge tone="neutral">unknown</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Notice tone="info" title="About these attributions">
          Matching is an exact click-ID join — the strongest available, and the only kind accepted
          here. There is deliberately no fallback that guesses from timing or device.
          <br /><br />
          The attribution <strong>model</strong> is still unapproved: TRD §10 proposes first
          eligible click within a 30-day window, subject to business sign-off. Every decision is
          stamped with its policy version, so they can all be recomputed if a different model is
          chosen.
        </Notice>
      </div>
    </>
  );
}
