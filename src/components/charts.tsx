/**
 * Trend chart and funnels.
 *
 * Rendered server-side as plain elements rather than through a charting
 * library: the dataset is small, the shapes are simple, and it keeps the
 * numbers computed on the server (UI/UX §15).
 */

import { formatDate, formatMetric } from '@/lib/format';
import type { FunnelReport, TrendPoint } from '@/services/reports';
import { EmptyState } from './ui';

export function TrendChart({ points }: { points: TrendPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.clicks + p.filtered));
  const hasData = points.some((p) => p.clicks + p.filtered > 0);

  if (!hasData) {
    return (
      <EmptyState
        icon="▁"
        title="No clicks recorded in this range"
        body="This is a measured zero, not a missing integration — the redirect endpoint is live and recording."
      />
    );
  }

  return (
    <div>
      <div className="trend" role="img" aria-label={`Daily clicks from ${points[0]?.date} to ${points.at(-1)?.date}`}>
        {points.map((p) => (
          <div key={p.date} className="trend__col" title={`${p.date}: ${p.clicks} counted, ${p.filtered} filtered`}>
            {p.filtered > 0 && (
              <div className="trend__bar trend__bar--filtered" style={{ height: `${(p.filtered / max) * 100}%` }} />
            )}
            <div className="trend__bar" style={{ height: `${(p.clicks / max) * 100}%` }} />
          </div>
        ))}
      </div>

      <div className="trend__axis">
        <span>{formatDate(points[0]?.date)}</span>
        <span>{formatDate(points.at(-1)?.date)}</span>
      </div>

      <div className="legend" style={{ marginTop: 12 }}>
        <span className="legend__key">
          <span className="legend__swatch" style={{ background: 'var(--primary)' }} aria-hidden />
          Counted clicks
        </span>
        <span className="legend__key">
          <span className="legend__swatch" style={{ background: 'var(--border-strong)' }} aria-hidden />
          Flagged as bot or link preview — recorded, excluded from counts (PRD §5)
        </span>
        <span className="legend__key">Peak day: {formatMetric(max)}</span>
      </div>

      {/* An accessible alternative to the bars (§13). */}
      <details style={{ marginTop: 16 }}>
        <summary className="small muted">View as a table</summary>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="data">
            <thead>
              <tr><th>Date</th><th className="num">Counted</th><th className="num">Filtered</th></tr>
            </thead>
            <tbody>
              {points.filter((p) => p.clicks + p.filtered > 0).map((p) => (
                <tr key={p.date}>
                  <td>{formatDate(p.date)}</td>
                  <td className="num">{formatMetric(p.clicks)}</td>
                  <td className="num">{formatMetric(p.filtered)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

const CHANNEL_LABEL: Record<FunnelReport['channel'], string> = {
  website: 'Website funnel',
  whatsapp: 'WhatsApp funnel',
};

/**
 * One funnel per channel. They are rendered side by side and never combined —
 * Backend Schema §9 treats mixing the two as a failed acceptance test.
 */
export function Funnel({ report }: { report: FunnelReport }) {
  const top = report.stages.find((s) => s.value !== null)?.value ?? 0;

  return (
    <div className="card">
      <div className="card__head">
        <div>
          <h3 className="card__title">{CHANNEL_LABEL[report.channel]}</h3>
          <p className="card__desc">
            {report.channel === 'whatsapp'
              ? 'A redirect is not an open, and an open is not a lead. Each stage needs its own observable event.'
              : 'Each stage needs a confirmed first-party event. Missing stages stay missing.'}
          </p>
        </div>
      </div>

      <div className="card__body">
        {report.stages.map((stage) => {
          const pct = stage.value !== null && top > 0 ? (stage.value / top) * 100 : 0;
          return (
            <div className="funnel__stage" key={stage.key} title={stage.note}>
              <span className="funnel__label">{stage.label}</span>
              <span className="funnel__bar">
                {stage.value === null ? (
                  <span className="funnel__fill funnel__fill--none" aria-hidden />
                ) : (
                  <span className="funnel__fill" style={{ width: `${Math.max(pct, 1)}%` }} aria-hidden />
                )}
              </span>
              <span className={`funnel__value${stage.value === null ? ' funnel__value--na' : ''}`}>
                {stage.value === null ? 'N/A' : formatMetric(stage.value)}
              </span>
            </div>
          );
        })}

        <ul className="small muted" style={{ margin: '16px 0 0', paddingLeft: 18 }}>
          {report.stages
            .filter((s) => s.availability === 'unavailable')
            .map((s) => <li key={s.key}>{s.label}: {s.note}</li>)}
        </ul>
      </div>
    </div>
  );
}
