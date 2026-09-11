/**
 * Dashboard (UI/UX §4).
 *
 * Every KPI carries its own availability marker, and a metric with no source
 * shows N/A rather than zero. The publisher performance table keeps
 * publisher-reported figures in their own columns with the discrepancy stated,
 * per PRD §11.
 */

import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import {
  attributionCoverage, clickTrend, funnels, overviewReport, publisherPerformance,
} from '@/services/reports';
import { listPublishers } from '@/services/publishers';
import { listSelectableCampaigns } from '@/services/campaigns';
import { formatDateTime, formatMetric, formatMoney, formatPercent } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { FilterBar } from '@/components/filter-bar';
import { Funnel, TrendChart } from '@/components/charts';
import { Card, EmptyState, MetricCard, Notice, NumberCell, PermissionDenied } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard — Smart Link Manager' };

type Search = Record<string, string | string[] | undefined>;

function one(search: Search, key: string): string | undefined {
  const value = search[key];
  return Array.isArray(value) ? value[0] : value;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireActor('/dashboard');
  if (!can(actor.user.role, 'reports:read')) return <PermissionDenied needed="reports:read" />;

  const search = await searchParams;
  const filter = {
    from: one(search, 'from'),
    to: one(search, 'to'),
    publisherId: one(search, 'publisherId'),
    campaignId: one(search, 'campaignId'),
    creativeId: one(search, 'creativeId'),
    destinationType: one(search, 'destinationType'),
    device: one(search, 'device'),
    includeFiltered: one(search, 'includeFiltered'),
  };

  const [overview, trend, funnelReports, coverage, publishers, campaigns] = await Promise.all([
    overviewReport(db, actor, filter),
    clickTrend(db, actor, filter),
    funnels(db, actor, filter),
    attributionCoverage(db, actor, filter),
    can(actor.user.role, 'publishers:read') ? listPublishers(db, actor) : Promise.resolve([]),
    can(actor.user.role, 'campaigns:read') ? listSelectableCampaigns(db, actor) : Promise.resolve([]),
  ]);

  const performance = await publisherPerformance(db, actor, filter);
  const from = overview.window.from.toISOString().slice(0, 10);
  const to = overview.window.to.toISOString().slice(0, 10);
  const unavailableCount = overview.metrics.filter((m) => m.availability === 'unavailable').length;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Data freshness: generated ${formatDateTime(overview.generatedAt)}. Storage is UTC; all times display in IST.`}
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        <FilterBar
          action="/dashboard"
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
        />

        {unavailableCount > 0 && (
          <Notice tone="info" title={`${unavailableCount} of ${overview.metrics.length} metrics have no connected source`}>
            They display as <strong>N/A</strong>, which is not the same as zero. Each card states
            why. The blocking items are listed in{' '}
            <code>docs/Outstanding_Requirements_Checklist.pdf</code>, sections B, C and D.
          </Notice>
        )}

        <div className="metrics">
          {overview.metrics.map((metric) => <MetricCard key={metric.key} metric={metric} />)}
        </div>

        <Card
          title="Raw, filtered and counted clicks"
          description="PRD §5: bot and fraud signals are recorded on the event and never silently alter raw counts. Filtering is applied here, at report time."
        >
          <div className="row" style={{ gap: 40 }}>
            <div>
              <div className="metric__label">Raw click events</div>
              <div className="metric__value">{formatMetric(overview.clickBreakdown.raw)}</div>
            </div>
            <div>
              <div className="metric__label">Flagged as bot or link preview</div>
              <div className="metric__value">{formatMetric(overview.clickBreakdown.filtered)}</div>
            </div>
            <div>
              <div className="metric__label">Counted in this report</div>
              <div className="metric__value">{formatMetric(overview.clickBreakdown.counted)}</div>
            </div>
          </div>
        </Card>

        <Card title="Daily clicks" description="Counted clicks with flagged traffic shown separately.">
          <TrendChart points={trend} />
        </Card>

        <div className="funnels">
          {funnelReports.map((report) => <Funnel key={report.channel} report={report} />)}
        </div>

        <Card
          title="Publisher performance"
          description="First-party counts and publisher-reported counts are kept in separate columns. PRD §11 requires the discrepancy be shown, not reconciled away."
          flush
        >
          {performance.length === 0 ? (
            <EmptyState
              title="No clicks from any publisher in this range"
              body={
                <>
                  Create a campaign and an active smart link, then traffic will appear here.{' '}
                  {can(actor.user.role, 'campaigns:write') && <Link href="/campaigns/new">Create a campaign</Link>}
                </>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Publisher</th>
                    <th className="num">Clicks (ours)</th>
                    <th className="num">Filtered</th>
                    <th className="num">Unique estimate</th>
                    <th className="num">Impressions (theirs)</th>
                    <th className="num">Clicks (theirs)</th>
                    <th className="num">Discrepancy</th>
                    <th className="num">Spend</th>
                    <th className="num">CPC</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map((row) => (
                    <tr key={row.publisherId}>
                      <td>
                        <Link href={`/publishers/${row.publisherId}`}>{row.publisherName}</Link>
                      </td>
                      <td className="num">{formatMetric(row.clicks)}</td>
                      <td className="num">{formatMetric(row.filteredClicks)}</td>
                      <td className="num" title="Deduplicated estimate, not a count of people (PRD §5)">
                        ≈ {formatMetric(row.uniqueEstimate)}
                      </td>
                      <td className="num"><NumberCell value={row.publisherReportedImpressions} /></td>
                      <td className="num"><NumberCell value={row.publisherReportedClicks} /></td>
                      <td className="num">
                        {row.clickDiscrepancy === null ? (
                          <span className="subtle" title="No publisher report imported for this range.">N/A</span>
                        ) : (
                          <>
                            {row.clickDiscrepancy > 0 ? '+' : ''}{formatMetric(row.clickDiscrepancy)}
                            <span className="cell-sub">{formatPercent(row.clickDiscrepancyPct)}</span>
                          </>
                        )}
                      </td>
                      <td className="num">{row.spend === null ? <span className="subtle">N/A</span> : formatMoney(row.spend)}</td>
                      <td className="num">{row.costPerClick === null ? <span className="subtle">N/A</span> : formatMoney(row.costPerClick)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Attribution coverage">
          <div className="row" style={{ gap: 40, marginBottom: 16 }}>
            <div>
              <div className="metric__label">Clicks in range</div>
              <div className="metric__value">{formatMetric(coverage.totalClicks)}</div>
            </div>
            <div>
              <div className="metric__label">Still resolving to an approved destination</div>
              <div className="metric__value">{formatMetric(coverage.resolvable)}</div>
            </div>
          </div>
          <Notice tone="warn" title="No attribution model is approved yet">
            {coverage.note} TRD §10 proposes first eligible click within a 30-day window,
            &ldquo;subject to business approval&rdquo; — that approval is item F2 on the outstanding
            requirements checklist.
          </Notice>
        </Card>
      </div>
    </>
  );
}
