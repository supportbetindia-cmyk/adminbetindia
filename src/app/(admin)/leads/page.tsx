import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can } from '@/lib/auth/rbac';
import { formatDateTime } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Card, EmptyState, PermissionDenied } from '@/components/ui';
import { listInteraktLeads, processPendingVerifiedInterakt } from '@/services/interakt-leads';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Leads — Smart Link Manager' };

export default async function LeadsPage() {
  const actor = await requireActor('/leads');
  if (!can(actor.user.role, 'leads:read')) return <PermissionDenied needed="leads:read" />;

  // Also imports signature-valid events captured just before this feature was deployed.
  await processPendingVerifiedInterakt(db);
  const revealPhone = can(actor.user.role, 'pii:reveal');
  const rows = await listInteraktLeads(db, revealPhone);

  return (
    <>
      <PageHeader
        title="Leads"
        description="Customers who sent a confirmed inbound WhatsApp message."
        actions={<AccountMenu user={actor.user} />}
      />
      <div className="content">
        <Card
          title={`WhatsApp contacts (${rows.length})`}
          description={`${revealPhone ? 'Full phone numbers are visible to Super Admins.' : 'Phone numbers are masked for your role.'} A source link is shown only when its prefilled message uniquely identifies it.`}
          flush
        >
          {rows.length === 0 ? (
            <EmptyState title="No confirmed leads yet" body="Valid Interakt customer messages will appear here automatically." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Customer</th><th>Phone</th><th>Source link</th><th>Responses</th><th>Messages</th><th>First message</th><th>Last message</th><th>Attribution</th></tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.contactKey}>
                      <td>{row.customerName}</td>
                      <td><code>{row.phone}</code></td>
                      <td>{row.sourceLink ? <code>/c/{row.sourceLink}</code> : <span className="subtle">{row.sourceNote}</span>}</td>
                      <td>{row.messages.join(' · ')}</td>
                      <td>{row.messageCount}</td>
                      <td>{formatDateTime(row.firstMessageAt)}</td>
                      <td>{formatDateTime(row.lastMessageAt)}</td>
                      <td><span className="subtle">{row.sourceLink ? 'Message-level match' : 'Unknown'}</span></td>
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
