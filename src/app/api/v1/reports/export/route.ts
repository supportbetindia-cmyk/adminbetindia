/**
 * POST /api/v1/reports/export — permission-controlled CSV export.
 *
 * Backend Schema §5 requires personal-data minimisation on export. No phone
 * number, no IP hash and no visitor token leaves this endpoint; the click ID
 * is included because it is a random event identifier, not an identity.
 *
 * TRD §6 describes this as asynchronous. It is synchronous here because the
 * only export available is click detail, which is capped and returns in one
 * request. When a report needs a job queue, this route is where it moves.
 */

import { NextResponse } from 'next/server';
import { db } from '@/db';
import { route, toErrorResponse } from '@/lib/api';
import { buildCsv, csvFilename, type CsvColumn } from '@/lib/csv';
import { clickDetail, publisherPerformance, resolveWindow } from '@/services/reports';
import { parseInput, reportFilterSchema } from '@/lib/validation';
import { requirePermission } from '@/lib/auth/context';
import { DISPLAY_TIMEZONE } from '@/lib/format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXPORT_ROW_CAP = 50_000;

export const POST = route(async ({ actor, body }) => {
  try {
    requirePermission(actor, 'reports:export');

    const payload = (body ?? {}) as Record<string, unknown>;
    const report = String(payload.report ?? 'clicks');
    const filter = parseInput(reportFilterSchema, payload.filter ?? {});
    const window = resolveWindow(filter);
    const from = window.from.toISOString().slice(0, 10);
    const to = window.to.toISOString().slice(0, 10);

    const sharedNotes = [
      'Clicks are first-party events recorded on the redirect endpoint.',
      'Publisher-reported figures are kept separate and are never reconciled into first-party counts (PRD §11).',
      'Attribution model: not yet approved. TRD §10 proposes first click within a 30-day window, subject to business approval.',
      `Bot and link-preview traffic is ${filter.includeFiltered ? 'included' : 'excluded'} in this export; raw rows are never deleted (PRD §5).`,
    ];

    if (report === 'publishers') {
      const rows = await publisherPerformance(db, actor, filter);
      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { key: 'publisher', header: 'Publisher', value: (r) => r.publisherName },
        { key: 'clicks', header: 'Clicks (first-party)', value: (r) => r.clicks },
        { key: 'filtered', header: 'Filtered clicks', value: (r) => r.filteredClicks },
        { key: 'unique', header: 'Unique click estimate', value: (r) => r.uniqueEstimate },
        { key: 'pubImpr', header: 'Impressions (publisher-reported)', value: (r) => r.publisherReportedImpressions ?? 'N/A' },
        { key: 'pubClicks', header: 'Clicks (publisher-reported)', value: (r) => r.publisherReportedClicks ?? 'N/A' },
        { key: 'disc', header: 'Click discrepancy', value: (r) => r.clickDiscrepancy ?? 'N/A' },
        { key: 'discPct', header: 'Click discrepancy %', value: (r) => (r.clickDiscrepancyPct === null ? 'N/A' : r.clickDiscrepancyPct.toFixed(2)) },
        { key: 'spend', header: 'Spend', value: (r) => r.spend ?? 'N/A' },
        { key: 'cpc', header: 'CPC', value: (r) => (r.costPerClick === null ? 'N/A' : r.costPerClick.toFixed(2)) },
      ];

      return csvResponse(
        buildCsv(rows, columns, {
          title: 'BetIndia Smart Link — publisher performance',
          generatedAt: new Date(),
          timezone: DISPLAY_TIMEZONE,
          filters: { from, to, ...stringFilters(filter) },
          notes: sharedNotes,
          definitions: [
            { label: 'Unique click estimate', text: 'Distinct first-party visitor tokens. A deduplicated estimate, not a count of people (PRD §5).' },
            { label: 'Click discrepancy', text: 'First-party clicks minus publisher-reported clicks. A permanent gap is expected; agree whose number bills.' },
            { label: 'N/A', text: 'The source for this metric is not connected. It does not mean zero.' },
          ],
        }),
        csvFilename('publisher_performance', from, to),
      );
    }

    const rows = await clickDetail(db, actor, filter, EXPORT_ROW_CAP);
    const columns: CsvColumn<(typeof rows)[number]>[] = [
      { key: 'occurredAt', header: 'Occurred at (UTC)', value: (r) => r.occurredAt },
      { key: 'clickId', header: 'Click ID', value: (r) => r.clickId },
      { key: 'publisher', header: 'Publisher', value: (r) => r.publisher },
      { key: 'campaign', header: 'Campaign', value: (r) => r.campaign },
      { key: 'slug', header: 'Slug', value: (r) => r.slug },
      { key: 'destinationType', header: 'Destination type', value: (r) => r.destinationType },
      { key: 'destinationVersion', header: 'Destination version', value: (r) => r.destinationVersion },
      { key: 'device', header: 'Device', value: (r) => r.device },
      { key: 'os', header: 'OS', value: (r) => r.os },
      { key: 'publisherClickId', header: 'Publisher click ID', value: (r) => r.publisherClickId },
      { key: 'isFiltered', header: 'Flagged as non-human', value: (r) => (r.isFiltered ? 'yes' : 'no') },
      { key: 'botFlags', header: 'Signals', value: (r) => r.botFlags },
    ];

    return csvResponse(
      buildCsv(rows, columns, {
        title: 'BetIndia Smart Link — click detail',
        generatedAt: new Date(),
        timezone: DISPLAY_TIMEZONE,
        filters: { from, to, ...stringFilters(filter) },
        notes: [
          ...sharedNotes,
          `Capped at ${EXPORT_ROW_CAP.toLocaleString('en-IN')} rows; narrow the date range if this export is truncated.`,
          'No phone number, IP hash or visitor token is included (Backend Schema §5).',
        ],
        definitions: [
          { label: 'Click ID', text: 'A random event identifier. It is not a person and is not reused.' },
          { label: 'Destination version', text: 'The destination version live at click time. Later changes never rewrite it (Backend Schema §3).' },
        ],
      }),
      csvFilename('click_detail', from, to),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
});

function stringFilters(filter: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ['publisherId', 'campaignId', 'creativeId', 'smartLinkId', 'destinationType', 'device']) {
    const value = filter[key];
    if (value) out[key] = String(value);
  }
  out.includeFiltered = String(Boolean(filter.includeFiltered));
  return out;
}

function csvResponse(csv: string, filename: string): NextResponse {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
