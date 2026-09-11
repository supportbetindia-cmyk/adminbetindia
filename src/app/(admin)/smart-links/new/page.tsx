import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { listSelectableCampaigns } from '@/services/campaigns';
import { listApprovedDestinations } from '@/services/destinations';
import { listCreativesForCampaign } from '@/services/creatives';
import { shortUrlBase } from '@/services/smart-links';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, EmptyState, PermissionDenied } from '@/components/ui';
import { SmartLinkForm } from '@/components/smart-link-controls';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New smart link — Smart Link Manager' };

export default async function NewSmartLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ campaignId?: string }>;
}) {
  const actor = await requireActor('/smart-links/new');
  if (!can(actor.user.role, 'links:write')) return <PermissionDenied needed="links:write" />;

  const { campaignId } = await searchParams;
  const [campaigns, destinations] = await Promise.all([
    listSelectableCampaigns(db, actor),
    listApprovedDestinations(db, actor),
  ]);

  const creatives = campaignId ? await listCreativesForCampaign(db, actor, campaignId) : [];

  if (campaigns.length === 0 || destinations.length === 0) {
    return (
      <>
        <PageHeader title="New smart link" actions={<AccountMenu user={actor.user} />} />
        <div className="content">
          <Card>
            <EmptyState
              icon="⛓"
              title={campaigns.length === 0 ? 'Create a campaign first' : 'No approved destination available'}
              body={
                campaigns.length === 0
                  ? 'A link belongs to exactly one campaign.'
                  : 'A link may only point at an approved destination. Register one and have it approved.'
              }
              action={
                <Link
                  href={campaigns.length === 0 ? '/campaigns/new' : '/destinations'}
                  className="btn btn--primary"
                >
                  {campaigns.length === 0 ? 'New campaign' : 'Go to destinations'}
                </Link>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New smart link"
        description="Select a campaign, pick an approved destination, choose a slug, preview, save."
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        <Card>
          <SmartLinkForm
            baseUrl={shortUrlBase()}
            defaultCampaignId={campaignId}
            campaigns={campaigns.map((c) => ({ value: c.id, label: `${c.publisherName} — ${c.name}` }))}
            destinations={destinations.map((d) => ({
              value: d.id,
              label: `${d.label ?? d.url} (${d.type})`,
              url: d.url,
              type: d.type,
            }))}
            creatives={creatives.map((c) => ({ value: c.id, label: c.format ? `${c.name} (${c.format})` : c.name }))}
          />
        </Card>

        {campaignId === undefined && (
          <p className="small muted">
            Creative options load once a campaign is chosen — open this page from a campaign to pick
            one at creation time, or attach it afterwards.
          </p>
        )}
      </div>
    </>
  );
}
