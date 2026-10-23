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

    /*
     * Connection setup, not query time, is what costs on this deployment.
     *
     * Measured: the redirect's SELECT executes in 1.2 ms, while the redirect
     * itself takes 313-763 ms against a budget of p95 < 300 ms (TRD §15). The
     * database is in Singapore and the app is not, so a cold connection pays
     * TCP, TLS and Postgres startup — four or five round trips before a query
     * is even sent.
     *
     * A 30 second idle timeout meant any gap in traffic threw that work away
     * and the next visitor paid for it again. Holding connections open turns a
     * redirect into one round trip instead of five.
     */
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS ?? 600_000),
    // Stops an idle socket being silently dropped by something in the middle
    // and only being discovered on the next click.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__slPool = pool;
}

export const db = drizzle(pool, { schema });

export { schema };
