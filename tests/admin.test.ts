/**
 * Acceptance tests for the admin API, RBAC and audit trail (Feature 2).
 *
 * These map onto Backend Database Schema §9, TRD §6, §14 and §16, and run
 * against a real PostgreSQL database rather than mocks — the constraints being
 * tested (uniqueness, foreign keys, enum domains, upsert conflict targets)
 * only exist in the database.
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../src/db';
import {
  adminUsers, auditLogs, campaignCosts, campaigns, clickEvents, destinations,
  destinationVersions, publishers, smartLinks,
} from '../src/db/schema';
import type { ActorContext } from '../src/lib/auth/context';
import type { AdminRole } from '../src/lib/auth/rbac';
import { can, permissionsFor } from '../src/lib/auth/rbac';
import { ServiceError } from '../src/lib/errors';
import { diff, redact } from '../src/lib/audit';
import { hashPassword, verifyPassword } from '../src/lib/auth/password';
import { createSession, resolveSession, revokeSession, revokeAllSessionsForUser } from '../src/lib/auth/session';
import { login } from '../src/services/auth';
import { resetRateLimits } from '../src/lib/rate-limit';
import { createPublisher, publisherPermits, updatePublisher } from '../src/services/publishers';
import { createCampaign, updateCampaign } from '../src/services/campaigns';
import {
  approveDestination, createDestination, revokeDestination,
} from '../src/services/destinations';
import {
  changeSmartLinkDestination, createSmartLink, updateSmartLink,
} from '../src/services/smart-links';
import { createUser, updateUser } from '../src/services/users';
import { recordCampaignCost } from '../src/services/costs';
import { overviewReport, publisherPerformance } from '../src/services/reports';
import { resolveAndRecordClick } from '../src/services/redirect';
import { deriveClientSignals } from '../src/lib/client-signals';

const uniq = () => Math.random().toString(36).slice(2, 10);

const HUMAN = deriveClientSignals({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  purposeHeaders: [],
  method: 'GET',
});

function clickRequest(slug: string) {
  return {
    slug,
    signals: HUMAN,
    referrer: null,
    ipHash: null,
    visitorTokenHash: null,
    publisherClickId: null,
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
  };
}

/** Creates a real admin_users row and the ActorContext services expect. */
async function actorWithRole(role: AdminRole): Promise<ActorContext> {
  const [user] = await db
    .insert(adminUsers)
    .values({ email: `t-${role}-${uniq()}@example.test`, name: `Test ${role}`, role })
    .returning();

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as AdminRole,
      status: user.status,
      mfaEnrolled: user.mfaEnrolled,
    },
    ipHash: null,
  };
}

/** A publisher whose approvals are fully recorded, so campaigns can activate. */
async function approvedPublisher(actor: ActorContext, overrides: Record<string, unknown> = {}) {
  return createPublisher(db, actor, {
    name: `Test Publisher ${uniq()}`,
    permittedDestinationTypes: ['website', 'whatsapp'],
    trackingMacros: ['pcid'],
    trackingUrlApproved: true,
    eligibility: 'eligible',
    approvalEvidence: 'TEST-EVIDENCE',
    ...overrides,
  });
}

async function approvedDestination(actor: ActorContext, url?: string) {
  const destination = await createDestination(db, actor, {
    label: 'Test destination',
    type: 'website',
    url: url ?? `https://www.betindia.bet/promo/${uniq()}`,
  });
  return approveDestination(db, actor, destination.id, { approvalReference: 'TEST-APPROVAL' });
}

