/**
 * BetIndia Smart Link Manager — database schema
 *
 * Implements Backend Database Schema & Integration Handoff v1.0 §2,
 * integrity rules from §3 and indexes from §6.
 *
 * Conventions required by §3:
 *  - UUID primary keys
 *  - explicit foreign keys
 *  - UTC timestamps (timestamptz)
 *  - immutable raw event IDs (click_id, provider_event_id, transaction_id)
 */

import {
  pgTable, pgEnum, uuid, text, integer, bigint, boolean, doublePrecision,
  timestamp, date, numeric, char, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ─────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────

export const adminRole = pgEnum('admin_role', [
  'super_admin',
  'campaign_manager',
  'media_buyer',
  'analyst',
  'integration_developer',
]);

export const destinationType = pgEnum('destination_type', ['website', 'whatsapp']);

export const linkStatus = pgEnum('link_status', ['draft', 'active', 'paused', 'ended']);

/** UI/UX Handoff §6 fixes the campaign lifecycle to these four states. */
export const campaignStatus = pgEnum('campaign_status', ['draft', 'active', 'paused', 'ended']);

/**
 * TRD §13: "If the campaign category or destination is prohibited, mark it
 * ineligible." Absence of a recorded approval is *not* approval, so the
 * default is `unconfirmed` rather than `eligible`.
 */
export const publisherEligibility = pgEnum('publisher_eligibility', [
  'unconfirmed',
  'eligible',
  'ineligible',
]);

/** Destination approval lifecycle. Only `approved` may ever be redirected to. */
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'revoked',
]);

/** Attribution confidence — never collapse "unknown" into a real campaign (TRD §10). */
export const attributionConfidence = pgEnum('attribution_confidence', [
  'exact',
  'campaign_level',
  'estimated',
  'unknown',
]);

// ─────────────────────────────────────────────────────────────
// Access control
// ─────────────────────────────────────────────────────────────

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  role: adminRole('role').notNull(),
  status: text('status').notNull().default('active'),

  /**
   * scrypt hash, encoded by lib/auth/password.ts. Never a plaintext password
   * and never logged (Backend Schema §8).
   *
   * Nullable so a Super Admin can create a user before they set a password;
   * a null hash can never authenticate.
   */
  passwordHash: text('password_hash'),

  /**
   * TRD §14 requires MFA for privileged users. Enrolment is not built in this
   * feature — this column records the requirement so the gap is visible in the
   * data rather than only in a document.
   */
  mfaEnrolled: boolean('mfa_enrolled').notNull().default(false),

  lastLoginAt: ts('last_login_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * Server-side sessions. The cookie carries a random token; only its hash is
 * stored, so a database leak does not hand over live sessions.
 *
 * Server-side (rather than a self-contained signed token) because TRD §14
 * requires least-privilege access that can be revoked — a role change or a
 * suspension has to take effect immediately, which a stateless token cannot do.
 */
export const adminSessions = pgTable('admin_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => adminUsers.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
  userAgent: text('user_agent'),
  ipHash: text('ip_hash'),
}, (t) => ({
  userIdx: index('admin_sessions_user_idx').on(t.userId),
  expiresIdx: index('admin_sessions_expires_idx').on(t.expiresAt),
}));

// ─────────────────────────────────────────────────────────────
// Publishers, campaigns, creatives
// ─────────────────────────────────────────────────────────────

/**
 * Publishers.
 *
 * The permission columns below go beyond Backend Schema §2, which lists only
 * id/name/status/external_reference/created_at. They are required by TRD §13
 * ("Record publisher approval evidence, permitted destination types, tracking
 * macros, scripts/tags, postback rules, creative specifications and
 * destination-change requirements") and PRD §11, and there is nowhere else in
 * the specified schema to put them. Recorded here rather than left implicit,
 * because "Never assume a macro, script or postback is supported" (PRD §11)
 * only means something if the system can tell approved from unknown.
 */
