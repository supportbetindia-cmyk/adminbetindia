import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from './index';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to truncate a production database.');
  }

  const { rows } = await pool.query<{ tablename: string }>(`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> '__drizzle_migrations'
  `);

  if (rows.length === 0) {
    console.log('No application tables found — nothing to reset.');
    await pool.end();
    return;
  }

  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`));

  console.log(`Emptied ${rows.length} tables. Run \`npm run db:seed\` to repopulate.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