/** Asserts a ServiceError with the expected code, and returns it. */
async function rejects(fn: () => Promise<unknown>, code: string): Promise<ServiceError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ServiceError, `expected ServiceError, got ${String(err)}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  throw new assert.AssertionError({ message: `expected the call to reject with ${code}` });
}

// ─── RBAC (PRD §3, TRD §6) ───────────────────────────────────

test('the analyst role holds no write permission of any kind', () => {
  const writes = permissionsFor('analyst').filter(
    (p) => p.endsWith(':write') || p.endsWith(':approve') || p === 'pii:reveal',
  );
  assert.deepEqual(writes, [], 'PRD §3 defines Analyst as read-only analytics and exports');
});

test('only the super admin may approve a destination', () => {
  const approvers = (['super_admin', 'campaign_manager', 'media_buyer', 'analyst', 'integration_developer'] as const)
    .filter((role) => can(role, 'destinations:approve'));
  assert.deepEqual(approvers, ['super_admin']);
});

test('only the super admin may manage users or reveal a phone number', () => {
  for (const permission of ['users:write', 'pii:reveal'] as const) {
    const holders = (['super_admin', 'campaign_manager', 'media_buyer', 'analyst', 'integration_developer'] as const)
      .filter((role) => can(role, permission));
    assert.deepEqual(holders, ['super_admin'], `${permission} must be super_admin only`);
  }
});

test('a role without the permission is refused at the service, not just hidden in the UI', async () => {
  const analyst = await actorWithRole('analyst');
  const error = await rejects(() => createPublisher(db, analyst, { name: 'Should not exist' }), 'forbidden');
  assert.match(error.message, /analyst/);

  const rows = await db.select().from(publishers).where(eq(publishers.name, 'Should not exist'));
  assert.equal(rows.length, 0, 'nothing was written');
});

test('a campaign manager may register a destination but not approve one', async () => {
  const manager = await actorWithRole('campaign_manager');
  const destination = await createDestination(db, manager, {
    type: 'website',
    url: `https://www.betindia.bet/promo/${uniq()}`,
  });
  assert.equal(destination.approvalStatus, 'pending');

  await rejects(
    () => approveDestination(db, manager, destination.id, { approvalReference: 'X' }),
    'forbidden',
  );
});

// ─── Passwords and sessions (TRD §14) ────────────────────────

test('passwords verify against their own hash and nothing else', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(!hash.includes('correct'), 'the plaintext never appears in the encoded form');
  assert.ok(await verifyPassword('correct horse battery staple', hash));
  assert.equal(await verifyPassword('wrong horse battery staple', hash), false);
  assert.equal(await verifyPassword('anything', null), false, 'a null hash can never authenticate');
  assert.equal(await verifyPassword('anything', 'garbage'), false);
});

test('the same password hashes differently each time', async () => {
  const [a, b] = await Promise.all([hashPassword('the same password'), hashPassword('the same password')]);
  assert.notEqual(a, b, 'a per-password salt means identical passwords do not share a hash');
});

test('a revoked session stops resolving immediately', async () => {
  const actor = await actorWithRole('super_admin');
  const { token } = await createSession(db, actor.user.id);

  assert.equal((await resolveSession(db, token))?.id, actor.user.id);
  await revokeSession(db, token);
  assert.equal(await resolveSession(db, token), null);
});

test('an expired session does not resolve', async () => {
  const actor = await actorWithRole('analyst');
  const { token } = await createSession(db, actor.user.id);
  await db
    .update(adminUsers)
    .set({ status: 'active' })
    .where(eq(adminUsers.id, actor.user.id));

  // Move the expiry into the past, as the passage of time would.
  const { adminSessions } = await import('../src/db/schema');
  await db
    .update(adminSessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(adminSessions.userId, actor.user.id));

  assert.equal(await resolveSession(db, token), null);
});

test('suspending a user invalidates their live sessions', async () => {
  const superAdmin = await actorWithRole('super_admin');
  const victim = await createUser(db, superAdmin, {
    email: `t-suspend-${uniq()}@example.test`,
    role: 'analyst',
    password: 'a-long-enough-password',
  });

  const { token } = await createSession(db, victim.id);
  assert.ok(await resolveSession(db, token));

  await updateUser(db, superAdmin, victim.id, { status: 'suspended' });
  assert.equal(await resolveSession(db, token), null, 'the session must not outlive the suspension');
});

test('a role change signs the user out so the new role applies at once', async () => {
  const superAdmin = await actorWithRole('super_admin');
  const user = await createUser(db, superAdmin, {
    email: `t-role-${uniq()}@example.test`,
    role: 'analyst',
    password: 'a-long-enough-password',
  });

  const { token } = await createSession(db, user.id);
  await updateUser(db, superAdmin, user.id, { role: 'media_buyer' });
  assert.equal(await resolveSession(db, token), null);
});

