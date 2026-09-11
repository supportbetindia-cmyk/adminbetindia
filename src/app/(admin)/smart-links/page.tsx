import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { listSmartLinks } from '@/services/smart-links';
import { formatDate, formatMetric } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, EmptyState, PageHint, PermissionDenied, StatusBadge } from '@/components/ui';
import { CopyButton } from '@/components/form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Smart Links — Smart Link Manager' };

export default async function SmartLinksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const actor = await requireActor('/smart-links');
  if (!can(actor.user.role, 'links:read')) return <PermissionDenied needed="links:read" />;

  const { status } = await searchParams;
  const links = await listSmartLinks(db, actor, {
    status: status as 'draft' | 'active' | 'paused' | 'ended' | undefined,
  });
  const mayWrite = can(actor.user.role, 'links:write');

  return (
    <>
      <PageHeader
        title="Smart Links"
        description="One link, one approved destination, no fallback routing."
        actions={
          <>
            {mayWrite && <Link href="/smart-links/new" className="btn btn--primary">New link</Link>}
            <AccountMenu user={actor.user} />
          </>
        }
      />

      <div className="content">
        <div className="row">
          {['', 'draft', 'active', 'paused', 'ended'].map((s) => (
            <Link
              key={s || 'all'}
              href={s ? `/smart-links?status=${s}` : '/smart-links'}
              className={`btn btn--sm${(status ?? '') === s ? ' btn--primary' : ''}`}
            >
              {s ? s[0].toUpperCase() + s.slice(1) : 'All'}
            </Link>
          ))}
        </div>

        <PageHint>
          Links are never deleted. Ending one stops traffic while keeping its click history intact,
          because deleting it would destroy historical attribution (UI/UX §7).
        </PageHint>

        <Card flush>
          {links.length === 0 ? (
            <EmptyState
              icon="⛓"
              title={status ? `No ${status} links` : 'No smart links yet'}
              body="Create a link against a campaign and an approved destination."
              action={mayWrite ? <Link href="/smart-links/new" className="btn btn--primary">New link</Link> : undefined}
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Short URL</th>
                    <th>Publisher</th>
                    <th>Campaign</th>
                    <th>Creative</th>
                    <th>Destination</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th className="num">Clicks</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link href={`/smart-links/${l.id}`}><code>/c/{l.slug}</code></Link>
                        <span className="cell-sub">
                          <CopyButton value={l.shortUrl} label="Copy URL" />
                        </span>
                      </td>
                      <td><Link href={`/publishers/${l.publisherId}`}>{l.publisherName}</Link></td>
                      <td><Link href={`/campaigns/${l.campaignId}`}>{l.campaignName}</Link></td>
                      <td>{l.creativeName ?? <span className="subtle">—</span>}</td>
                      <td>
                        {l.destinationType}
                        <span className="cell-sub"><StatusBadge status={l.destinationApproval} /></span>
                      </td>
                      <td>v{l.activeDestinationVersion}</td>
                      <td><StatusBadge status={l.status} /></td>
                      <td className="num">{formatMetric(l.clickCount)}</td>
                      <td className="nowrap">{formatDate(l.createdAt)}</td>
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
