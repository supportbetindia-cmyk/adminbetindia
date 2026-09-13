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

  /*
   * The GeoLite2 database is deliberately NOT warmed from here.
   *
   * Next compiles this file for the edge runtime as well as node, and follows
   * imports statically regardless of the NEXT_RUNTIME guard above. `maxmind`
   * and `node:fs` do not exist on edge, so importing lib/geo here fails the
   * whole compile — including middleware, which takes the site down.
   *
   * Geo therefore loads lazily on first use inside the nodejs-only redirect
   * route. The cost is roughly 120 ms on the first click after each restart,
   * once. Warming it properly needs a node-only entry point outside Next's
   * instrumentation hook; see warmGeoReader() in lib/geo.ts.
   */
}