export const publishers = pgTable('publishers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  externalReference: text('external_reference'),

  contactName: text('contact_name'),
  contactEmail: text('contact_email'),

  /** Empty means "no destination type approved", never "all types approved". */
  permittedDestinationTypes: text('permitted_destination_types').array().notNull().default([]),
  /** Approved click macro parameter names, e.g. ["pcid"]. Empty = none approved. */
  trackingMacros: text('tracking_macros').array().notNull().default([]),
  trackingUrlApproved: boolean('tracking_url_approved').notNull().default(false),
  scriptsAllowed: boolean('scripts_allowed').notNull().default(false),
  postbacksAllowed: boolean('postbacks_allowed').notNull().default(false),
  destinationChangePolicy: text('destination_change_policy'),
  approvalEvidence: text('approval_evidence'),
  reportingAccessNotes: text('reporting_access_notes'),
  eligibility: publisherEligibility('eligibility').notNull().default('unconfirmed'),
  notes: text('notes'),

  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  publisherId: uuid('publisher_id').notNull().references(() => publishers.id),
  name: text('name').notNull(),
  status: campaignStatus('status').notNull().default('draft'),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  /** Display timezone. Storage is always UTC (Backend Schema §3). */
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  attributionWindowDays: integer('attribution_window_days').notNull().default(30),

  /** Placement / inventory description (PRD §4, UI/UX §6). */
  placement: text('placement'),
  /** Planned spend. Actual spend lives in campaign_costs and is never mixed in. */
  budgetAmount: numeric('budget_amount', { precision: 18, scale: 2 }),
  approvalReference: text('approval_reference'),
  notes: text('notes'),

  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => ({
  publisherIdx: index('campaigns_publisher_idx').on(t.publisherId),
  statusIdx: index('campaigns_status_idx').on(t.status),
}));

export const creatives = pgTable('creatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  name: text('name').notNull(),
  format: text('format'),
  placementId: text('placement_id'),
  assetReference: text('asset_reference'),
  approvalStatus: approvalStatusEnum('approval_status').notNull().default('pending'),
  approvalReference: text('approval_reference'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({
  campaignIdx: index('creatives_campaign_idx').on(t.campaignId),
}));

// ─────────────────────────────────────────────────────────────
// Destinations — approved and allowlisted; never user-supplied (TRD §5)
// ─────────────────────────────────────────────────────────────

export const destinations = pgTable('destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Human label so the registry is usable in a select without reading URLs. */
  label: text('label'),
  type: destinationType('type').notNull(),
  url: text('url').notNull(),
  /** Optional owner. A publisher-scoped destination is offered only for that publisher. */
  publisherId: uuid('publisher_id').references(() => publishers.id),
  approvalStatus: approvalStatusEnum('approval_status').notNull().default('pending'),
  approvalReference: text('approval_reference'),
  approvalNotes: text('approval_notes'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({
  approvalIdx: index('destinations_approval_idx').on(t.approvalStatus),
}));

/**
 * One row per destination change on a link. Every click pins the version it
 * used, so a later change never rewrites historical attribution (§3).
 */
export const destinationVersions = pgTable('destination_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  smartLinkId: uuid('smart_link_id').notNull(),
  destinationId: uuid('destination_id').notNull().references(() => destinations.id),
  version: integer('version').notNull(),
  effectiveAt: ts('effective_at').notNull().defaultNow(),
  changedBy: uuid('changed_by'),
  approvalReference: text('approval_reference'),
}, (t) => ({
  linkVersionUnq: uniqueIndex('destination_versions_link_version_unq').on(t.smartLinkId, t.version),
  linkEffectiveIdx: index('destination_versions_link_effective_idx').on(t.smartLinkId, t.effectiveAt),
}));

// ─────────────────────────────────────────────────────────────
// Smart links
// ─────────────────────────────────────────────────────────────

export const smartLinks = pgTable('smart_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  creativeId: uuid('creative_id').references(() => creatives.id),
  slug: text('slug').notNull().unique(),
  destinationType: destinationType('destination_type').notNull(),
  activeDestinationId: uuid('active_destination_id').references(() => destinations.id),
  activeDestinationVersion: integer('active_destination_version').notNull().default(0),
  status: linkStatus('status').notNull().default('draft'),
  expiresAt: ts('expires_at'),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => ({
  campaignIdx: index('smart_links_campaign_idx').on(t.campaignId),
  statusIdx: index('smart_links_status_idx').on(t.status),
}));

// ─────────────────────────────────────────────────────────────
// Click events — immutable raw record, written before the redirect (TRD §5)
// ─────────────────────────────────────────────────────────────

export const clickEvents = pgTable('click_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  clickId: text('click_id').notNull().unique(),
  smartLinkId: uuid('smart_link_id').notNull().references(() => smartLinks.id),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  publisherId: uuid('publisher_id').notNull().references(() => publishers.id),
  creativeId: uuid('creative_id').references(() => creatives.id),
  destinationVersionId: uuid('destination_version_id').notNull().references(() => destinationVersions.id),
  occurredAt: ts('occurred_at').notNull().defaultNow(),

  visitorTokenHash: text('visitor_token_hash'),
  publisherClickId: text('publisher_click_id'),
  deviceType: text('device_type'),
  os: text('os'),
  referrer: text('referrer'),
  ipHash: text('ip_hash'),
  geoCountry: text('geo_country'),

  utmSource: text('utm_source'),
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),
  utmContent: text('utm_content'),
  utmTerm: text('utm_term'),

  /**
   * Bot signals are recorded but never silently alter raw counts (PRD §5).
   * Filtering happens at report time, from these columns.
   */
  botScore: doublePrecision('bot_score'),
  botFlags: text('bot_flags'),
  isFiltered: boolean('is_filtered').notNull().default(false),
}, (t) => ({
  campaignTimeIdx: index('click_events_campaign_time_idx').on(t.campaignId, t.occurredAt),
  publisherTimeIdx: index('click_events_publisher_time_idx').on(t.publisherId, t.occurredAt),
  visitorTimeIdx: index('click_events_visitor_time_idx').on(t.visitorTokenHash, t.occurredAt),
  linkTimeIdx: index('click_events_link_time_idx').on(t.smartLinkId, t.occurredAt),
}));