test('sign-in reports a wrong password and an unknown account identically', async () => {
  resetRateLimits();
  const superAdmin = await actorWithRole('super_admin');
  const email = `t-login-${uniq()}@example.test`;
  await createUser(db, superAdmin, { email, role: 'analyst', password: 'a-long-enough-password' });

  const good = await login(db, { email, password: 'a-long-enough-password', ipHash: null, userAgent: null });
  assert.equal(good.status, 'ok');

  resetRateLimits();
  const wrongPassword = await login(db, { email, password: 'not-the-password', ipHash: null, userAgent: null });
  const noSuchUser = await login(db, {
    email: `missing-${uniq()}@example.test`, password: 'anything-at-all', ipHash: null, userAgent: null,
  });

  assert.equal(wrongPassword.status, 'invalid_credentials');
  assert.equal(noSuchUser.status, 'invalid_credentials');
});

test('repeated failed sign-ins are rate limited', async () => {
  resetRateLimits();
  const email = `t-brute-${uniq()}@example.test`;
  const attempt = () => login(db, { email, password: 'wrong', ipHash: null, userAgent: null });

  const results = [];
  for (let i = 0; i < 7; i += 1) results.push(await attempt());

  assert.ok(
    results.some((r) => r.status === 'rate_limited'),
    'TRD §14 requires rate limits on authentication',
  );
});

test('the last active super admin cannot be demoted or suspended', async () => {
  const superAdmin = await actorWithRole('super_admin');

  // Park every other super admin so the one under test is genuinely the last.
  await db
    .update(adminUsers)
    .set({ status: 'suspended' })
    .where(eq(adminUsers.role, 'super_admin'));
  await db
    .update(adminUsers)
    .set({ status: 'active' })
    .where(eq(adminUsers.id, superAdmin.user.id));

  const other = await actorWithRole('super_admin');
  await db.update(adminUsers).set({ status: 'suspended' }).where(eq(adminUsers.id, other.user.id));

  await rejects(
    () => updateUser(db, superAdmin, superAdmin.user.id, { status: 'suspended' }),
    'precondition_failed',
  );

  // Restore, so ordering between tests cannot strand the fixture.
  await db.update(adminUsers).set({ status: 'active' }).where(eq(adminUsers.role, 'super_admin'));
});

// ─── Destination registry and approval (TRD §5, §13) ─────────

test('a destination outside the host allowlist is refused before it is stored', async () => {
  const actor = await actorWithRole('super_admin');
  await rejects(
    () => createDestination(db, actor, { type: 'website', url: 'https://evil.example.com/steal' }),
    'precondition_failed',
  );
  await rejects(
    () => createDestination(db, actor, { type: 'website', url: 'http://www.betindia.bet/insecure' }),
    'precondition_failed',
  );

  const rows = await db.select().from(destinations).where(eq(destinations.url, 'https://evil.example.com/steal'));
  assert.equal(rows.length, 0);
});

test('a WhatsApp destination must be a WhatsApp link, and vice versa', async () => {
  const actor = await actorWithRole('super_admin');
  await rejects(
    () => createDestination(db, actor, { type: 'whatsapp', url: 'https://www.betindia.bet/promo/x' }),
    'validation_failed',
  );
  await rejects(
    () => createDestination(db, actor, { type: 'website', url: 'https://wa.me/919000000000' }),
    'validation_failed',
  );
});

test('approving a destination requires a recorded approval reference', async () => {
  const actor = await actorWithRole('super_admin');
  const destination = await createDestination(db, actor, {
    type: 'website',
    url: `https://www.betindia.bet/promo/${uniq()}`,
  });

  await rejects(() => approveDestination(db, actor, destination.id, {}), 'validation_failed');
  await rejects(
    () => approveDestination(db, actor, destination.id, { approvalReference: '' }),
    'validation_failed',
  );

  const approved = await approveDestination(db, actor, destination.id, { approvalReference: 'IO-2291' });
  assert.equal(approved.approvalStatus, 'approved');
  assert.equal(approved.approvalReference, 'IO-2291');
  assert.equal(approved.approvedBy, actor.user.id);
  assert.ok(approved.approvedAt instanceof Date);
});

test('a link cannot be created against an unapproved destination', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Test' });
  const pending = await createDestination(db, actor, {
    type: 'website',
    url: `https://www.betindia.bet/promo/${uniq()}`,
  });

  await rejects(
    () => createSmartLink(db, actor, {
      campaignId: campaign.id,
      slug: `t-${uniq()}`,
      destinationId: pending.id,
    }),
    'precondition_failed',
  );
});

