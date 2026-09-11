/**
 * Role-based access control.
 *
 * The five roles are fixed by PRD §3. That table describes each role in one
 * phrase, so the permission list below is an interpretation of it — the
 * mapping is written out explicitly rather than scattered through route
 * handlers, so it can be reviewed against the PRD in one place and changed in
 * one place.
 *
 * Two decisions here go beyond what PRD §3 states and need business sign-off.
 * Both are marked NEEDS SIGN-OFF and are listed in README.md.
 */

export type AdminRole =
  | 'super_admin'
  | 'campaign_manager'
  | 'media_buyer'
  | 'analyst'
  | 'integration_developer';

export const ADMIN_ROLES: readonly AdminRole[] = [
  'super_admin',
  'campaign_manager',
  'media_buyer',
  'analyst',
  'integration_developer',
] as const;

export const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: 'Super Admin',
  campaign_manager: 'Campaign Manager',
  media_buyer: 'Media Buyer',
  analyst: 'Analyst',
  integration_developer: 'Integration Developer',
};

/** PRD §3, quoted, so the mapping below can be checked against its source. */
export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  super_admin: 'Full access, settings, integrations and user management',
  campaign_manager: 'Campaigns, links and approved destinations',
  media_buyer: 'Performance, costs and reports',
  analyst: 'Read-only analytics and exports',
  integration_developer: 'Authorized technical configuration',
};

export type Permission =
  | 'publishers:read' | 'publishers:write'
  | 'campaigns:read' | 'campaigns:write'
  | 'creatives:read' | 'creatives:write'
  | 'destinations:read' | 'destinations:write' | 'destinations:approve'
  | 'links:read' | 'links:write'
  | 'leads:read' | 'registrations:read' | 'ftd:read'
  | 'reports:read' | 'reports:export'
  | 'costs:read' | 'costs:write'
  | 'integrations:read' | 'integrations:write'
  | 'audit:read'
  | 'users:read' | 'users:write'
  | 'settings:read' | 'settings:write'
  /** Reveal an unmasked phone number. UI/UX §8, §9 mask by default. */
  | 'pii:reveal';

const READ_ONLY_ANALYTICS: Permission[] = [
  'publishers:read', 'campaigns:read', 'creatives:read', 'destinations:read',
  'links:read', 'leads:read', 'registrations:read', 'ftd:read',
  'reports:read', 'reports:export', 'costs:read',
];

const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  /** "Full access, settings, integrations and user management." */
  super_admin: [
    'publishers:read', 'publishers:write',
    'campaigns:read', 'campaigns:write',
    'creatives:read', 'creatives:write',
    'destinations:read', 'destinations:write', 'destinations:approve',
    'links:read', 'links:write',
    'leads:read', 'registrations:read', 'ftd:read',
    'reports:read', 'reports:export',
    'costs:read', 'costs:write',
    'integrations:read', 'integrations:write',
    'audit:read',
    'users:read', 'users:write',
    'settings:read', 'settings:write',
    'pii:reveal',
  ],

  /**
   * "Campaigns, links and approved destinations."
   *
   * NEEDS SIGN-OFF: this role can propose a destination but not approve it.
   * PRD §3 is ambiguous, and granting approval here would let one person
   * create and approve their own destination. TRD §13 requires recorded
   * publisher approval evidence and UI/UX §6 requires activation to depend on
   * "authorized permission", both of which are weakened by self-approval.
   */
  campaign_manager: [
    'publishers:read',
    'campaigns:read', 'campaigns:write',
    'creatives:read', 'creatives:write',
    'destinations:read', 'destinations:write',
    'links:read', 'links:write',
    'leads:read', 'registrations:read', 'ftd:read',
    'reports:read', 'reports:export',
    'costs:read',
    'audit:read',
  ],

  /** "Performance, costs and reports." Costs are writable; campaigns are not. */
  media_buyer: [
    'publishers:read', 'campaigns:read', 'creatives:read',
    'destinations:read', 'links:read',
    'leads:read', 'registrations:read', 'ftd:read',
    'reports:read', 'reports:export',
    'costs:read', 'costs:write',
  ],

  /** "Read-only analytics and exports." No write permission of any kind. */
  analyst: READ_ONLY_ANALYTICS,

  /**
   * "Authorized technical configuration."
   *
   * NEEDS SIGN-OFF: read on operational entities plus integration settings.
   * Deliberately excludes campaign and cost writes — a technical role should
   * not be able to change commercial records.
   */
  integration_developer: [
    'publishers:read', 'campaigns:read', 'creatives:read',
    'destinations:read', 'links:read',
    'reports:read',
    'integrations:read', 'integrations:write',
    'settings:read',
    'audit:read',
  ],
};

export function permissionsFor(role: AdminRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function canAll(role: AdminRole, permissions: Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}