// ─────────────────────────────────────────────────────────────
// Website journey
// ─────────────────────────────────────────────────────────────

export const websiteSessions = pgTable('website_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  clickId: text('click_id'),
  sessionTokenHash: text('session_token_hash').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  landingUrl: text('landing_url'),
  consentStatus: text('consent_status').notNull().default('unknown'),
  attributionStatus: text('attribution_status').notNull().default('unmatched'),
}, (t) => ({
  clickIdx: index('website_sessions_click_idx').on(t.clickId),
}));

export const websiteEvents = pgTable('website_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => websiteSessions.id),
  eventType: text('event_type').notNull(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  eventKey: text('event_key').notNull().unique(),
  metadata: jsonb('metadata'),
}, (t) => ({
  sessionTimeIdx: index('website_events_session_time_idx').on(t.sessionId, t.occurredAt),
}));

// ─────────────────────────────────────────────────────────────
// WhatsApp journey
// ─────────────────────────────────────────────────────────────

export const whatsappEvents = pgTable('whatsapp_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  providerMessageId: text('provider_message_id'),
  eventType: text('event_type').notNull(),
  contactId: text('contact_id'),
  occurredAt: ts('occurred_at').notNull(),
  campaignReference: text('campaign_reference'),
  payloadReference: text('payload_reference'),
}, (t) => ({
  providerEventUnq: uniqueIndex('whatsapp_events_provider_event_unq').on(t.provider, t.providerEventId),
  contactTimeIdx: index('whatsapp_events_contact_time_idx').on(t.contactId, t.occurredAt),
}));

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactKey: text('contact_key').notNull().unique(),
  firstMessageAt: ts('first_message_at').notNull(),
  status: text('status').notNull().default('new'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const leadAttributions = pgTable('lead_attributions', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull().references(() => leads.id),
  clickId: text('click_id'),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  method: text('method').notNull(),
  confidence: attributionConfidence('confidence').notNull(),
  referenceToken: text('reference_token'),
  attributedAt: ts('attributed_at').notNull().defaultNow(),
  evidenceReference: text('evidence_reference'),
}, (t) => ({
  clickIdx: index('lead_attributions_click_idx').on(t.clickId),
  leadIdx: index('lead_attributions_lead_idx').on(t.leadId),
}));

// ─────────────────────────────────────────────────────────────
// Verified conversions
// ─────────────────────────────────────────────────────────────

export const registrations = pgTable('registrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceSystem: text('source_system').notNull(),
  externalUserId: text('external_user_id').notNull(),
  registeredAt: ts('registered_at').notNull(),
  contactKey: text('contact_key'),
  sourceEventId: text('source_event_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({
  sourceUserUnq: uniqueIndex('registrations_source_user_unq').on(t.sourceSystem, t.externalUserId),
  contactIdx: index('registrations_contact_idx').on(t.contactKey),
}));

export const conversionAttributions = pgTable('conversion_attributions', {
  id: uuid('id').primaryKey().defaultRandom(),
  registrationId: uuid('registration_id').notNull().references(() => registrations.id),
  clickId: text('click_id'),
  leadId: uuid('lead_id').references(() => leads.id),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  model: text('model').notNull(),
  confidence: attributionConfidence('confidence').notNull(),
  policyVersion: text('policy_version'),
  attributedAt: ts('attributed_at').notNull().defaultNow(),
  evidenceReference: text('evidence_reference'),
}, (t) => ({
  clickIdx: index('conversion_attributions_click_idx').on(t.clickId),
  registrationIdx: index('conversion_attributions_registration_idx').on(t.registrationId),
}));

