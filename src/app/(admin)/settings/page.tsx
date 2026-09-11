/**
 * Settings (UI/UX §12).
 *
 * User roles, the destination allowlist, the attribution window, integration
 * health, retention and timezone. Secrets and raw webhook credentials never
 * appear — §12 forbids it, and nothing on this page reads an environment
 * variable that holds one.
 */

import { db } from '@/db';
import { requireActor } from '@/lib/auth/current';
import { can, permissionsFor, ROLE_DESCRIPTIONS, ROLE_LABELS, ADMIN_ROLES } from '@/lib/auth/rbac';
import { listUsers } from '@/services/users';
import { shortUrlBase } from '@/services/smart-links';
import { DISPLAY_TIMEZONE, formatDateTime } from '@/lib/format';
import { AccountMenu, PageHeader } from '@/components/app-shell';
import { Badge, Card, Notice, PermissionDenied, StatusBadge } from '@/components/ui';
import { CreateUserForm, EditUserForm } from '@/components/user-controls';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings — Smart Link Manager' };

/** Mirrors lib/destination-url.ts. Hosts only; no secret is read here. */
function allowlistedHosts(): string[] {
  const raw = process.env.DESTINATION_HOST_ALLOWLIST ?? '';
  const configured = raw.split(',').map((h) => h.trim()).filter(Boolean);
  return configured.length ? configured : ['betindia.bet', 'www.betindia.bet', 'wa.me', 'api.whatsapp.com'];
}

const INTEGRATIONS = [
  { name: 'Redirect engine', status: 'live', detail: 'GET /c/{slug} records a click before redirecting.' },
  { name: 'Website tracking SDK', status: 'not_built', detail: 'Feature 4. Blocked on deploy access to the BetIndia website.' },
  { name: 'Interakt (WhatsApp)', status: 'not_built', detail: 'Feature 5. Blocked on account access and payload samples.' },
  { name: 'Registration ingestion', status: 'not_built', detail: 'Feature 6. Blocked on the platform registration API.' },
  { name: 'Transaction / FTD ingestion', status: 'not_built', detail: 'Feature 6. Blocked on the transaction API and the FTD definition.' },
  { name: 'Publisher report import', status: 'not_built', detail: 'Feature 7. Blocked on publisher reporting access.' },
] as const;

export default async function SettingsPage() {
  const actor = await requireActor('/settings');
  if (!can(actor.user.role, 'settings:read')) return <PermissionDenied needed="settings:read" />;

  const mayManageUsers = can(actor.user.role, 'users:read');
  const users = mayManageUsers ? await listUsers(db, actor) : [];
  const mayWriteUsers = can(actor.user.role, 'users:write');

  return (
    <>
      <PageHeader
        title="Settings"
        description="Roles, allowlists, attribution policy and integration status."
        actions={<AccountMenu user={actor.user} />}
      />

      <div className="content">
        {!actor.user.mfaEnrolled && (
          <Notice tone="warn" title="MFA is not enrolled">
            TRD §14 requires multi-factor authentication for privileged users. Enrolment is not built
            in this feature, and this warning stays until it is. Sessions are server-side and
            revocable, and sign-in is rate limited, but neither replaces MFA.
          </Notice>
        )}

        <Card title="Attribution policy" description="What the system is currently permitted to claim.">
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr>
                  <th style={{ width: 260 }}>Model</th>
                  <td>
                    First eligible acquisition click, proposed in TRD §10{' '}
                    <Badge tone="warn">Not approved</Badge>
                    <span className="cell-sub">
                      &ldquo;subject to business approval&rdquo;. Until approved, no conversion is attributed.
                    </span>
                  </td>
                </tr>
                <tr>
                  <th>Lookback window</th>
                  <td>
                    30 days by default, configurable per campaign
                    <span className="cell-sub">
                      Safari deletes script-set first-party cookies after seven days, and publisher
                      in-app browsers often do not share storage with the real browser. Expect a
                      meaningful share of iOS and in-app traffic to fall out of the window.
                    </span>
                  </td>
                </tr>
                <tr>
                  <th>Unmatched conversions</th>
                  <td>
                    Stay in an unknown bucket
                    <span className="cell-sub">TRD §10 forbids distributing them across campaigns.</span>
                  </td>
                </tr>
                <tr>
                  <th>WhatsApp attribution</th>
                  <td>
                    Campaign-level at best <Badge tone="warn">Untested</Badge>
                    <span className="cell-sub">
                      The click ID does not survive a WhatsApp redirect. Per-click matching must not
                      be promised to anyone.
                    </span>
                  </td>
                </tr>
                <tr>
                  <th>Display timezone</th>
                  <td>{DISPLAY_TIMEZONE}<span className="cell-sub">Storage is UTC everywhere.</span></td>
                </tr>
                <tr>
                  <th>Smart link base URL</th>
                  <td><code>{shortUrlBase()}</code></td>
                </tr>
                <tr>
                  <th>Data retention</th>
                  <td>
                    <Badge tone="danger">Not defined</Badge>
                    <span className="cell-sub">
                      PRD §13 and TRD §14 require a retention and deletion schedule plus an Indian
                      legal review before production. Neither exists yet.
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Destination host allowlist"
          description="A destination URL must be https and on one of these hosts. Checked when a destination is registered, again when it is approved, and again on every redirect."
        >
          <div className="row">
            {allowlistedHosts().map((host) => <Badge key={host} tone="info">{host}</Badge>)}
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>
            Configured with <code>DESTINATION_HOST_ALLOWLIST</code>. Changing it does not alter any
            historical click — each one pins the destination version it used.
          </p>
        </Card>

        <Card title="Integration status" flush>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Integration</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>
                {INTEGRATIONS.map((i) => (
                  <tr key={i.name}>
                    <td>{i.name}</td>
                    <td>
                      {i.status === 'live'
                        ? <Badge tone="ok">Live</Badge>
                        : <Badge tone="neutral">Not built</Badge>}
                    </td>
                    <td className="muted">{i.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Roles and permissions"
          description="The five roles from PRD §3. Two mappings need business sign-off; they are marked in lib/auth/rbac.ts."
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Role</th><th>PRD §3 description</th><th>Permissions</th></tr></thead>
              <tbody>
                {ADMIN_ROLES.map((role) => (
                  <tr key={role}>
                    <td><strong>{ROLE_LABELS[role]}</strong></td>
                    <td className="muted">{ROLE_DESCRIPTIONS[role]}</td>
                    <td>
                      <span className="small mono">{permissionsFor(role).join(', ')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {mayManageUsers && (
          <Card title="Admin users" flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>MFA</th><th>Last sign-in</th>{mayWriteUsers && <th>Change</th>}</tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.email}
                        {!u.hasPassword && <span className="cell-sub">No password set — cannot sign in</span>}
                      </td>
                      <td>{u.name ?? <span className="subtle">—</span>}</td>
                      <td>{ROLE_LABELS[u.role]}</td>
                      <td><StatusBadge status={u.status} /></td>
                      <td>{u.mfaEnrolled ? <Badge tone="ok">Enrolled</Badge> : <Badge tone="warn">Not enrolled</Badge>}</td>
                      <td className="nowrap">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : <span className="subtle">Never</span>}</td>
                      {mayWriteUsers && (
                        <td><EditUserForm user={{ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status }} /></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {mayWriteUsers && (
          <Card title="Add an admin user"><CreateUserForm /></Card>
        )}
      </div>
    </>
  );
}
