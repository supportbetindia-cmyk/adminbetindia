import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { PermissionDenied } from '@/components/ui';
import { PendingIntegration } from '@/components/pending-integration';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'FTD — Smart Link Manager' };

export default async function FtdPage() {
  const actor = await requireActor('/ftd');
  if (!can(actor.user.role, 'ftd:read')) return <PermissionDenied needed="ftd:read" />;

  return (
    <>
      <PageHeader
        title="First-time deposits"
        description="Verified first genuine completed deposits."
        actions={<AccountMenu user={actor.user} />}
      />

      <PendingIntegration
        title="FTD events"
        summary={
          <>
            No authorized transaction API is connected and the genuine-first-deposit definition is not
            confirmed. Cost per FTD — the figure this whole system exists to produce — cannot be
            calculated until both exist.
          </>
        }
        definition={
          <>
            An FTD is the <strong>first genuine completed deposit</strong> for a verified user.
            Pending, failed, reversed and promotional credits are excluded. It is never inferred from
            a CTA click or an unverified payment event, and a duplicate delivery of the same
            transaction never counts twice (PRD §8, TRD §9, Backend Schema §9).
          </>
        }
        ceiling={
          <>
            Deposits are not automatically revenue or profit. ROAS and ROI stay unavailable until
            revenue, cost and accounting definitions are approved (PRD §10, TRD §11) — this screen
            will show deposit counts and amounts, not profit.
          </>
        }
        blockers={[
          {
            what: 'Transaction / deposit API',
            owner: 'Platform owner or white-label vendor',
            consequence: 'No FTD data at all, so cost per FTD cannot be calculated.',
          },
          {
            what: 'Written definition of a genuine first deposit',
            owner: 'Finance, with the platform',
            consequence: 'FTD figures cannot be agreed or audited.',
          },
          {
            what: 'Rules for reversals, refunds and corrections',
            owner: 'Finance',
            consequence: 'Late corrections silently inflate historical FTD counts.',
          },
          {
            what: 'Confirmed campaign cost import process',
            owner: 'Partnerships and Finance',
            consequence: 'Spend is missing, so every cost-per-result figure reads N/A.',
          },
        ]}
        columns={['Transaction ID', 'User ID', 'Completed at', 'Amount', 'Currency', 'Status', 'Original attribution']}
      />
    </>
  );
}
