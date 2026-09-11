import Link from 'next/link';
import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { listPublishers, publisherPermits } from '@/services/publishers';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, EmptyState, Notice, PermissionDenied } from '@/components/ui';
import { CampaignForm } from '@/components/campaign-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New campaign — Smart Link Manager' };

export default async function NewCampaignPage() {
  const actor = await requireActor('/campaigns/new');
  if (!can(actor.user.role, 'campaigns:write')) return <PermissionDenied needed="campaigns:write" />;

  const publishers = await listPublishers(db, actor);

  // A campaign can be drafted against any publisher, but one that cannot run
  // either destination type is labelled so the problem is visible now rather
  // than at activation.
  const options = publishers.map((p) => {
    const blocked = !publisherPermits(p, 'website').permitted && !publisherPermits(p, 'whatsapp').permitted;
    return { value: p.id, label: blocked ? `${p.name} — no approved destination type` : p.name };
  });

  return (
    <>
      <PageHeader
        title="New campaign"
        description="Created as a draft. Activation is a separate, checked step."
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        {publishers.length === 0 ? (
          <Card>
            <EmptyState
              icon="◈"
              title="Add a publisher first"
              body="A campaign belongs to exactly one publisher, and the publisher's approvals decide what the campaign may do."
              action={<Link href="/publishers/new" className="btn btn--primary">Add publisher</Link>}
            />
          </Card>
        ) : (
          <>
            <Notice tone="info" title="Activation preconditions">
              A campaign can only go active once its publisher is marked eligible, has approved the
              tracking URL, has approved the destination type in use, and at least one of its links
              points at an approved destination (PRD §4, TRD §13, UI/UX §6).
            </Notice>

            <Card>
              <CampaignForm publishers={options} />
            </Card>
          </>
        )}
      </div>
    </>
  );
}
