/**
 * Database connection.
 *
 * A single shared pool per process. The redirect path does one indexed SELECT
 * and one INSERT, so pool saturation is the main latency risk under load —
 * size this against the host's connection limit before launch (TRD §15).
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Reuse the pool across hot reloads in development.
const globalForDb = globalThis as unknown as { __slPool?: Pool };

export const pool =
  globalForDb.__slPool ??
  new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__slPool = pool;
}

export const db = drizzle(pool, { schema });

export { schema };
