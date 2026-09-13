/**
 * Input schemas.
 *
 * One definition per operation, used by both the REST route and the Server
 * Action behind the admin form, so the API and the UI cannot drift apart.
 *
 * TRD §6: "Mutations require validation and audit logging."
 */

import { z } from 'zod';
import { ADMIN_ROLES } from '@/lib/auth/rbac';
import { invalid } from '@/lib/errors';

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  trimmed(max).optional().transform((v) => (v && v.length > 0 ? v : null));

export const uuidSchema = z.string().uuid('Must be a valid id');

/**
 * Slugs appear in a public URL and are typed by hand into banner tags, so they
 * are restricted to characters that survive being copied, lower-cased and read
 * aloud. No leading or trailing separator, no doubled separator.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Slug must be at least 3 characters')
  .max(64, 'Slug must be 64 characters or fewer')
  .regex(
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
    'Use lowercase letters, numbers, hyphens and underscores only',
  );

/** ISO 4217. Stored uppercase alongside every money value (Backend Schema §2). */
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, 'Use a three-letter currency code');

const dateInput = z
  .union([z.string(), z.date()])
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Not a valid date' });
      return z.NEVER;
    }
    return d;
  });

const money = z
  .union([z.string(), z.number()])
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a positive amount' });
      return z.NEVER;
    }
    // numeric(18,2) — money never travels as a float (project convention).
    return n.toFixed(2);
  });

// ── Publishers ───────────────────────────────────────────────

const destinationTypeSchema = z.enum(['website', 'whatsapp']);

export const publisherCreateSchema = z.object({
  name: trimmed(200).min(2, 'Publisher name is required'),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
  externalReference: optionalText(200),
  contactName: optionalText(200),
  contactEmail: z.string().trim().email('Not a valid email').max(320).optional()
    .or(z.literal('')).transform((v) => (v ? v : null)),
  /** Empty array means nothing is approved. It never means "everything". */
  permittedDestinationTypes: z.array(destinationTypeSchema).default([]),
  trackingMacros: z.array(trimmed(64).regex(/^[A-Za-z0-9_.-]+$/, 'Macro names are alphanumeric')).default([]),
  trackingUrlApproved: z.boolean().default(false),
  scriptsAllowed: z.boolean().default(false),
  postbacksAllowed: z.boolean().default(false),
  destinationChangePolicy: optionalText(2000),
  approvalEvidence: optionalText(2000),
  reportingAccessNotes: optionalText(2000),
  eligibility: z.enum(['unconfirmed', 'eligible', 'ineligible']).default('unconfirmed'),
  notes: optionalText(2000),
});

export const publisherUpdateSchema = publisherCreateSchema.partial();

// ── Campaigns ────────────────────────────────────────────────

const campaignStatusSchema = z.enum(['draft', 'active', 'paused', 'ended']);

export const campaignCreateSchema = z
  .object({
    publisherId: uuidSchema,
    name: trimmed(200).min(2, 'Campaign name is required'),
    placement: optionalText(200),
    startsAt: dateInput,
    endsAt: dateInput,
    timezone: trimmed(64).default('Asia/Kolkata'),
    currency: currencySchema.default('INR'),
    budgetAmount: money,
    attributionWindowDays: z.coerce
      .number()
      .int()
      .min(1, 'Window must be at least 1 day')
      .max(90, 'Window must be 90 days or fewer')
      .default(30),
    approvalReference: optionalText(200),
    notes: optionalText(2000),
  })
  // UI/UX §6: "End cannot precede start".
  .refine((v) => !v.startsAt || !v.endsAt || v.endsAt.getTime() >= v.startsAt.getTime(), {
    message: 'End date cannot be before the start date',
    path: ['endsAt'],
  });

export const campaignUpdateSchema = z
  .object({
    name: trimmed(200).min(2).optional(),
    placement: optionalText(200),
    startsAt: dateInput,
    endsAt: dateInput,
    timezone: trimmed(64).optional(),
    currency: currencySchema.optional(),
    budgetAmount: money,
    attributionWindowDays: z.coerce.number().int().min(1).max(90).optional(),
    approvalReference: optionalText(200),
    notes: optionalText(2000),
    status: campaignStatusSchema.optional(),
  })
  .refine((v) => !v.startsAt || !v.endsAt || v.endsAt.getTime() >= v.startsAt.getTime(), {
    message: 'End date cannot be before the start date',
    path: ['endsAt'],
  });

// ── Creatives ────────────────────────────────────────────────

export const creativeCreateSchema = z.object({
  campaignId: uuidSchema,
  name: trimmed(200).min(2, 'Creative name is required'),
  format: optionalText(64),
  placementId: optionalText(200),
  assetReference: optionalText(500),
  approvalStatus: z.enum(['pending', 'approved', 'rejected', 'revoked']).default('pending'),
  approvalReference: optionalText(200),
});

