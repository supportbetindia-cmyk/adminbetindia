/**
 * Webhook capture.
 *
 * This is the capture half of provider ingestion, and deliberately only that.
 * It stores what arrived and acknowledges it. It does not interpret the
 * payload, because no real Interakt payload has been seen yet — PRD §7, TRD §8
 * and Backend Schema §10 all require the schema be verified against actual
 * documentation and samples rather than assumed.
 *
 * Parsing lives behind a separate step, added once real events exist in this
 * table. Until then the honest position is: we have the events, we have not
 * claimed to understand them.
 *
 * Free of Next.js types so it can be tested directly against the database.
 */

import { createHash } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { webhookInbox } from '@/db/schema';

type Db = typeof Database;

export type WebhookProvider = 'interakt';

export type SignatureStatus = 'not_configured' | 'valid' | 'invalid';

export interface CaptureInput {
  provider: WebhookProvider;
  /** Parsed JSON body, or the raw text wrapped when it is not JSON. */
  payload: unknown;
  headers: Record<string, string>;
  /** Raw body text, used for hashing and signature checks. */
  rawBody: string;
  sourceIpHash: string | null;
  signatureStatus: SignatureStatus;
}

export type CaptureResult =
  | { status: 'stored'; id: string; externalEventId: string; eventIdSource: string }
  | { status: 'duplicate'; id: string; externalEventId: string };

/**
 * Header names whose values are credentials. The value is never stored — only
 * enough shape to identify the scheme (Backend Schema §8).
 */
const SENSITIVE_HEADER = /authorization|signature|secret|token|api[-_]?key|cookie|x-hub-signature/i;

/** Headers that say nothing useful and only add noise. */
const IGNORED_HEADER = /^(accept|accept-encoding|connection|host|content-length)$/i;

/**
 * Records header names and, for credential-bearing headers, a redacted
 * descriptor instead of the value.
 *
 * The point is discovery: seeing `x-interakt-signature: <sha256, 64 chars,
 * "a3f9…">` tells you the scheme without retaining the secret.
 */
export function describeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (IGNORED_HEADER.test(key)) continue;

    if (SENSITIVE_HEADER.test(key)) {
      const prefix = value.slice(0, 6);
      out[key] = `<redacted: ${value.length} chars, starts "${prefix}">`;
    } else {
      out[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    }
  }

  return out;
}

/**
 * Common places a provider puts its event identifier.
 *
 * This is a best guess used only for idempotency, not interpretation. Which
 * field Interakt actually uses is an open question — once a real payload is
 * captured, the correct path replaces this list.
 */
const EVENT_ID_PATHS: string[][] = [
  ['id'],
  ['event_id'], ['eventId'],
  ['message_id'], ['messageId'],
  ['data', 'id'],
  ['data', 'message_id'], ['data', 'messageId'],
  ['payload', 'id'],
  ['message', 'id'],
  ['webhook_id'], ['webhookId'],
];

function readPath(value: unknown, path: string[]): string | null {
  let node: unknown = value;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node === 'string' && node.trim()) return node.trim().slice(0, 300);
  if (typeof node === 'number' && Number.isFinite(node)) return String(node);
  return null;
}

export function deriveEventId(
  payload: unknown,
  rawBody: string,
): { externalEventId: string; eventIdSource: string } {
  for (const path of EVENT_ID_PATHS) {
    const found = readPath(payload, path);
    if (found) return { externalEventId: found, eventIdSource: path.join('.') };
  }

  /*
   * No recognisable ID. Hash the body instead, so an identical redelivery
   * still collapses to one row.
   *
   * Known limit: if the provider retries with a changed timestamp or nonce in
   * the body, the hash differs and the retry is stored as a new event. That is
   * why `event_id_source` is recorded — a row marked `body_sha256` has NOT
   * been reliably deduplicated, and the real field must be wired in once the
   * payload shape is known.
   */
  return {
    externalEventId: `sha256:${createHash('sha256').update(rawBody).digest('hex')}`,
    eventIdSource: 'body_sha256',
  };
}

