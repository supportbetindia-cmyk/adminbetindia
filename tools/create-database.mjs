/**
 * Creates the application database if it does not already exist.
 *
 * Connects to the `postgres` maintenance database to issue CREATE DATABASE,
 * because that statement cannot run inside a transaction or against the
 * database being created. Existing databases on the server are not touched.
 *
 * Usage: node tools/create-database.mjs "<connection-url-including-target-db>"
 *        node tools/create-database.mjs            # reads DATABASE_URL from .env
 */

import 'dotenv/config';
import pg from 'pg';

const url = process.argv[2] ?? process.env.DATABASE_URL;

if (!url) {
  console.error('No connection URL. Pass one as an argument or set DATABASE_URL.');
  process.exit(1);
}

const parsed = new URL(url);
const target = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

if (!target) {
  console.error('The connection URL has no database name in its path.');
  process.exit(1);
}

// Identifiers cannot be parameterised, so the name is restricted to characters
// that need no quoting rather than being interpolated blind.
if (!/^[a-z_][a-z0-9_]*$/i.test(target)) {
  console.error(`Refusing to create "${target}": use letters, digits and underscores only.`);
  process.exit(1);
}

const client = new pg.Client({
  host: parsed.hostname,
  port: Number(parsed.port || 5432),
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database: 'postgres',
  connectionTimeoutMillis: 5000,
});

await client.connect();

const existing = await client.query('select 1 from pg_database where datname = $1', [target]);

if (existing.rowCount > 0) {
  console.log(`Database "${target}" already exists — nothing to do.`);
} else {
  await client.query(`CREATE DATABASE "${target}"`);
  console.log(`Created database "${target}".`);
}

await client.end();
