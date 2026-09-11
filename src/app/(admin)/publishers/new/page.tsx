import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, PermissionDenied } from '@/components/ui';
import { PublisherForm } from '@/components/publisher-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Add publisher — Smart Link Manager' };

export default async function NewPublisherPage() {
  const actor = await requireActor('/publishers/new');
  if (!can(actor.user.role, 'publishers:write')) return <PermissionDenied needed="publishers:write" />;

  return (
    <>
      <PageHeader
        title="Add publisher"
        description="Record what this publisher has approved. Anything not recorded is treated as not approved."
        actions={<AccountMenu user={actor.user} />}
      />
      <div className="content">
        <Card>
          <PublisherForm />
        </Card>
      </div>
    </>
  );
}
