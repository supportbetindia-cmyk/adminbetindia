/**
 * The screen shown for a funnel stage whose source integration does not exist
 * yet (Leads, Registrations, FTD).
 *
 * These pages deliberately show nothing rather than sample rows. UI/UX §4:
 * "All sample numbers in the mockup must be replaced by live or explicitly
 * labeled demo data", and §14: unknown or unavailable attribution must not be
 * displayed as confirmed. An empty table with a stated reason is the honest
 * rendering; a populated one would be a lie with a nice layout.
 */

import type { ReactNode } from 'react';
import { Card, EmptyState, Notice } from './ui';

export interface Blocker {
  what: string;
  owner: string;
  consequence: string;
}

export function PendingIntegration({
  title,
  summary,
  definition,
  blockers,
  columns,
  ceiling,
}: {
  title: string;
  summary: ReactNode;
  definition: ReactNode;
  blockers: Blocker[];
  columns: string[];
  ceiling?: ReactNode;
}) {
  return (
    <div className="content">
      <Notice tone="warn" title={`${title} are not being received yet`}>
        {summary}
      </Notice>

      <Card title="What this screen will count" description="Recorded now so the definition is agreed before any number appears.">
        <div className="stack">
          <div>{definition}</div>
          {ceiling && (
            <Notice tone="info" title="A permanent limit, not a missing feature">
              {ceiling}
            </Notice>
          )}
        </div>
      </Card>

      <Card title="What is needed before this screen has data" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>What is needed</th><th>Who provides it</th><th>What breaks without it</th></tr>
            </thead>
            <tbody>
              {blockers.map((b) => (
                <tr key={b.what}>
                  <td>{b.what}</td>
                  <td className="muted">{b.owner}</td>
                  <td className="muted">{b.consequence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={title} flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={columns.length} style={{ padding: 0 }}>
                  <EmptyState
                    icon="○"
                    title="No records — and no source connected"
                    body="This is not a count of zero. Nothing is being ingested, so nothing can be counted."
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
