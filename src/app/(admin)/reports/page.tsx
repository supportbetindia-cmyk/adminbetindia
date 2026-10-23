/**
 * Reports (UI/UX §11).
 *
 * Cost-per-result columns are computed from imported spend and measured
 * clicks. Everything downstream of a click reads N/A, and the reconciliation
 * section states the unmatched count rather than hiding it.
 */

import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import {
  attributionCoverage, clickDetail, geoBreakdown, overviewReport, publisherPerformance,
} from '@/services/reports';
import { listPublishers } from '@/services/publishers';
import { listSelectableCampaigns } from '@/services/campaigns';
import { DISPLAY_TIMEZONE, formatDateTime, formatMetric, formatMoney, formatPercent } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { FilterBar } from '@/components/filter-bar';
import { ExportAction } from '@/components/export-action';
import { Badge, Card, EmptyState, Notice, NumberCell, PermissionDenied } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reports — Smart Link Manager' };

type Search = Record<string, string | string[] | undefined>;
const one = (s: Search, k: string) => (Array.isArray(s[k]) ? s[k]![0] : (s[k] as string | undefined));

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireActor('/reports');
  if (!can(actor.user.role, 'reports:read')) return <PermissionDenied needed="reports:read" />;

  const search = await searchParams;
  const filter = {
    from: one(search, 'from'),
    to: one(search, 'to'),
    publisherId: one(search, 'publisherId'),
    campaignId: one(search, 'campaignId'),
    destinationType: one(search, 'destinationType'),
    device: one(search, 'device'),
    includeFiltered: one(search, 'includeFiltered'),
  };

  const [overview, performance, coverage, publishers, campaigns] = await Promise.all([
    overviewReport(db, actor, filter),
    publisherPerformance(db, actor, filter),
    attributionCoverage(db, actor, filter),
    can(actor.user.role, 'publishers:read') ? listPublishers(db, actor) : Promise.resolve([]),
    can(actor.user.role, 'campaigns:read') ? listSelectableCampaigns(db, actor) : Promise.resolve([]),
  ]);

  const [rows, geo] = await Promise.all([
    clickDetail(db, actor, filter, 200),
    geoBreakdown(db, actor, filter, 50),
  ]);
  const from = overview.window.from.toISOString().slice(0, 10);
  const to = overview.window.to.toISOString().slice(0, 10);
  const mayExport = can(actor.user.role, 'reports:export');

  const spend = overview.metrics.find((m) => m.key === 'spend')?.value ?? null;
  const clicks = overview.metrics.find((m) => m.key === 'clicks')?.value ?? 0;

  return (
    <>
      <PageHeader
        title="Reports"
        description={`Timezone ${DISPLAY_TIMEZONE}. Generated ${formatDateTime(overview.generatedAt)}.`}
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        <FilterBar
          action="/reports"
          from={from}
          to={to}
          publishers={publishers.map((p) => ({ value: p.id, label: p.name }))}
          campaigns={campaigns.map((c) => ({ value: c.id, label: `${c.publisherName} — ${c.name}` }))}
          selected={{
            publisherId: filter.publisherId,
            campaignId: filter.campaignId,
            destinationType: filter.destinationType,
            device: filter.device,
            includeFiltered: filter.includeFiltered === 'true',
          }}
        >
          {mayExport && <ExportAction report="publishers" filter={{ ...filter, from, to }} label="Export publishers" />}
          {mayExport && <ExportAction report="clicks" filter={{ ...filter, from, to }} label="Export clicks" />}
        </FilterBar>

        <Card
          title="Cost per result"
          description="Worked out from clicks and imported spend. Everything after the click shows N/A until those sources are connected."
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Metric</th><th className="num">Count</th><th className="num">Cost per result</th><th>Availability</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>Clicks</td>
                  <td className="num">{formatMetric(clicks)}</td>
                  <td className="num">
                    {spend !== null && clicks ? formatMoney(spend / clicks) : <span className="subtle">N/A</span>}
                  </td>
                  <td>Measured</td>
                </tr>
                {(['leads', 'registrations', 'ftd'] as const).map((key) => {
                  const metric = overview.metrics.find((m) => m.key === key)!;
                  return (
                    <tr key={key}>
                      <td>{metric.label}</td>
                      <td className="num"><NumberCell value={metric.value} /></td>
                      <td className="num"><span className="subtle">N/A</span></td>
                      <td className="muted small">{metric.source}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>
            ROAS and ROI are not shown yet. They need agreed revenue, cost and accounting
            definitions are approved, and deposits are not automatically revenue or profit.
          </p>
        </Card>

        <Card
          title="Reconciliation"
          description="The publisher’s numbers against yours. Some gap is normal — agree upfront whose number you pay on."
          flush
        >
          {performance.length === 0 ? (
            <EmptyState title="No clicks in this range" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Publisher</th>
                    <th className="num">Clicks (ours)</th>
                    <th className="num">Clicks (theirs)</th>
                    <th className="num">Gap</th>
                    <th className="num">Gap %</th>
                    <th className="num">Impressions (theirs)</th>
                    <th className="num">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map((row) => (
                    <tr key={row.publisherId}>
                      <td>{row.publisherName}</td>
                      <td className="num">{formatMetric(row.clicks)}</td>
                      <td className="num"><NumberCell value={row.publisherReportedClicks} /></td>
                      <td className="num"><NumberCell value={row.clickDiscrepancy} /></td>
                      <td className="num">{formatPercent(row.clickDiscrepancyPct)}</td>
                      <td className="num"><NumberCell value={row.publisherReportedImpressions} /></td>
                      <td className="num">{row.spend === null ? <span className="subtle">N/A</span> : formatMoney(row.spend)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Notice tone="warn" title="Unmatched conversions">
          {coverage.note}
        </Notice>

        <Card
          title="Location by link"
          description="Where clicks came from, and which link they arrived on."
          flush
        >
          {geo.length === 0 ? (
            <EmptyState title="No clicks in this range" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Link</th><th>City</th><th>Region</th><th>Country</th>
                    <th className="num">Clicks</th><th className="num">Unique estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {geo.map((row, i) => (
                    <tr key={`${row.slug}-${row.city ?? 'unknown'}-${row.region ?? ''}-${i}`}>
                      <td className="nowrap"><code>/c/{row.slug}</code></td>
                      <td>
                        {row.city ?? <span className="subtle">Unknown</span>}
                        {row.city && <span className="cell-sub">≈ estimate</span>}
                      </td>
                      <td>{row.region ?? <span className="subtle">—</span>}</td>
                      <td>{row.country ?? <span className="subtle">—</span>}</td>
                      <td className="num">{formatMetric(row.clicks)}</td>
                      <td className="num">≈ {formatMetric(row.uniqueEstimate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {geo.length > 0 && (
            <p className="small muted" style={{ padding: '10px 16px 14px', margin: 0 }}>
              City is a best guess from the IP address, not a fact. Indian mobile networks route
              through regional hubs, so someone in a small town often shows up as the state
              capital — trust the region more than the city.
            </p>
          )}
        </Card>

        <Card
          title="Click detail"
          description="The 200 most recent clicks in this range. Export for the full set."
          flush
        >
          {rows.length === 0 ? (
            <EmptyState title="No clicks in this range" body="A measured zero — the redirect endpoint is live." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th><th>Publisher</th><th>Campaign</th><th>Slug</th>
                    <th>Type</th><th>Ver</th><th>Device</th><th>OS</th>
                    <th>Publisher click ID</th><th>Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.clickId}>
                      <td className="nowrap">{formatDateTime(r.occurredAt)}</td>
                      <td>{r.publisher}</td>
                      <td>{r.campaign}</td>
                      <td><code>{r.slug}</code></td>
                      <td>{r.destinationType}</td>
                      <td>v{r.destinationVersion}</td>
                      <td>{r.device ?? '—'}</td>
                      <td>{r.os ?? '—'}</td>
                      <td>{r.publisherClickId ?? <span className="subtle">—</span>}</td>
                      <td>
                        {r.isFiltered
                          ? <Badge tone="warn">Excluded from counts</Badge>
                          : <span className="subtle small">—</span>}
                        {r.botFlags && <span className="cell-sub">{r.botFlags}</span>}
                      </td>
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