/**
 * Stores one inbound event.
 *
 * Never throws for an unrecognised payload. A provider that receives an error
 * will retry, and retrying is pointless when the only problem is that we did
 * not understand the body — we want it stored so a human can look at it.
 */
export async function captureWebhook(db: Db, input: CaptureInput): Promise<CaptureResult> {
  const { externalEventId, eventIdSource } = deriveEventId(input.payload, input.rawBody);

  const rows = await db
    .insert(webhookInbox)
    .values({
      provider: input.provider,
      externalEventId,
      eventIdSource,
      payload: input.payload as object,
      headers: describeHeaders(input.headers),
      contentType: input.headers['content-type'] ?? null,
      sourceIpHash: input.sourceIpHash,
      signatureStatus: input.signatureStatus,
      status: 'pending',
    })
    .onConflictDoNothing({ target: [webhookInbox.provider, webhookInbox.externalEventId] })
    .returning({ id: webhookInbox.id });

  if (rows.length > 0) {
    return { status: 'stored', id: rows[0].id, externalEventId, eventIdSource };
  }

  // Already seen. Count the redelivery rather than storing it twice — Backend
  // Schema §9: duplicate delivery must not duplicate anything downstream.
  const [existing] = await db
    .update(webhookInbox)
    .set({ duplicateCount: sql`${webhookInbox.duplicateCount} + 1` })
    .where(
      sql`${webhookInbox.provider} = ${input.provider} and ${webhookInbox.externalEventId} = ${externalEventId}`,
    )
    .returning({ id: webhookInbox.id });

  return { status: 'duplicate', id: existing.id, externalEventId };
}

export type InboxRow = typeof webhookInbox.$inferSelect;

export interface InboxSummary {
  total: number;
  pending: number;
  duplicates: number;
  unverified: number;
  firstReceivedAt: Date | null;
  lastReceivedAt: Date | null;
  /** Distinct event-ID sources seen, so a body-hash fallback is obvious. */
  eventIdSources: { source: string; count: number }[];
}

/**
 * An aggregate over a timestamptz comes back from the driver as a string in
 * some configurations and a Date in others. Normalising here means callers get
 * the type the signature promises, rather than one that happens to work.
 */
function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function inboxSummary(db: Db, provider: WebhookProvider): Promise<InboxSummary> {
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where ${webhookInbox.status} = 'pending')::int`,
      duplicates: sql<number>`coalesce(sum(${webhookInbox.duplicateCount}), 0)::int`,
      unverified: sql<number>`count(*) filter (where ${webhookInbox.signatureStatus} <> 'valid')::int`,
      firstReceivedAt: sql<Date | string | null>`min(${webhookInbox.receivedAt})`,
      lastReceivedAt: sql<Date | string | null>`max(${webhookInbox.receivedAt})`,
    })
    .from(webhookInbox)
    .where(eq(webhookInbox.provider, provider));

  const sources = await db
    .select({
      source: sql<string>`coalesce(${webhookInbox.eventIdSource}, 'unknown')`,
      count: sql<number>`count(*)::int`,
    })
    .from(webhookInbox)
    .where(eq(webhookInbox.provider, provider))
    .groupBy(sql`1`)
    .orderBy(sql`2 desc`);

  return {
    total: totals?.total ?? 0,
    pending: totals?.pending ?? 0,
    duplicates: totals?.duplicates ?? 0,
    unverified: totals?.unverified ?? 0,
    firstReceivedAt: toDate(totals?.firstReceivedAt),
    lastReceivedAt: toDate(totals?.lastReceivedAt),
    eventIdSources: sources,
  };
}

export async function listInbox(
  db: Db,
  provider: WebhookProvider,
  limit = 25,
): Promise<InboxRow[]> {
  return db
    .select()
    .from(webhookInbox)
    .where(eq(webhookInbox.provider, provider))
    .orderBy(desc(webhookInbox.receivedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}
