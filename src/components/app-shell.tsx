/**
 * AppShell and Sidebar (UI/UX §3, §15).
 *
 * Navigation is role-aware: a link is only rendered when the signed-in role
 * holds the permission behind it. §3 requires the interface to respect
 * role-based permissions, and a menu item that always leads to a 403 is worse
 * than no menu item.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { can, ROLE_LABELS, type AdminRole, type Permission } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { LogoutButton } from './logout-button';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  permission: Permission;
  section: string;
}

/** Order and grouping follow the sidebar inventory in UI/UX §3. */
const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: '▤', permission: 'reports:read', section: 'Overview' },

  { href: '/publishers', label: 'Publishers', icon: '◈', permission: 'publishers:read', section: 'Campaigns' },
  { href: '/campaigns', label: 'Campaigns', icon: '◎', permission: 'campaigns:read', section: 'Campaigns' },
  { href: '/destinations', label: 'Destinations', icon: '⇥', permission: 'destinations:read', section: 'Campaigns' },
  { href: '/smart-links', label: 'Smart Links', icon: '⛓', permission: 'links:read', section: 'Campaigns' },

  { href: '/leads', label: 'Leads', icon: '☏', permission: 'leads:read', section: 'Conversions' },
  { href: '/registrations', label: 'Registrations', icon: '☑', permission: 'registrations:read', section: 'Conversions' },
  { href: '/ftd', label: 'FTD', icon: '₹', permission: 'ftd:read', section: 'Conversions' },

  { href: '/reports', label: 'Reports', icon: '⇩', permission: 'reports:read', section: 'Analysis' },
  { href: '/integrations', label: 'Integrations', icon: '⇄', permission: 'integrations:read', section: 'Analysis' },
  { href: '/audit-logs', label: 'Audit Logs', icon: '❐', permission: 'audit:read', section: 'Analysis' },
  { href: '/settings', label: 'Settings', icon: '⚙', permission: 'settings:read', section: 'Analysis' },
];

export function Sidebar({ role, pathname }: { role: AdminRole; pathname: string }) {
  const visible = NAV.filter((item) => can(role, item.permission));
  const sections = [...new Set(visible.map((i) => i.section))];

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar__brand">
        <div className="sidebar__brand-name">BetIndia</div>
        <div className="sidebar__brand-sub">Smart Link Manager</div>
      </div>

      <div className="sidebar__nav">
        {sections.map((section) => (
          <div key={section}>
            <div className="sidebar__section">{section}</div>
            {visible
              .filter((i) => i.section === section)
              .map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="sidebar__link"
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className="sidebar__link-icon" aria-hidden>{item.icon}</span>
                    {item.label}
                  </Link>
                );
              })}
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        Signed in as <strong>{ROLE_LABELS[role]}</strong>
      </div>
    </nav>
  );
}

export function PageHeader({
  title, description, actions,
}: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="topbar">
      <div>
        <h1 className="topbar__title">{title}</h1>
        {description && <p className="topbar__desc">{description}</p>}
      </div>
      {actions && <div className="topbar__actions">{actions}</div>}
    </header>
  );
}

export function AccountMenu({ user }: { user: SessionUser }) {
  return (
    <div className="account">
      <div>
        <div className="account__name">{user.name ?? user.email}</div>
        <div className="account__role">{ROLE_LABELS[user.role]}</div>
      </div>
      <LogoutButton />
    </div>
  );
}

export function AppShell({
  user, pathname, children,
}: { user: SessionUser; pathname: string; children: ReactNode }) {
  return (
    <div className="shell">
      <Sidebar role={user.role} pathname={pathname} />
      <div className="main">{children}</div>
    </div>
  );
}
