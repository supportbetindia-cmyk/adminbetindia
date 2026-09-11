/**
 * Development seed.
 *
 * Creates one admin user per role, one publisher with its approvals recorded,
 * a campaign, a creative and two smart links — one website destination and one
 * WhatsApp destination — so the redirect engine and the admin UI can both be
 * exercised end to end.
 *
 * Publisher names here are placeholders for local testing only. Per PRD §9,
 * illustrative data must never be presented as actual campaign results.
 *
 * Idempotent: safe to run more than once against the same database.
 */

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, pool } from './index';
import {
  adminUsers, campaigns, creatives, destinations, destinationVersions, publishers, smartLinks,
} from './schema';
import { hashPassword } from '../lib/auth/password';
import type { AdminRole } from '../lib/auth/rbac';

/**
 * Seed passwords are for local development only. The seed refuses to run
 * against NODE_ENV=production, because a known password on a live admin
 * account is the whole security model gone.
 */
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe-Local-2026';

const SEED_USERS: { email: string; name: string; role: AdminRole }[] = [
  { email: 'admin@betindia.bet', name: 'Seed Super Admin', role: 'super_admin' },
  { email: 'campaigns@betindia.bet', name: 'Seed Campaign Manager', role: 'campaign_manager' },
  { email: 'media@betindia.bet', name: 'Seed Media Buyer', role: 'media_buyer' },
  { email: 'analyst@betindia.bet', name: 'Seed Analyst', role: 'analyst' },
  { email: 'integrations@betindia.bet', name: 'Seed Integration Developer', role: 'integration_developer' },
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const user of SEED_USERS) {
    await db
      .insert(adminUsers)
      .values({ email: user.email, name: user.name, role: user.role, passwordHash })
      .onConflictDoUpdate({
        target: adminUsers.email,
        set: { name: user.name, role: user.role, passwordHash },
      });
  }

  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, 'admin@betindia.bet'));
  const adminId = admin.id;

  // A publisher with its approvals recorded, so a campaign can actually be
  // activated. A publisher with nothing recorded would correctly refuse.
  const [publisher] = await db
    .insert(publishers)
    .values({
      name: 'Demo Publisher',
      status: 'active',
      externalReference: 'DEMO-001',
      contactName: 'Demo Contact',
      contactEmail: 'partners@example.test',
      permittedDestinationTypes: ['website', 'whatsapp'],
      trackingMacros: ['pcid'],
      trackingUrlApproved: true,
      scriptsAllowed: false,
      postbacksAllowed: false,
      eligibility: 'eligible',
      destinationChangePolicy: 'Placeholder for local testing. Not a real publisher agreement.',
      approvalEvidence: 'DEMO — local seed data, not a real approval.',
      createdBy: adminId,
    })
    .returning();

  const [campaign] = await db
    .insert(campaigns)
    .values({
      publisherId: publisher.id,
      name: 'Demo Campaign — Sept',
      status: 'active',
      placement: 'Home feed banner',
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 30 * 86_400_000),
      currency: 'INR',
      budgetAmount: '50000.00',
      attributionWindowDays: 30,
      approvalReference: 'DEMO-CAMPAIGN-APPROVAL',
      createdBy: adminId,
    })
    .returning();

  const [creative] = await db
    .insert(creatives)
    .values({
      campaignId: campaign.id,
      name: 'Banner 300x250 v1',
      format: '300x250',
      approvalStatus: 'approved',
      approvalReference: 'DEMO-CREATIVE-APPROVAL',
      createdBy: adminId,
    })
    .returning();

  // Approved destinations only — an unapproved row must never be redirected to.
  const [websiteDest] = await db
    .insert(destinations)
    .values({
      label: 'Welcome promo landing',
      type: 'website',
      url: 'https://www.betindia.bet/promo/welcome',
      approvalStatus: 'approved',
      approvalReference: 'DEMO-APPROVAL-1',
      approvedBy: adminId,
      approvedAt: new Date(),
      createdBy: adminId,
    })
    .returning();

  const [whatsappDest] = await db
    .insert(destinations)
    .values({
      label: 'Support WhatsApp line',
      type: 'whatsapp',
      url: 'https://wa.me/919000000000?text=Hi',
      approvalStatus: 'approved',
      approvalReference: 'DEMO-APPROVAL-2',
      approvedBy: adminId,
      approvedAt: new Date(),
      createdBy: adminId,
    })
    .returning();

  for (const [slug, dest] of [
    ['demo-web-sep01', websiteDest],
    ['demo-wa-sep01', whatsappDest],
  ] as const) {
    const [link] = await db
      .insert(smartLinks)
      .values({
        campaignId: campaign.id,
        creativeId: creative.id,
        slug,
        destinationType: dest.type,
        activeDestinationId: dest.id,
        activeDestinationVersion: 1,
        status: 'active',
        createdBy: adminId,
      })
      .returning();

    await db.insert(destinationVersions).values({
      smartLinkId: link.id,
      destinationId: dest.id,
      version: 1,
      changedBy: adminId,
      approvalReference: dest.approvalReference,
    });

    console.log(`seeded /c/${slug} -> ${dest.url}`);
  }

  console.log('\nSign in at http://localhost:3000/login');
  for (const user of SEED_USERS) console.log(`  ${user.email}  (${user.role})`);
  console.log(`  password: ${SEED_PASSWORD}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
