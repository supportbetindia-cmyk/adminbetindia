/** Convert verified Interakt customer messages into WhatsApp events and leads. */
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { destinations, leadAttributions, leads, smartLinks, webhookInbox, whatsappEvents } from '@/db/schema';
import { normalisePhone } from '@/lib/privacy';

type Db = typeof Database;
type Json = Record<string, any>;

function payloadParts(payload: unknown) {
  const root = payload as Json;
  const data = root?.data as Json;
  const message = data?.message as Json;
  const customer = data?.customer as Json;
  if (root?.type !== 'message_received' || message?.chat_message_type !== 'CustomerMessage') return null;
  if (!message?.id || !customer?.id) return null;
  const countryCode = String(customer.country_code ?? '91').replace(/\D/g, '') || '91';
  const phone = normalisePhone(String(customer.phone_number ?? ''), countryCode);
  const occurredAt = new Date(message.received_at_utc ?? root.timestamp ?? Date.now());
  if (!phone || Number.isNaN(occurredAt.getTime())) return null;
  return { message, customer, phone, occurredAt };
}

export async function processInteraktInboxRow(db: Db, inboxId: string): Promise<'processed' | 'ignored' | 'unverified'> {
  const [inbox] = await db.select().from(webhookInbox).where(eq(webhookInbox.id, inboxId)).limit(1);
  if (!inbox) return 'ignored';
  if (inbox.signatureStatus !== 'valid') return 'unverified';
  const parsed = payloadParts(inbox.payload);
  if (!parsed) {
    await db.update(webhookInbox).set({ status: 'ignored', processedAt: new Date(), attempts: sql`${webhookInbox.attempts} + 1` }).where(eq(webhookInbox.id, inboxId));
    return 'ignored';
  }

  await db.transaction(async (tx) => {
    const event = await tx.insert(whatsappEvents).values({
      provider: 'interakt', providerEventId: String(parsed.message.id),
      providerMessageId: parsed.message.source_message_id ? String(parsed.message.source_message_id) : null,
      eventType: 'message_received', contactId: String(parsed.customer.id),
      occurredAt: parsed.occurredAt, campaignReference: null, payloadReference: inbox.id,
    }).onConflictDoNothing().returning({ id: whatsappEvents.id });

    if (event.length > 0) {
      const lead = await tx.insert(leads).values({ contactKey: parsed.phone, firstMessageAt: parsed.occurredAt })
        .onConflictDoNothing().returning({ id: leads.id });
      if (lead.length > 0) {
        await tx.insert(leadAttributions).values({
          leadId: lead[0].id, clickId: null, campaignId: null, method: 'none', confidence: 'unknown',
          evidenceReference: 'Inbound WhatsApp message confirmed; no banner reference was present.',
        });
      }
    }
    await tx.update(webhookInbox).set({ status: 'processed', processedAt: new Date(), attempts: sql`${webhookInbox.attempts} + 1`, lastError: null }).where(eq(webhookInbox.id, inboxId));
  });
  return 'processed';
}

export async function processPendingVerifiedInterakt(db: Db, limit = 100): Promise<number> {
  const rows = await db.select({ id: webhookInbox.id }).from(webhookInbox)
    .where(sql`${webhookInbox.provider} = 'interakt' and ${webhookInbox.signatureStatus} = 'valid' and ${webhookInbox.status} = 'pending'`)
    .orderBy(asc(webhookInbox.receivedAt)).limit(limit);
  for (const row of rows) await processInteraktInboxRow(db, row.id);
  return rows.length;
}

function messageSummary(payload: unknown): string {
  const raw = String((payload as Json)?.data?.message?.message ?? '');
  try { const value = JSON.parse(raw); return String(value?.button_reply?.title ?? value?.list_reply?.title ?? raw); }
  catch { return raw; }
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 4 ? `+${digits.slice(0, 2)} •••••• ${digits.slice(-4)}` : '••••';
}

export async function listInteraktLeads(db: Db, revealPhone = false, limit = 500) {
  const linkRows = await db.select({ slug: smartLinks.slug, url: destinations.url })
    .from(smartLinks).innerJoin(destinations, eq(destinations.id, smartLinks.activeDestinationId))
    .where(eq(smartLinks.destinationType, 'whatsapp'));
  const linksByMessage = new Map<string, string[]>();
  for (const link of linkRows) {
    let text = '';
    try { text = new URL(link.url).searchParams.get('text')?.trim().toLowerCase() ?? ''; } catch { /* invalid URLs are ignored */ }
    if (!text) continue;
    linksByMessage.set(text, [...(linksByMessage.get(text) ?? []), link.slug]);
  }
  const rows = await db.select({
    id: webhookInbox.id,
    receivedAt: webhookInbox.receivedAt,
    signatureStatus: webhookInbox.signatureStatus,
    payload: webhookInbox.payload,
  }).from(webhookInbox)
    .where(sql`${webhookInbox.provider} = 'interakt' and ${webhookInbox.payload}->>'type' = 'message_received'`)
    .orderBy(desc(webhookInbox.receivedAt)).limit(limit);

  const contacts = new Map<string, {
    contactKey: string; customerName: string; phone: string; firstMessageAt: Date;
    lastMessageAt: Date; messages: string[]; messageCount: number; verified: boolean;
  }>();

  for (const row of rows) {
    const parsed = payloadParts(row.payload);
    if (!parsed) continue;
    const existing = contacts.get(parsed.phone);
    const name = String(parsed.customer?.traits?.name ?? '').trim() || 'Unknown';
    const message = messageSummary(row.payload) || 'Message received';
    if (!existing) {
      contacts.set(parsed.phone, {
        contactKey: parsed.phone,
        customerName: name,
        phone: revealPhone ? parsed.phone : maskPhone(parsed.phone),
        firstMessageAt: parsed.occurredAt,
        lastMessageAt: parsed.occurredAt,
        messages: [message],
        messageCount: 1,
        verified: row.signatureStatus === 'valid',
      });
      continue;
    }
    if (parsed.occurredAt < existing.firstMessageAt) existing.firstMessageAt = parsed.occurredAt;
    if (parsed.occurredAt > existing.lastMessageAt) existing.lastMessageAt = parsed.occurredAt;
    existing.messageCount += 1;
    existing.verified ||= row.signatureStatus === 'valid';
    if (!existing.messages.includes(message)) existing.messages.push(message);
    if (existing.customerName === 'Unknown' && name !== 'Unknown') existing.customerName = name;
  }

  return [...contacts.values()].map((contact) => {
    const matching = new Set<string>();
    for (const message of contact.messages) {
      for (const slug of linksByMessage.get(message.trim().toLowerCase()) ?? []) matching.add(slug);
    }
    const sourceLinks = [...matching];
    return {
      ...contact,
      sourceLink: sourceLinks.length === 1 ? sourceLinks[0] : null,
      sourceNote: sourceLinks.length > 1
        ? `Ambiguous — same message is used by ${sourceLinks.join(', ')}`
        : 'Unknown — inbound message did not uniquely match a link',
    };
  }).sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
}