// ─── Campaign and link activation (UI/UX §6, TRD §13) ────────

test('a campaign is created as a draft even if a status is supplied', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);

  const campaign = await createCampaign(db, actor, {
    publisherId: publisher.id,
    name: 'Should still be a draft',
    status: 'active',
  });

  assert.equal(campaign.status, 'draft', 'UI/UX §6: create in Draft by default');
});

test('a campaign with no approved link cannot be activated', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'No links yet' });

  const error = await rejects(
    () => updateCampaign(db, actor, campaign.id, { status: 'active' }),
    'precondition_failed',
  );
  assert.match(error.message, /approved destination/i);
});

test('a campaign on a publisher with no recorded approval cannot be activated', async () => {
  const actor = await actorWithRole('super_admin');
  // Default eligibility is `unconfirmed` and the tracking URL is unapproved.
  const publisher = await createPublisher(db, actor, { name: `Unapproved ${uniq()}` });
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Blocked' });
  const destination = await approvedDestination(actor);

  await createSmartLink(db, actor, {
    campaignId: campaign.id,
    slug: `t-${uniq()}`,
    destinationId: destination.id,
  });

  const error = await rejects(
    () => updateCampaign(db, actor, campaign.id, { status: 'active' }),
    'precondition_failed',
  );
  assert.match(error.message, /eligibility is unconfirmed|tracking URL/i);
});

test('publisherPermits treats an absent approval as "not approved", never as permitted', () => {
  const bare = {
    status: 'active',
    eligibility: 'unconfirmed' as const,
    permittedDestinationTypes: [] as string[],
    trackingUrlApproved: false,
  };
  assert.equal(publisherPermits(bare, 'website').permitted, false);
  assert.equal(publisherPermits({ ...bare, eligibility: 'eligible' }, 'website').permitted, false);
  assert.equal(
    publisherPermits({ ...bare, eligibility: 'eligible', trackingUrlApproved: true }, 'website').permitted,
    false,
    'an empty permitted-types list never means "all types"',
  );
  assert.equal(
    publisherPermits(
      { ...bare, eligibility: 'eligible', trackingUrlApproved: true, permittedDestinationTypes: ['website'] },
      'whatsapp',
    ).permitted,
    false,
  );
});

test('a link cannot be activated while its publisher has not approved the destination type', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor, { permittedDestinationTypes: ['whatsapp'] });
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Website not approved' });
  const destination = await approvedDestination(actor);

  const link = await createSmartLink(db, actor, {
    campaignId: campaign.id,
    slug: `t-${uniq()}`,
    destinationId: destination.id,
  });

  await rejects(() => updateSmartLink(db, actor, link.id, { status: 'active' }), 'precondition_failed');
});

test('an ended campaign and an ended link cannot be reopened', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'To be ended' });
  const destination = await approvedDestination(actor);
  const link = await createSmartLink(db, actor, {
    campaignId: campaign.id,
    slug: `t-${uniq()}`,
    destinationId: destination.id,
  });

  await updateSmartLink(db, actor, link.id, { status: 'ended' });
  await rejects(() => updateSmartLink(db, actor, link.id, { status: 'active' }), 'precondition_failed');

  await updateCampaign(db, actor, campaign.id, { status: 'ended' });
  await rejects(() => updateCampaign(db, actor, campaign.id, { status: 'active' }), 'precondition_failed');
});

test('a duplicate slug is refused', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Slug test' });
  const destination = await approvedDestination(actor);
  const slug = `t-dup-${uniq()}`;

  await createSmartLink(db, actor, { campaignId: campaign.id, slug, destinationId: destination.id });
  await rejects(
    () => createSmartLink(db, actor, { campaignId: campaign.id, slug, destinationId: destination.id }),
    'conflict',
  );
});

// ─── Destination versioning (Backend Schema §3, §9) ──────────

