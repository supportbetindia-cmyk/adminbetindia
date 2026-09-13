# BetIndia Smart Link Manager — project context

Read this before changing anything. It carries the decisions and constraints
that are not obvious from the code alone.

## What this is

A campaign attribution platform for BetIndia. Publishers run banners containing
a smart link (`go.betindia.games/c/{slug}`). A click is recorded, the user is
redirected to exactly one approved destination — the website or WhatsApp — and
the journey is traced through to a verified registration and first-time deposit
(FTD), so spend can be attributed to real outcomes per publisher, campaign and
creative.

## Source specifications

The four documents in `docs/` are the authority for this build:

| File | Governs |
|---|---|
| `BetIndia_Smart_Link_PRD.docx` | Product scope, roles, funnel definitions, metrics |
| `BetIndia_Smart_Link_TRD.docx` | Architecture, API contracts, attribution rules, SLOs |
| `BetIndia_Smart_Link_Backend_Schema.docx` | Table definitions, integrity rules, acceptance tests |
| `BetIndia_Smart_Link_UI_UX_Handoff.docx` | Screens, design tokens, interface behaviour |

`docs/Outstanding_Requirements_Checklist.pdf` and
`docs/Requirements_and_Limitations.pdf` were produced from those four and list
what is still blocked and on whom.

When code and documents disagree, the documents win — or the disagreement gets
raised, not silently resolved.

## Non-negotiable rules from the specification

These are repeated across all four documents. Violating one produces a report
that lies, which is the specific failure mode the whole project is designed to
avoid.

1. **A click is not a person.** Unique visitors are always a deduplicated
   estimate and must be labelled as such. (PRD §5, TRD §11)
2. **A redirect is not a lead.** A WhatsApp lead requires a genuine inbound
   message event. A redirect or an attempted app open is neither. (PRD §6, TRD §8)
3. **A form click is not a registration.** Registration requires a real external
   user ID and a completed account. (PRD §6, TRD §9)
4. **Not every deposit is an FTD.** Pending, failed, reversed and promotional
   credits are excluded. (PRD §8, TRD §9)
5. **The click ID does not survive a WhatsApp redirect.** Never assume it comes
   back. WhatsApp attribution is campaign-level at best. (PRD §7, TRD §8, Schema §4)

   **TESTED 12 Sept 2026 against live Interakt webhooks.** A campaign code
   placed in the prefilled message *does* survive into the inbound event:
   `data.message.message` contained `"Hi [BI-TEST-001]"` exactly. So WhatsApp
   attribution is **campaign-level — confirmed, not assumed**. It is still not
   click-level: the code identifies the campaign, never the individual click,
   and a user who edits the prefilled text before sending arrives unattributed.
   Per-click WhatsApp matching must still never be promised.
6. **Unknown attribution stays unknown.** Never distribute unmatched conversions
   proportionally to make a report look complete. (TRD §10)
7. **Never redirect to an unapproved destination.** The destination registry is
   the only source of destination URLs. No user input, ever. (PRD §4, TRD §5)
8. **Raw counts are never silently altered.** Bot and fraud signals are recorded
   on the event; filtering happens at report time. (PRD §5)
9. **Publisher-reported figures stay separate from first-party figures**, with
   discrepancies shown rather than reconciled away. (PRD §11, Schema §7)
10. **Phone and IP data are minimised.** No raw IP is ever persisted. A phone
    number alone is not proof of a click. (PRD §13, Schema §4, §8)

## Stack

- **Next.js 15 (App Router) + TypeScript** — as specified in TRD §2.
- **PostgreSQL 16** — as specified.
- **Drizzle ORM** rather than Prisma. The TRD says "PostgreSQL" without naming an
  ORM. Drizzle was chosen because it is pure TypeScript with no binary query
  engine, which keeps cold starts and per-request overhead low on the redirect
  path where the budget is p95 < 300 ms (TRD §15). Migrations are plain SQL in
  `drizzle/`, readable without knowing the ORM.
- No Redis yet. TRD §2 suggests a Redis-backed queue; the durable `webhook_inbox`
  table covers Phase 1 needs. Add Redis when webhook volume justifies it.

## Layout

```
src/
  app/
    c/[slug]/route.ts     Public redirect endpoint — the only route publisher traffic hits
    (admin)/              Authenticated admin screens; the group's layout is the auth gate
    api/v1/               REST admin API (TRD §6)
    login/                Sign-in
    globals.css           Design tokens from UI/UX §2
  components/             AppShell, MetricCard, DataTable, forms, charts
  db/
    schema.ts             All 21 tables (20 from Backend Schema §2, plus admin_sessions)
    index.ts              Pool + Drizzle client
    migrate.ts seed.ts    Migration runner and dev seed
  lib/
    auth/                 rbac.ts, session.ts, password.ts, context.ts, current.ts
    ids.ts                Cryptographically random click IDs, visitor tokens
    privacy.ts            IP/token hashing, phone normalisation
    client-signals.ts     Device/OS parsing, bot and link-preview detection
    destination-url.ts    Allowlisting, open-redirect prevention, URL building
    audit.ts              writeAudit + secret redaction + field diffing
    errors.ts             ServiceError, mapped to HTTP status or form errors
    validation.ts         Zod schemas shared by API and UI
    csv.ts format.ts      Export headers; IST display, N/A rendering
  server/
    actions.ts            Server Actions behind the admin forms
  services/               All business logic — permission, validation, audit
    redirect.ts           Core resolve → validate → record → redirect logic
    auth publishers campaigns creatives destinations smart-links users costs
    reports.ts audit-log.ts
  middleware.ts           Security headers + x-pathname; does NOT authenticate
drizzle/                  Generated SQL migrations
tests/                    Acceptance tests mapped to Backend Schema §9
docs/                     The four source specifications
```

