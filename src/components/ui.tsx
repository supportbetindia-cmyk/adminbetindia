/**
 * Shared presentation components (UI/UX Handoff §15).
 *
 * Server components with no client-side state. Two rules run through all of
 * them:
 *
 *  - Status is never communicated by colour alone (§1) — every badge carries
 *    a text label, and availability markers carry a glyph as well.
 *  - An unavailable value renders as N/A with the reason attached, never as
 *    zero (§4).
 */

import type { ReactNode } from 'react';
import { formatMetric } from '@/lib/format';
import type { Availability, Metric } from '@/services/reports';

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`badge badge--${tone}`}>
      <span className="badge__dot" aria-hidden />
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  active: 'ok', approved: 'ok', eligible: 'ok',
  draft: 'neutral', unconfirmed: 'neutral', archived: 'neutral', ended: 'neutral',
  paused: 'warn', pending: 'warn',
  rejected: 'danger', revoked: 'danger', ineligible: 'danger', suspended: 'danger',
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="subtle">—</span>;
  const tone = STATUS_TONES[status] ?? 'neutral';
  return <Badge tone={tone}>{status.replace(/_/g, ' ')}</Badge>;
}

const AVAILABILITY_GLYPH: Record<Availability, string> = {
  measured: '●',
  estimated: '≈',
  unavailable: '○',
};

const AVAILABILITY_LABEL: Record<Availability, string> = {
  measured: 'Measured',
  estimated: 'Estimate',
  unavailable: 'Not available',
};

export function AvailabilityTag({ availability }: { availability: Availability }) {
  return (
    <span className={`avail avail--${availability}`}>
      <span aria-hidden>{AVAILABILITY_GLYPH[availability]}</span>
      {AVAILABILITY_LABEL[availability]}
    </span>
  );
}

/**
 * A KPI card. The definition and source are always in the DOM (as a tooltip
 * and as screen-reader text), because §4 requires every metric to expose them.
 */
export function MetricCard({ metric }: { metric: Metric }) {
  const isNa = metric.value === null;
  return (
    <div className="metric" title={`${metric.definition}\n\nSource: ${metric.source}`}>
      <span className="metric__label">{metric.label}</span>
      <span className={`metric__value${isNa ? ' metric__value--na' : ''}`}>
        {formatMetric(metric.value)}
      </span>
      <span className="metric__foot">
        <AvailabilityTag availability={metric.availability} />
      </span>
      <span className="visually-hidden">
        {metric.definition} Source: {metric.source}
      </span>
    </div>
  );
}

export function Card({
  title, description, actions, children, flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card__head">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {description && <p className="card__desc">{description}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={`card__body${flush ? ' card__body--flush' : ''}`}>{children}</div>
    </section>
  );
}

export function EmptyState({
  title, body, action, icon = '◌',
}: { title: string; body?: ReactNode; action?: ReactNode; icon?: string }) {
  return (
    <div className="state">
      <span className="state__icon" aria-hidden>{icon}</span>
      <p className="state__title">{title}</p>
      {body && <div className="state__body">{body}</div>}
      {action}
    </div>
  );
}

export function Notice({
  tone = 'neutral', title, children,
}: { tone?: 'neutral' | 'info' | 'warn' | 'danger' | 'ok'; title?: string; children: ReactNode }) {
  return (
    <div className={`notice${tone === 'neutral' ? '' : ` notice--${tone}`}`} role={tone === 'danger' ? 'alert' : undefined}>
      <div>
        {title && <strong className="notice__title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}

/** Renders the 403 state required by §14 without leaking what is behind it. */
export function PermissionDenied({ needed }: { needed: string }) {
  return (
    <Card title="Permission denied">
      <EmptyState
        icon="⌀"
        title="Your role cannot open this page"
        body={
          <>
            This screen needs the <code>{needed}</code> permission. Roles are defined in
            PRD §3 — ask a Super Admin if you need access.
          </>
        }
      />
    </Card>
  );
}

export function PageHint({ children }: { children: ReactNode }) {
  return <p className="pagehint">{children}</p>;
}

/** A number that may legitimately be unknown. */
export function NumberCell({ value, suffix }: { value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined) {
    return <span className="subtle" title="No source connected for this metric. This is not zero.">N/A</span>;
  }
  return <>{formatMetric(value)}{suffix}</>;
}
