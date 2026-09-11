/**
 * Creates the first Super Admin account, and nothing else.
 *
 * Deliberately separate from seed.ts. The seed creates a demo publisher,
 * campaign and two smart links — illustrative data that PRD §9 forbids
 * presenting as real, and which must never reach a production database. This
 * script creates one account so a real person can sign in, and touches nothing
 * else.
 *
 * Unlike the seed, it is therefore safe to run with NODE_ENV=production.
 *
 * Usage:
 *   npm run db:bootstrap-admin -- --email you@betindia.bet --name "Your Name"
 *
 * The password is read from stdin without echoing. For CI, set ADMIN_PASSWORD
 * in the environment instead — but prefer the prompt on a workstation, so the
 * password never reaches shell history or a file on disk.
 */

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from './index';
import { adminUsers } from './schema';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../lib/auth/password';
import { writeAudit } from '../lib/audit';
import { SYSTEM_ACTOR } from '../lib/auth/context';

interface Args {
  email?: string;
  name?: string;
  resetPassword: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { resetPassword: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') args.email = argv[++i];
    else if (arg === '--name') args.name = argv[++i];
    else if (arg === '--reset-password') args.resetPassword = true;
  }
  return args;
}

/** Reads a line from stdin with echo suppressed, so the password is not shown. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No interactive terminal. Set ADMIN_PASSWORD in the environment instead.'));
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = process.stdout;
    let muted = false;

    // Intercept the echo of typed characters while leaving the prompt visible.
    const write = output.write.bind(output);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (muted) return;
      write(s);
    };

    rl.question(question, (answer) => {
      muted = false;
      write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

/**
 * Rejects passwords that meet the length rule but would still be guessed
 * quickly. This account has every permission in the system.
 */
function assertPasswordUsable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const weak = [
    /^password/i, /^changeme/i, /^admin/i, /^welcome/i, /^betindia/i,
    /^letmein/i, /^qwerty/i, /^12345/,
  ];
  if (weak.some((re) => re.test(password))) {
    throw new Error('That password starts with a well-known pattern. Choose another.');
  }
  if (new Set(password).size < 6) {
    throw new Error('That password has too few distinct characters.');
  }
}

function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = (args.email ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();

  if (!email || !isEmail(email)) {
    throw new Error('Pass a valid address: --email you@betindia.bet (or set ADMIN_EMAIL)');
  }

  const target = new URL(process.env.DATABASE_URL!);
  console.log(`Database: ${target.hostname}${target.pathname}`);
  console.log(`Account : ${email}`);
  console.log();

  const [existing] = await db
    .select({ id: adminUsers.id, role: adminUsers.role, status: adminUsers.status })
    .from(adminUsers)
    .where(eq(sql`lower(${adminUsers.email})`, email))
    .limit(1);

  if (existing && !args.resetPassword) {
    console.log('That account already exists. Nothing changed.');
    console.log('To set a new password for it, re-run with --reset-password');
    await pool.end();
    return;
  }

  const password = process.env.ADMIN_PASSWORD ?? (await promptHidden('Password (min 12 chars): '));
  assertPasswordUsable(password);

  if (!process.env.ADMIN_PASSWORD) {
    const confirm = await promptHidden('Confirm password: ');
    if (confirm !== password) throw new Error('Passwords did not match.');
  }

  // Hash before touching the database, so a weak-password rejection never
  // leaves a half-created account behind.
  const passwordHash = await hashPassword(password);

  if (existing) {
    await db
      .update(adminUsers)
      .set({ passwordHash, status: 'active', ...(args.name ? { name: args.name } : {}) })
      .where(eq(adminUsers.id, existing.id));

    // Any session opened with the old password must not survive the reset.
    const { adminSessions } = await import('./schema');
    await db
      .update(adminSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(adminSessions.userId, existing.id)));

    await writeAudit(db, {
      actor: SYSTEM_ACTOR.user,
      action: 'user.password_reset',
      entityType: 'admin_user',
      entityId: existing.id,
      summary: `Password reset for ${email} via bootstrap script; existing sessions revoked`,
    });

    console.log(`\nPassword updated for ${email}. Existing sessions were signed out.`);
  } else {
    const [created] = await db
      .insert(adminUsers)
      .values({
        email,
        name: args.name ?? process.env.ADMIN_NAME ?? null,
        role: 'super_admin',
        status: 'active',
        passwordHash,
      })
      .returning({ id: adminUsers.id });

    await writeAudit(db, {
      actor: SYSTEM_ACTOR.user,
      action: 'user.create',
      entityType: 'admin_user',
      entityId: created.id,
      summary: `Bootstrapped Super Admin ${email}`,
      // The password is never assembled into an audit payload.
      after: { email, role: 'super_admin', status: 'active' },
    });

    console.log(`\nCreated Super Admin ${email}.`);
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, 'super_admin'), eq(adminUsers.status, 'active')));
  console.log(`Active Super Admins: ${count}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(`\nbootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
