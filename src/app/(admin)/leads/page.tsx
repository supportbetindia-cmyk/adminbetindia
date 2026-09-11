import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { PermissionDenied } from '@/components/ui';
import { PendingIntegration } from '@/components/pending-integration';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Leads — Smart Link Manager' };

export default async function LeadsPage() {
  const actor = await requireActor('/leads');
  if (!can(actor.user.role, 'leads:read')) return <PermissionDenied needed="leads:read" />;

  return (
    <>
      <PageHeader
        title="Leads"
        description="WhatsApp leads from confirmed inbound messages."
        actions={<AccountMenu user={actor.user} />}
      />

      <PendingIntegration
        title="Leads"
        summary={
          <>
            Interakt webhook ingestion is not built. Until it is, this system records redirects to
            WhatsApp and nothing more — see the &ldquo;Redirects to WhatsApp&rdquo; metric on the
            Dashboard, which is a proxy and is labelled as one.
          </>
        }
        definition={
          <>
            A lead is a distinct contact with a <strong>genuine inbound message event</strong>. A
            redirect is not a lead. An attempted app open is not a lead. Repeated messages from the
            same contact do not create a second lead (PRD §6, §7; TRD §8).
          </>
        }
        ceiling={
          <>
            The click ID does not survive a WhatsApp redirect. The only carrier available is a
            campaign code inside the prefilled message, which the user can delete before sending.
            Whether that code even reaches the inbound webhook is untested — that one test decides
            whether WhatsApp attribution is exact, campaign-level or unknown, and every project
            document instructs that it be run rather than assumed.
          </>
        }
        blockers={[
          {
            what: 'Interakt account with webhook access and a test number',
            owner: 'BetIndia marketing',
            consequence: 'No WhatsApp lead measurement of any kind.',
          },
          {
            what: 'Interakt webhook payload samples and documented schema',
            owner: 'Integration developer, from Interakt',
            consequence: 'Contact identifiers, event types and deduplication rules cannot be implemented.',
          },
          {
            what: 'Result of the prefilled-message campaign-code test',
            owner: 'Integration developer',
            consequence: 'Attribution confidence for every WhatsApp lead is undefined.',
          },
          {
            what: 'Agreed definition of one unique lead',
            owner: 'Business',
            consequence: 'Repeat messages inflate lead counts and every downstream ratio is wrong.',
          },
        ]}
        columns={['Lead ID', 'Phone (masked)', 'Publisher', 'Campaign', 'First message', 'Status', 'Registration', 'Attribution confidence']}
      />
    </>
  );
}
