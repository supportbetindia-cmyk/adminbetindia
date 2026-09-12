/**
 * Runs once when the server starts, before any request is handled.
 *
 * Used to validate production configuration at boot. Next calls this in both
 * the nodejs and edge runtimes, so the check is guarded — `process.env` reads
 * behave differently on edge, and the database checks are meaningless there.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertConfig } = await import('@/lib/env');
  assertConfig();
}
