import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit only generates SQL from the schema; it needs a connection for
 * introspection and `push`. Prefers the direct endpoint for the same reason
 * migrate.ts does — see the note there.
 */
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: (process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL)! },
} satisfies Config;