export const creativeUpdateSchema = creativeCreateSchema.omit({ campaignId: true }).partial();

// ── Destinations ─────────────────────────────────────────────

export const destinationCreateSchema = z.object({
  label: optionalText(200),
  type: destinationTypeSchema,
  /**
   * Format only. Whether the host is permitted is decided by the allowlist in
   * lib/destination-url.ts, which is also re-checked on every redirect.
   */
  url: z.string().trim().url('Enter a full https:// URL').max(2000),
  publisherId: uuidSchema.optional().nullable(),
  approvalReference: optionalText(200),
  approvalNotes: optionalText(2000),
});

export const destinationApproveSchema = z.object({
  /**
   * Required. TRD §13 requires recorded publisher approval evidence, so an
   * approval with nothing behind it is not accepted.
   */
  approvalReference: trimmed(200).min(2, 'Record the publisher approval reference'),
  approvalNotes: optionalText(2000),
});

export const destinationRejectSchema = z.object({
  approvalNotes: trimmed(2000).min(2, 'Give a reason'),
});

// ── Smart links ──────────────────────────────────────────────

/**
 * Link expiry is optional: null means the link never expires, which is the
 * normal case for an ongoing campaign.
 *
 * When one IS given it must be comfortably in the future. A `datetime-local`
 * picker defaults its time component to 00:00 or the current moment, so
 * choosing today's date silently produces a link that dies within hours — and
 * a publisher is left running a banner that no longer redirects. Refusing
 * anything under an hour catches that before it reaches inventory.
 */
const MIN_EXPIRY_MS = 60 * 60 * 1000;

const futureExpiry = dateInput.refine(
  (value) => value === null || value.getTime() > Date.now() + MIN_EXPIRY_MS,
  { message: 'Expiry must be at least an hour from now. Leave it blank for a link that never expires.' },
);

export const smartLinkCreateSchema = z.object({
  campaignId: uuidSchema,
  creativeId: uuidSchema.optional().nullable(),
  slug: slugSchema,
  destinationId: uuidSchema,
  expiresAt: futureExpiry,
  notes: optionalText(2000),
});

export const smartLinkUpdateSchema = z.object({
  creativeId: uuidSchema.optional().nullable(),
  expiresAt: futureExpiry,
  notes: optionalText(2000),
  status: z.enum(['draft', 'active', 'paused', 'ended']).optional(),
});

export const smartLinkDestinationChangeSchema = z.object({
  destinationId: uuidSchema,
  approvalReference: trimmed(200).min(2, 'Record the publisher approval reference for this change'),
});

// ── Costs ────────────────────────────────────────────────────

export const campaignCostSchema = z.object({
  campaignId: uuidSchema,
  costDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  amount: money.refine((v) => v !== null, 'Amount is required'),
  currency: currencySchema.default('INR'),
  source: trimmed(100).min(2, 'Record where this figure came from'),
  externalReference: optionalText(200),
});

// ── Users ────────────────────────────────────────────────────

export const userCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email('Not a valid email').max(320),
  name: optionalText(200),
  role: z.enum(ADMIN_ROLES as unknown as [string, ...string[]]),
  password: z.string().min(12, 'Use at least 12 characters').max(200),
});

export const userUpdateSchema = z.object({
  name: optionalText(200),
  role: z.enum(ADMIN_ROLES as unknown as [string, ...string[]]).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  password: z.string().min(12, 'Use at least 12 characters').max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter your email address').max(320),
  password: z.string().min(1, 'Enter your password').max(200),
});

// ── Reports ──────────────────────────────────────────────────

export const reportFilterSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  publisherId: uuidSchema.optional(),
  campaignId: uuidSchema.optional(),
  creativeId: uuidSchema.optional(),
  smartLinkId: uuidSchema.optional(),
  destinationType: destinationTypeSchema.optional(),
  device: z.enum(['mobile', 'tablet', 'desktop', 'unknown']).optional(),
  /**
   * Bot-filtered clicks are excluded by default but never deleted. PRD §5:
   * raw counts are not silently altered — filtering happens at report time.
   */
  includeFiltered: z.coerce.boolean().default(false),
});

export type ReportFilter = z.infer<typeof reportFilterSchema>;

/** Turns a ZodError into the field map ServiceError carries. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Validates, or throws the ServiceError the transports already know how to
 * render. Keeps every service free of try/catch around parsing.
 */
export function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = fieldErrors(result.error);
    const first = Object.values(fields)[0] ?? 'Check the values you entered';
    throw invalid(first, fields);
  }
  return result.data;
}
