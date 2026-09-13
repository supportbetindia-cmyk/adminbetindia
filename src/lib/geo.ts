/**
 * IP-derived location.
 *
 * PRD §5 is explicit that this is an estimate: "IP-derived location and device
 * identification are estimates and must follow privacy requirements." It is
 * never presented as a measured fact, and never used as proof of anything
 * about a person.
 *
 * Two privacy properties this module is built around (PRD §13, Schema §8):
 *
 *  1. The raw IP never leaves this process. Resolution is a local database
 *     lookup, not a call to a geolocation API — an external call would ship
 *     user IPs to a third party with no data-processing agreement in place,
 *     and the legal review has not happened.
 *  2. The raw IP is never persisted. The caller resolves the city, stores the
 *     city, then hashes and discards the address.
 *
 * It is also on the redirect hot path, where the budget is p95 < 300 ms
 * (TRD §15). A local lookup is microseconds; an HTTP call would be 50–200 ms
 * and is not an option.
 */

import { existsSync } from 'node:fs';
import type { Reader, CityResponse } from 'maxmind';

export interface GeoEstimate {
  /** ISO 3166-1 alpha-2, e.g. "IN". */
  country: string | null;
  /** State / province, e.g. "Maharashtra". More reliable than city on mobile. */
  region: string | null;
  city: string | null;
  /** Where the estimate came from, so a CDN header is never confused with a database guess. */
  source: 'cdn_header' | 'maxmind' | 'unavailable';
}

export const UNKNOWN_GEO: GeoEstimate = {
  country: null,
  region: null,
  city: null,
  source: 'unavailable',
};

/**
 * CDN-provided geo headers.
 *
 * Preferred when present: the CDN resolved it at the edge, which is both more
 * accurate than a local database and free of any lookup cost. Only read when
 * the app sits behind a proxy that sets them — a client cannot forge these
 * past a correctly configured CDN, but see the note in the redirect route
 * about trusting proxy headers.
 */
function fromHeaders(headers: Headers): GeoEstimate | null {
  const city =
    headers.get('cf-ipcity') ??            // Cloudflare (Enterprise)
    headers.get('x-vercel-ip-city') ??
    headers.get('x-geo-city');

  const country =
    headers.get('cf-ipcountry') ??         // Cloudflare (all plans)
    headers.get('x-vercel-ip-country') ??
    headers.get('x-geo-country');

  const region =
    headers.get('cf-region') ??
    headers.get('x-vercel-ip-country-region') ??
    headers.get('x-geo-region');

  if (!city && !country && !region) return null;

  return {
    // Vercel percent-encodes city names that contain spaces.
    city: city ? safeDecode(city) : null,
    country: country ? country.toUpperCase().slice(0, 2) : null,
    region: region ? safeDecode(region) : null,
    source: 'cdn_header',
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value).slice(0, 120);
  } catch {
    return value.slice(0, 120);
  }
}

// ── MaxMind GeoLite2 ─────────────────────────────────────────

let reader: Reader<CityResponse> | null = null;
let loadAttempted = false;

function databasePath(): string {
  return process.env.GEOIP_DB_PATH ?? './data/GeoLite2-City.mmdb';
}

/**
 * Loads the database once, lazily.
 *
 * A missing or unreadable database is not an error: geo is an optional
 * enrichment, and a redirect must never fail because a lookup table is absent.
 * It logs once and then returns nulls forever.
 */
async function getReader(): Promise<Reader<CityResponse> | null> {
  if (reader) return reader;
  if (loadAttempted) return null;
  loadAttempted = true;

  const path = databasePath();
  if (!existsSync(path)) {
    console.warn(
      `[geo] no GeoLite2 database at ${path} — location will be reported as unavailable. ` +
      'Download GeoLite2-City.mmdb from MaxMind and set GEOIP_DB_PATH.',
    );
    return null;
  }

  try {
    const maxmind = await import('maxmind');
    reader = await maxmind.open<CityResponse>(path);
    console.log(`[geo] GeoLite2 database loaded from ${path}`);
    return reader;
  } catch (err) {
    console.error('[geo] failed to load GeoLite2 database:', err);
    return null;
  }
}

/** Private and loopback ranges never resolve to anything useful. */
function isPrivateAddress(ip: string): boolean {
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('fc') || ip.startsWith('fd') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/**
 * Resolves an IP to an approximate location.
 *
 * Never throws. Every failure path returns UNKNOWN_GEO, because a redirect
 * that fails over a geo lookup is far worse than a click with no city on it.
 */
export async function lookupGeo(
  ip: string | null,
  headers?: Headers,
): Promise<GeoEstimate> {
  if (headers) {
    const fromCdn = fromHeaders(headers);
    if (fromCdn) return fromCdn;
  }

  if (!ip || isPrivateAddress(ip)) return UNKNOWN_GEO;

  try {
    const db = await getReader();
    if (!db) return UNKNOWN_GEO;

    const result = db.get(ip);
    if (!result) return UNKNOWN_GEO;

    return {
      country: result.country?.iso_code ?? result.registered_country?.iso_code ?? null,
      region: result.subdivisions?.[0]?.names?.en?.slice(0, 120) ?? null,
      city: result.city?.names?.en?.slice(0, 120) ?? null,
      source: 'maxmind',
    };
  } catch (err) {
    console.error('[geo] lookup failed:', err);
    return UNKNOWN_GEO;
  }
}

/**
 * Loads the database ahead of the first request.
 *
 * Without this the first click after every restart pays the load cost —
 * measured at ~120 ms for the 63 MB GeoLite2-City file. That is a real person
 * waiting on a redirect budgeted at p95 < 300 ms (TRD §15), and it recurs on
 * every deploy. Called from instrumentation.ts at server start.
 *
 * Never throws: a failure to warm is not a failure to serve.
 */
export async function warmGeoReader(): Promise<void> {
  try {
    await getReader();
  } catch {
    // getReader already logs; a missing database is not an error here.
  }
}

/** Test hook — forces the database to be reloaded on the next lookup. */
export function resetGeoReader(): void {
  reader = null;
  loadAttempted = false;
}