**The service layer is the only place business rules live.** REST routes and
Server Actions are both thin wrappers over the same functions, so the API and
the UI cannot enforce different rules. A service takes an `ActorContext` and
calls `requirePermission` itself — no transport can reach one without a
permission check.

The service layer is deliberately free of Next.js types so it can be tested
directly against a real database. Tests use real PostgreSQL, not mocks — the
constraints being verified (uniqueness, version pinning, foreign keys, enum
domains, upsert conflict targets) only exist in the database.

Authentication happens in the `(admin)` layout, against the session table, on
every request. It is deliberately **not** in middleware: a cookie-presence check
there would let a revoked session or a suspended user through.

## Running it

```bash
# PostgreSQL must be running and DATABASE_URL set — see .env.example
npm install
npm run db:generate    # regenerate SQL after editing src/db/schema.ts
npm run db:migrate     # apply migrations
npm run db:seed        # demo users, publisher, campaign and two links
npm run dev            # http://localhost:3000
npm test               # acceptance tests (needs a live database)
npm run typecheck
```

Seeded links: `/c/demo-web-sep01` (website) and `/c/demo-wa-sep01` (WhatsApp).
Seeded admin: `admin@betindia.bet`, plus one account per role; the seed prints
the shared password. It refuses to run with `NODE_ENV=production`.

## Build status

**Feature 1 — foundation and redirect engine. Done.**
- All 20 tables migrated, with the indexes from Schema §6.
- `GET /c/{slug}`: validates link status, expiry, campaign window and destination
  approval; mints a 128-bit random click ID; writes the click durably *before*
  redirecting; returns 302 with `Cache-Control: no-store`.
- Destination host allowlisting and open-redirect prevention.
- Device, OS, referrer, UTM and publisher-macro capture.
- Bot and link-preview detection (WhatsApp, Facebook, Slack and similar
  fetchers hit shared links and would otherwise inflate counts).
- Every click pins its destination version, so later destination changes never
  rewrite historical attribution.

**Feature 2 — admin API and RBAC. Done.**
- Email + password sign-in (scrypt), server-side revocable sessions, per-identity
  and per-source rate limiting.
- Five roles from PRD §3 as an explicit permission matrix in `lib/auth/rbac.ts`.
  Two mappings are marked NEEDS SIGN-OFF there and in README.md.
- Publisher, campaign, creative, destination, smart-link, user and cost CRUD,
  with the approval preconditions from TRD §13 enforced in the service layer.
- Destination approval workflow: register → approve (requires a recorded
  publisher reference) → reject/revoke. Withdrawing approval stops live links
  immediately.
- Destination changes append an immutable version; historical clicks keep theirs.
- Audit row on every mutation with actor, before/after diff and approval
  reference. Secrets are redacted by key name before the row is written.
- REST API under `/api/v1` per TRD §6, plus CSV export with a definitions header.

**Feature 3 — admin dashboard UI. Done.**
- The ten screens from UI/UX §3, role-aware navigation, design tokens from §2.
- Every metric carries `measured` / `estimated` / `unavailable`, and an
  unavailable metric renders N/A with its reason — never zero.
- Leads, Registrations and FTD render honest "no source connected" screens
  listing what is blocked and on whom, rather than sample rows.
- Loading, empty, error and permission-denied states on every screen.

**Not built yet**, in the order the documents sequence it:
- Feature 4 — website tracking SDK and click-ID pass-through to registration.
- Feature 5 — Interakt webhook ingestion, lead identity matching.
- Feature 6 — registration and FTD ingestion behind provider adapters.
- Feature 7 — attribution engine, cohort reporting, cost import, reconciliation.

Known gaps in what *is* built (MFA, in-process rate limiting, CSP inline
scripts, synchronous export) are listed in README.md.

## Blocked on external input

Nothing in Feature 1 is blocked. Later features are, and the code should keep
integration boundaries behind adapters until these are answered:

- ~~Interakt webhook payload samples, and whether a campaign reference survives
  into the inbound event.~~ **ANSWERED 12 Sept 2026.** Verified against live
  webhooks on the Growth+ plan (inbound message events require a paid tier).
  Confirmed payload shape for `type: "message_received"`:

  | Field | Purpose |
  |---|---|
  | `data.message.id` | Per-message UUID — the idempotency key |
  | `data.message.message` | Message text; carries the `[BI-…]` campaign code |
  | `data.message.chat_message_type` | `"CustomerMessage"` distinguishes inbound |
  | `data.message.message_content_type` | `"Text"` or `"InteractiveButtonReply"` |
  | `data.customer.id` | Stable contact UUID — the lead identity |
  | `data.customer.phone_number` + `country_code` | Contact details (PII) |

  Authentication is `interakt-signature: sha256=<64 hex>` (HMAC-SHA256).
  Verification is implemented in observe-only mode until proven on live
  traffic — see the route handler.
- The registration and transaction APIs from the betting platform, plus the
  exact FTD eligibility rule.
- Per-publisher approval of the tracking URL, macros and destination type.
- Sign-off on the attribution model. TRD §10 proposes first click within a
  30-day window "subject to business approval" — not yet approved.

`docs/Outstanding_Requirements_Checklist.pdf` has the full list with sources.

## Conventions

- UTC in the database (`timestamptz`), IST at display time.
- UUID primary keys; raw event IDs (`click_id`, `provider_event_id`,
  `external_transaction_id`) are immutable and uniquely constrained.
- Every admin mutation writes an `audit_logs` row with before/after values.
- Money is `numeric(18,2)` with an explicit currency column. Never floats.
- Comments explain *why*, and cite the document section when a rule comes from
  the specification.