export const ftdEvents = pgTable('ftd_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  registrationId: uuid('registration_id').notNull().references(() => registrations.id),
  sourceSystem: text('source_system').notNull(),
  externalTransactionId: text('external_transaction_id').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  completedAt: ts('completed_at').notNull(),
  /** Only a verified completed genuine first deposit counts (§3). */
  status: text('status').notNull(),
}, (t) => ({
  sourceTxnUnq: uniqueIndex('ftd_events_source_txn_unq').on(t.sourceSystem, t.externalTransactionId),
  registrationTimeIdx: index('ftd_events_registration_time_idx').on(t.registrationId, t.completedAt),
}));

// ─────────────────────────────────────────────────────────────
// Costs and publisher-reported figures — kept separate from first-party (§7)
// ─────────────────────────────────────────────────────────────

export const campaignCosts = pgTable('campaign_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  costDate: date('cost_date').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  source: text('source').notNull(),
  externalReference: text('external_reference'),
}, (t) => ({
  campaignDateSourceUnq: uniqueIndex('campaign_costs_campaign_date_source_unq')
    .on(t.campaignId, t.costDate, t.source),
}));

export const publisherReports = pgTable('publisher_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  publisherId: uuid('publisher_id').notNull().references(() => publishers.id),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  reportDate: date('report_date').notNull(),
  impressions: bigint('impressions', { mode: 'number' }),
  publisherClicks: bigint('publisher_clicks', { mode: 'number' }),
  spend: numeric('spend', { precision: 18, scale: 2 }),
  currency: char('currency', { length: 3 }),
  sourceReference: text('source_reference'),
  importedAt: ts('imported_at').notNull().defaultNow(),
}, (t) => ({
  pubCampaignDateUnq: uniqueIndex('publisher_reports_pub_campaign_date_unq')
    .on(t.publisherId, t.campaignId, t.reportDate),
}));

// ─────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────

/**
 * Durable webhook inbox: the raw event is stored first and acknowledged, then
 * processed separately (Backend Schema §5, §8; TRD §15).
 *
 * Storing the untouched payload is what makes a provider integration
 * recoverable — if parsing is wrong, or the schema turns out to differ from
 * what was assumed, the original events are still here to reprocess.
 */
export const webhookInbox = pgTable('webhook_inbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  /**
   * Idempotency key. Taken from the provider's own event ID when one can be
   * found, otherwise a hash of the body — duplicate delivery of an identical
   * payload then still collapses to one row (Backend Schema §9).
   */
  externalEventId: text('external_event_id').notNull(),
  /** How that key was obtained, so a fallback is never mistaken for a real ID. */
  eventIdSource: text('event_id_source'),
  payload: jsonb('payload').notNull(),

  /**
   * Inbound headers, for discovering how the provider authenticates.
   *
   * Values of credential-bearing headers are NOT stored — only their name,
   * length and a short prefix, which is enough to identify the scheme without
   * retaining the secret (Backend Schema §8).
   */
  headers: jsonb('headers'),
  contentType: text('content_type'),
  sourceIpHash: text('source_ip_hash'),

  /**
   * Result of signature/secret verification. `not_configured` is recorded
   * explicitly rather than left null, so an unauthenticated endpoint is
   * visible in the data instead of merely absent.
   */
  signatureStatus: text('signature_status').notNull().default('not_configured'),

  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  /** Incremented when the same event ID is delivered again. */
  duplicateCount: integer('duplicate_count').notNull().default(0),
}, (t) => ({
  providerEventUnq: uniqueIndex('webhook_inbox_provider_event_unq').on(t.provider, t.externalEventId),
  statusReceivedIdx: index('webhook_inbox_status_received_idx').on(t.status, t.receivedAt),
  providerReceivedIdx: index('webhook_inbox_provider_received_idx').on(t.provider, t.receivedAt),
}));

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').references(() => adminUsers.id),
  /**
   * Actor identity is denormalised on purpose. An audit trail that stops
   * resolving when a user row changes is not an audit trail (UI/UX §12).
   */
  actorEmail: text('actor_email'),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  /** One-line human summary, so the log is readable without diffing JSON. */
  summary: text('summary'),
  /** Publisher approval reference for destination and campaign changes (UI/UX §12). */
  approvalReference: text('approval_reference'),
  beforeData: jsonb('before_data'),
  afterData: jsonb('after_data'),
  ipHash: text('ip_hash'),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
}, (t) => ({
  entityIdx: index('audit_logs_entity_idx').on(t.entityType, t.entityId),
  timeIdx: index('audit_logs_time_idx').on(t.occurredAt),
  actorIdx: index('audit_logs_actor_idx').on(t.actorId, t.occurredAt),
}));
