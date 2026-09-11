/**
 * Applies generated SQL migrations. Run at deploy time, never at request time.
 *
 * Uses its own short-lived connection rather than the application pool, and
 * prefers DIRECT_DATABASE_URL when one is set.
 *
 * That matters on Neon and any other PgBouncer-fronted Postgres: the pooled
 * endpoint runs in transaction mode, which does not support the session-level
 * advisory locks and multi-statement DDL a migration runner relies on. The app
 * should use the pooled endpoint at runtime; migrations must not.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * `DATABASE_URL_UNPOOLED` is the name Neon's CLI writes; `DIRECT_DATABASE_URL`
 * is the more common convention elsewhere. Either works.
 */
const pooled = process.env.DATABASE_URL;
const direct = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED;

if (!pooled) {
  throw new Error(
    'Set DATABASE_URL, plus DIRECT_DATABASE_URL or DATABASE_URL_UNPOOLED if your provider pools connections',
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace('-pooler.', '.');
  } catch {
    return null;
  }
}

/**
 * The direct URL is only used when it names the same server as DATABASE_URL.
 *
 * Without this check, a run scoped to one database by `--env-file` can pick up
 * a direct URL inherited from a different `.env` and migrate the wrong server
 * entirely — which is exactly how a test run reaches production. Refusing is
 * the only safe response: silently preferring either one would sometimes be
 * wrong, and the wrong choice is unrecoverable.
 */
if (direct && hostOf(direct) !== hostOf(pooled)) {
  throw new Error(
    'DATABASE_URL and the direct URL point at different servers:\n' +
    `  DATABASE_URL       -> ${hostOf(pooled)}\n` +
    `  direct URL         -> ${hostOf(direct)}\n` +
    'Refusing to guess which one you meant. Set both to the same server, or unset the direct one.',
  );
}

const connectionString = direct ?? pooled;

function describe(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

async function main() {
  const usingDirect = Boolean(direct);
  console.log(`migrating ${describe(connectionString!)}${usingDirect ? ' (direct endpoint)' : ''}`);

  if (!usingDirect && /-pooler\./.test(connectionString!)) {
    console.warn(
      'warning: this looks like a pooled endpoint. Migrations can fail or hang against a ' +
      'transaction-mode pooler — set DIRECT_DATABASE_URL to the unpooled connection string.',
    );
  }

  // A single connection: a migration is sequential and holds a lock.
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000 });

  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