test('changing a destination appends a version and leaves historical clicks alone', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Version test' });
  const first = await approvedDestination(actor);
  const slug = `t-ver-${uniq()}`;

  const link = await createSmartLink(db, actor, {
    campaignId: campaign.id, slug, destinationId: first.id,
  });
  await updateCampaign(db, actor, campaign.id, { status: 'active' });
  await updateSmartLink(db, actor, link.id, { status: 'active' });

  const click = await resolveAndRecordClick(db, clickRequest(slug));
  assert.equal(click.status, 'redirect');
  if (click.status !== 'redirect') return;

  const second = await approvedDestination(actor);
  const changed = await changeSmartLinkDestination(db, actor, link.id, {
    destinationId: second.id,
    approvalReference: 'CHANGE-APPROVAL-1',
  });
  assert.equal(changed.version, 2);

  const versions = await db
    .select()
    .from(destinationVersions)
    .where(eq(destinationVersions.smartLinkId, link.id));
  assert.equal(versions.length, 2, 'the original version row is kept, not overwritten');

  const v1 = versions.find((v) => v.version === 1)!;
  const [recorded] = await db.select().from(clickEvents).where(eq(clickEvents.clickId, click.clickId));
  assert.equal(recorded.destinationVersionId, v1.id, 'the historical click still pins version 1');

  // A change must be traceable to a publisher approval.
  const [audit] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, link.id), eq(auditLogs.action, 'smart_link.destination_change')));
  assert.equal(audit.approvalReference, 'CHANGE-APPROVAL-1');
});

test('a destination change requires a publisher approval reference', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Change ref test' });
  const first = await approvedDestination(actor);
  const second = await approvedDestination(actor);

  const link = await createSmartLink(db, actor, {
    campaignId: campaign.id, slug: `t-${uniq()}`, destinationId: first.id,
  });

  await rejects(
    () => changeSmartLinkDestination(db, actor, link.id, { destinationId: second.id }),
    'validation_failed',
  );
});

test('withdrawing an approval stops the link redirecting straight away', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Revoke test' });
  const destination = await approvedDestination(actor);
  const slug = `t-rev-${uniq()}`;

  const link = await createSmartLink(db, actor, {
    campaignId: campaign.id, slug, destinationId: destination.id,
  });
  await updateCampaign(db, actor, campaign.id, { status: 'active' });
  await updateSmartLink(db, actor, link.id, { status: 'active' });

  assert.equal((await resolveAndRecordClick(db, clickRequest(slug))).status, 'redirect');

  await revokeDestination(db, actor, destination.id, { approvalNotes: 'Publisher withdrew approval' });

  const after = await resolveAndRecordClick(db, clickRequest(slug));
  assert.equal(after.status, 'no_approved_destination', 'traffic must stop, not continue');
});

test('there is no service function that deletes a smart link', async () => {
  const module = await import('../src/services/smart-links');
  const destructive = Object.keys(module).filter((key) => /delete|destroy|remove|purge/i.test(key));
  assert.deepEqual(destructive, [], 'UI/UX §7 forbids destroying historical attribution');
});

// ─── Audit trail (PRD §13, TRD §6, UI/UX §12) ────────────────

test('every mutation writes an audit row with actor, before and after', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await createPublisher(db, actor, { name: `Audit test ${uniq()}` });

  const [created] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, publisher.id), eq(auditLogs.action, 'publisher.create')));

  assert.ok(created, 'creating a publisher is audited');
  assert.equal(created.actorId, actor.user.id);
  assert.equal(created.actorEmail, actor.user.email);
  assert.equal(created.actorRole, 'super_admin');
  assert.ok(created.afterData, 'the new state is recorded');

  await updatePublisher(db, actor, publisher.id, { name: 'Renamed', eligibility: 'eligible' });

  const [updated] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, publisher.id), eq(auditLogs.action, 'publisher.update')));

  const before = updated.beforeData as Record<string, unknown>;
  const after = updated.afterData as Record<string, unknown>;
  assert.equal(before.name, publisher.name);
  assert.equal(after.name, 'Renamed');
  assert.equal(before.eligibility, 'unconfirmed');
  assert.equal(after.eligibility, 'eligible');
  assert.equal('status' in after, false, 'only changed fields are recorded');
});

test('an audit row survives its actor being renamed', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await createPublisher(db, actor, { name: `Denormalised ${uniq()}` });

  await db.update(adminUsers).set({ name: 'Someone Else' }).where(eq(adminUsers.id, actor.user.id));

  const [row] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, publisher.id), eq(auditLogs.action, 'publisher.create')));

  assert.equal(row.actorEmail, actor.user.email, 'the trail still says who acted');
});

