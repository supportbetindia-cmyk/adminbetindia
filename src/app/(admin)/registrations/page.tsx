import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { PermissionDenied } from '@/components/ui';
import { PendingIntegration } from '@/components/pending-integration';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Registrations — Smart Link Manager' };

export default async function RegistrationsPage() {
  const actor = await requireActor('/registrations');
  if (!can(actor.user.role, 'registrations:read')) return <PermissionDenied needed="registrations:read" />;

  return (
    <>
      <PageHeader
        title="Registrations"
        description="Verified accounts from the betting platform."
        actions={<AccountMenu user={actor.user} />}
      />

      <PendingIntegration
        title="Registrations"
        summary={
          <>
            No authorized registration API or webhook is connected, and the website tracking SDK is
            not deployed. The funnel currently stops at the click.
          </>
        }
        definition={
          <>
            A registration requires an <strong>actual external user ID and a completed account</strong>.
            A form click, a CTA press or a started-but-abandoned signup is not a registration
            (PRD §6, TRD §9). Records must arrive from an authorized API, webhook or verified import —
            never inferred.
          </>
        }
        ceiling={
          <>
            A person who clicks on their phone and registers on a laptop breaks the chain, and there
            is no way to reconnect the two without a login identity spanning both devices. A share of
            genuine conversions will always land in the unknown bucket, and TRD §10 forbids
            distributing that bucket across campaigns to make a report look complete.
          </>
        }
        blockers={[
          {
            what: 'Registration API or webhook documentation',
            owner: 'Platform owner or white-label vendor',
            consequence: 'No registration counts and no click-to-registration rate.',
          },
          {
            what: 'Deploy access to the BetIndia website',
            owner: 'Website / web team',
            consequence: 'The click ID cannot be carried into the registration form, so the website funnel cannot be measured.',
          },
          {
            what: 'Authorized matching identifier',
            owner: 'Platform owner',
            consequence: 'Registrations cannot be joined to a click. A phone number alone is not proof of a click (Backend Schema §4).',
          },
          {
            what: 'Approved attribution model and lookback window',
            owner: 'Whoever pays the publishers',
            consequence: 'Reports cannot be finalised and publisher payouts will be disputed.',
          },
        ]}
        columns={['User ID', 'Phone (masked)', 'Registered at', 'Source', 'Campaign', 'Click ID', 'Attribution', 'FTD status']}
      />
    </>
  );
}
