/**
 * Integrations (TRD §12).
 *
 * Today this screen exists for one job: to show the raw webhook events
 * Interakt actually sends, so the payload schema can be verified from real
 * data rather than assumed (PRD §7, TRD §8, Backend Schema §10).
 *
 * It shows the events untouched. No field is interpreted, no lead is implied.
 */

import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { inboxSummary, listInbox } from '@/services/webhooks';
import { shortUrlBase } from '@/services/smart-links';
import { formatDateTime, formatMetric } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Badge, Card, EmptyState, Notice, PermissionDenied } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Integrations — Smart Link Manager' };

function webhookUrl(): string {
  // Same reason as shortUrlBase: an empty env var must not become an empty
  // base, or the URL shown here is one Interakt cannot call.
  const base = process.env.PUBLIC_APP_URL?.trim() || shortUrlBase();
  return `${base.replace(/\/+$/, '')}/api/v1/webhooks/interakt`;
}

export default async function IntegrationsPage() {
  const actor = await requireActor('/integrations');
  if (!can(actor.user.role, 'integrations:read')) {
    return <PermissionDenied needed="integrations:read" />;
  }

  const [summary, events] = await Promise.all([
    inboxSummary(db, 'interakt'),
    listInbox(db, 'interakt', 25),
  ]);

  const secretConfigured = Boolean(process.env.INTERAKT_WEBHOOK_SECRET);
  const usingBodyHash = summary.eventIdSources.some((s) => s.source === 'body_sha256');

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Webhook capture and provider status."
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        <Card
          title="Interakt — WhatsApp"
          description="Capture only. Events are stored and shown untouched; nothing is parsed into a lead yet."
        >
          <div className="stack">
            <div>
              <span className="metric__label">Webhook URL — paste this into Interakt</span>
              <div><code style={{ fontSize: 15 }}>{webhookUrl()}</code></div>
              <span className="field__hint">
                The endpoint must be reachable from the public internet. On localhost, use a tunnel
                (ngrok, Cloudflare Tunnel) and set <code>PUBLIC_APP_URL</code> to the tunnel address.
              </span>
            </div>

            <div className="row">
              <strong style={{ width: 150 }}>Authentication</strong>
              {secretConfigured
                ? <Badge tone="ok">Shared secret required</Badge>
                : <><Badge tone="warn">Unauthenticated</Badge>
                    <span className="muted small">
                      Anyone who learns this URL can post to it. Set <code>INTERAKT_WEBHOOK_SECRET</code> once
                      you know whether Interakt can send a custom header.
                    </span></>}
            </div>
          </div>
        </Card>

        {summary.total === 0 ? (
          <Card title="Captured events" flush>
            <EmptyState
              icon="○"
              title="No events received yet"
              body={
                <>
                  Point Interakt&apos;s webhook at the URL above and send a test WhatsApp message.
                  The raw event will appear here, and that is what tells us the real payload shape.
                </>
              }
            />
          </Card>
        ) : (
          <>
            <div className="metrics">
              <div className="metric">
                <span className="metric__label">Events captured</span>
                <span className="metric__value">{formatMetric(summary.total)}</span>
              </div>
              <div className="metric">
                <span className="metric__label">Redeliveries absorbed</span>
                <span className="metric__value">{formatMetric(summary.duplicates)}</span>
                <span className="field__hint">Duplicates collapse onto one row.</span>
              </div>
              <div className="metric">
                <span className="metric__label">Awaiting processing</span>
                <span className="metric__value">{formatMetric(summary.pending)}</span>
                <span className="field__hint">No parser is built yet, by design.</span>
              </div>
              <div className="metric">
                <span className="metric__label">First event</span>
                <span className="metric__value" style={{ fontSize: 15 }}>
                  {summary.firstReceivedAt ? formatDateTime(summary.firstReceivedAt) : '—'}
                </span>
              </div>
            </div>

            {usingBodyHash && (
              <Notice tone="warn" title="Event IDs are being derived from a hash of the body">
                No recognised event-ID field was found in these payloads, so the body hash is used
                for deduplication instead. That collapses an identical redelivery, but if Interakt
                retries with a changed timestamp or nonce the retry will be stored as a new event.
                Once the real identifier field is visible below, it needs wiring into
                <code> EVENT_ID_PATHS</code> in <code>src/services/webhooks.ts</code>.
              </Notice>
            )}

            <Card
              title="Raw captured events"
              description="Exactly as received. Credential-bearing header values are replaced with a descriptor — enough to identify the auth scheme without storing the secret."
              flush
            >
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Received</th>
                      <th>Event ID</th>
                      <th>ID source</th>
                      <th>Auth</th>
                      <th>Dupes</th>
                      <th>Payload / headers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.id}>
                        <td className="nowrap">{formatDateTime(event.receivedAt)}</td>
                        <td>
                          <code className="small truncate" title={event.externalEventId}>
                            {event.externalEventId}
                          </code>
                        </td>
                        <td>
                          {event.eventIdSource === 'body_sha256'
                            ? <Badge tone="warn">body hash</Badge>
                            : <code className="small">{event.eventIdSource}</code>}
                        </td>
                        <td>
                          {event.signatureStatus === 'valid'
                            ? <Badge tone="ok">verified</Badge>
                            : <Badge tone="neutral">{event.signatureStatus.replace(/_/g, ' ')}</Badge>}
                        </td>
                        <td className="num">{event.duplicateCount}</td>
                        <td>
                          <details>
                            <summary className="small muted">View</summary>
                            <pre
                              className="mono small"
                              style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', maxWidth: 640, maxHeight: 420, overflow: 'auto' }}
                            >
{JSON.stringify({ headers: event.headers, payload: event.payload }, null, 2)}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Notice tone="info" title="What to look for in these payloads">
              Three things decide what the system may claim about WhatsApp:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li>
                  <strong>A stable event ID</strong> — which field Interakt uses to identify an
                  event, so redelivery can be deduplicated properly.
                </li>
                <li>
                  <strong>A contact identifier</strong> — the phone number or contact ID that
                  distinguishes one person, so repeated messages do not inflate lead counts.
                </li>
                <li>
                  <strong>The campaign code</strong> — whether <code>[BI-…]</code> from the
                  prefilled message survives into the inbound event. If it does, WhatsApp
                  attribution is campaign-level. If it does not, it is unknown, and per-click
                  matching must not be promised to anyone.
                </li>
              </ul>
            </Notice>
          </>
        )}
      </div>
    </>
  );
}