test('secrets are redacted before anything is written to the audit table', () => {
  const cleaned = redact({
    email: 'someone@example.test',
    password: 'hunter2',
    apiKey: 'sk-live-123',
    nested: { webhookSecret: 'shh', authorization: 'Bearer abc', keep: 'visible' },
    list: [{ privateKey: 'no' }],
  }) as Record<string, unknown>;

  assert.equal(cleaned.email, 'someone@example.test');
  assert.equal(cleaned.password, '[redacted]');
  assert.equal(cleaned.apiKey, '[redacted]');

  const nested = cleaned.nested as Record<string, unknown>;
  assert.equal(nested.webhookSecret, '[redacted]');
  assert.equal(nested.authorization, '[redacted]');
  assert.equal(nested.keep, 'visible');
  assert.equal((cleaned.list as Record<string, unknown>[])[0].privateKey, '[redacted]');
});

test('creating a user never puts the password into the audit payload', async () => {
  const superAdmin = await actorWithRole('super_admin');
  const password = 'a-very-secret-password';
  const user = await createUser(db, superAdmin, {
    email: `t-audit-${uniq()}@example.test`,
    role: 'analyst',
    password,
  });

  const [row] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, user.id));
  assert.ok(!JSON.stringify(row).includes(password), 'the plaintext must not reach the audit table');
});

test('a mutation that changes nothing writes no audit row', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await createPublisher(db, actor, { name: `No-op ${uniq()}` });

  await updatePublisher(db, actor, publisher.id, { name: publisher.name });

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, publisher.id), eq(auditLogs.action, 'publisher.update')));
  assert.equal(rows.length, 0, 'an audit trail of non-changes is noise');
});

test('diff reports only the fields that actually changed', () => {
  const before = { a: 1, b: 'x', c: null, d: new Date('2026-01-01T00:00:00Z') };
  const result = diff(before as Record<string, unknown>, {
    a: 1,
    b: 'y',
    c: null,
    d: new Date('2026-01-01T00:00:00Z'),
  });

  assert.deepEqual(result.changedKeys, ['b']);
  assert.equal(result.before.b, 'x');
  assert.equal(result.after.b, 'y');
});

// ─── Costs (PRD §10, §16) ────────────────────────────────────

test('re-recording the same day and source corrects the figure rather than doubling it', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Cost test' });

  const input = {
    campaignId: campaign.id,
    costDate: '2026-09-01',
    currency: 'INR',
    source: 'publisher_invoice',
  };

  await recordCampaignCost(db, actor, { ...input, amount: 1000 });
  await recordCampaignCost(db, actor, { ...input, amount: 1250 });

  const rows = await db.select().from(campaignCosts).where(eq(campaignCosts.campaignId, campaign.id));
  assert.equal(rows.length, 1, 'a correction replaces the figure');
  assert.equal(Number(rows[0].amount), 1250);
});

test('spend in a different currency from the campaign is refused', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, {
    publisherId: publisher.id, name: 'Currency test', currency: 'INR',
  });

  await rejects(
    () => recordCampaignCost(db, actor, {
      campaignId: campaign.id,
      costDate: '2026-09-01',
      amount: 100,
      currency: 'USD',
      source: 'manual',
    }),
    'precondition_failed',
  );
});

// ─── Reporting honesty (PRD §5, UI/UX §4, TRD §10) ───────────

test('a metric with no connected source is null, not zero', async () => {
  const actor = await actorWithRole('super_admin');
  const report = await overviewReport(db, actor, { from: '2020-01-01', to: '2020-01-02' });

  for (const key of ['leads', 'registrations', 'ftd', 'whatsapp_opens']) {
    const metric = report.metrics.find((m) => m.key === key)!;
    assert.equal(metric.availability, 'unavailable', `${key} has no source yet`);
    assert.equal(metric.value, null, `${key} must be null so the UI renders N/A, never 0`);
    assert.ok(metric.source.length > 20, `${key} must state why it is unavailable`);
  }
});

test('measured clicks and the unique estimate are labelled differently', async () => {
  const actor = await actorWithRole('super_admin');
  const report = await overviewReport(db, actor, {});

  assert.equal(report.metrics.find((m) => m.key === 'clicks')!.availability, 'measured');

  const unique = report.metrics.find((m) => m.key === 'unique_visitors')!;
  assert.equal(unique.availability, 'estimated', 'PRD §5: a click is not a person');
  assert.match(unique.definition, /estimate/i);
});

test('a WhatsApp redirect is reported as a proxy, separately from opens', async () => {
  const actor = await actorWithRole('super_admin');
  const report = await overviewReport(db, actor, {});

  const redirects = report.metrics.find((m) => m.key === 'whatsapp_redirects')!;
  const opens = report.metrics.find((m) => m.key === 'whatsapp_opens')!;

  assert.equal(redirects.availability, 'measured');
  assert.match(redirects.definition, /proxy/i);
  assert.equal(opens.value, null, 'an open is not observable');
});

test('bot-flagged clicks are excluded from counts but never removed from the raw total', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Bot report test' });
  const destination = await approvedDestination(actor);
  const slug = `t-bot-${uniq()}`;

  const link = await createSmartLink(db, actor, {
    campaignId: campaign.id, slug, destinationId: destination.id,
  });
  await updateCampaign(db, actor, campaign.id, { status: 'active' });
  await updateSmartLink(db, actor, link.id, { status: 'active' });

  await resolveAndRecordClick(db, clickRequest(slug));
  await resolveAndRecordClick(db, {
    ...clickRequest(slug),
    signals: deriveClientSignals({ userAgent: 'WhatsApp/2.23.20.0 A', purposeHeaders: [], method: 'GET' }),
  });

  const report = await overviewReport(db, actor, { campaignId: campaign.id });
  assert.equal(report.clickBreakdown.raw, 2, 'both events are stored');
  assert.equal(report.clickBreakdown.filtered, 1);
  assert.equal(report.clickBreakdown.counted, 1, 'only the human click is counted');

  const withBots = await overviewReport(db, actor, { campaignId: campaign.id, includeFiltered: 'true' });
  assert.equal(withBots.clickBreakdown.counted, 2, 'filtering is a report choice, not a data change');
});

test('a publisher row never reports more unique visitors than clicks', async () => {
  const actor = await actorWithRole('super_admin');
  const publisher = await approvedPublisher(actor);
  const campaign = await createCampaign(db, actor, { publisherId: publisher.id, name: 'Unique vs clicks' });
  const destination = await approvedDestination(actor);
  const slug = `t-uniq-${uniq()}`;

  const link = await createSmartLink(db, actor, {
    campaignId: campaign.id, slug, destinationId: destination.id,
  });
  await updateCampaign(db, actor, campaign.id, { status: 'active' });
  await updateSmartLink(db, actor, link.id, { status: 'active' });

  // Two humans and two bots, each with a distinct visitor token — the shape
  // that previously made the unique estimate exceed the click count.
  const bot = deriveClientSignals({ userAgent: 'WhatsApp/2.23.20.0 A', purposeHeaders: [], method: 'GET' });
  for (const [signals, token] of [
    [HUMAN, 'tok-a'], [HUMAN, 'tok-b'], [bot, 'tok-c'], [bot, 'tok-d'],
  ] as const) {
    await resolveAndRecordClick(db, { ...clickRequest(slug), signals, visitorTokenHash: token });
  }

  const [excluded] = await publisherPerformance(db, actor, { publisherId: publisher.id });
  assert.equal(excluded.clicks, 2, 'two human clicks');
  assert.equal(excluded.filteredClicks, 2, 'two flagged clicks, still recorded');
  assert.equal(
    excluded.uniqueEstimate, 2,
    'the unique estimate must count the same rows as the click column beside it',
  );
  assert.ok(excluded.uniqueEstimate <= excluded.clicks);

  const [included] = await publisherPerformance(db, actor, {
    publisherId: publisher.id,
    includeFiltered: 'true',
  });
  assert.equal(included.clicks, 4);
  assert.equal(included.uniqueEstimate, 4, 'both columns move together when bots are included');
});

test('reporting is available to every role that can read reports, and refused otherwise', async () => {
  const analyst = await actorWithRole('analyst');
  const report = await overviewReport(db, analyst, {});
  assert.ok(report.metrics.length > 0, 'an analyst may read reports');

  const developer = await actorWithRole('integration_developer');
  await rejects(() => createCampaign(db, developer, { publisherId: analyst.user.id, name: 'x' }), 'forbidden');
});

test.after(async () => {
  await pool.end();
});
