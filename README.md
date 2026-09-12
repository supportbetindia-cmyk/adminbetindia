# BetIndia Smart Link Manager

Campaign attribution platform: publisher banner → smart link → approved
destination → lead → registration → FTD.

Built against the specifications in `docs/`. See `CLAUDE.md` for architecture,
the rules taken from those specifications, and build status.

## Requirements

- Node 20+
- PostgreSQL 16+

## Setup

```bash
npm install
cp .env.example .env      # set DATABASE_URL and IP_HASH_SALT
npm run db:migrate
npm run db:seed
npm run dev
```

Then:

- **Admin** — http://localhost:3000/login, signing in as `admin@betindia.bet`
  with the password printed by the seed.
- **Redirect** — http://localhost:3000/c/demo-web-sep01 redirects to the seeded
  destination with a click ID attached and writes a row to `click_events`.

The seed creates one account per role, so the permission model can be checked
by signing in as each in turn.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server on :3000 |
| `npm run build` | Production build |
| `npm run db:generate` | Regenerate SQL migrations after schema changes |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed demo users, publisher, campaign and links |
| `npm run db:reset` | Empty every application table (development only) |
| `npm run db:bootstrap-admin` | Create the first Super Admin — safe for production |
| `npm test` | Acceptance tests, against `.env.test` |
| `npm run test:migrate` | Apply migrations to the test database |
| `npm run typecheck` | TypeScript check |

### First sign-in on a real database

`npm run db:seed` creates a demo publisher, campaign and two smart links. That
is illustrative data, and PRD §9 forbids presenting it as real — so it must
never run against production. It refuses when `NODE_ENV=production`.

To create a real account instead:

```bash
npm run db:bootstrap-admin -- --email you@betindia.bet --name "Your Name"
```

It prompts for the password without echoing it, so nothing reaches shell
history or a file. It creates one Super Admin and touches nothing else, and is
safe to run in production.

- Re-running does nothing if the account exists. Add `--reset-password` to set
  a new one — that also revokes every live session for that user.
- Passwords must be at least 12 characters, and obvious patterns are refused.
- Set `ADMIN_PASSWORD` in the environment for CI, where there is no terminal to
  prompt from.

### Databases

Tests run against their **own** database, configured by `.env.test`, because
they create publishers and campaigns as fixtures and would otherwise fill the
development database's filter dropdowns with test rows.

```bash
node tools/create-database.mjs "postgresql://user:pass@localhost:5432/smartlink"
node tools/create-database.mjs "postgresql://user:pass@localhost:5432/smartlink_test"
```

Percent-encode any reserved character in the password (`@` → `%40`), or the
connection URL will not parse.

## Deploying

See [DEPLOYMENT.md](DEPLOYMENT.md) — Docker build, migrations as a separate
step, boot-time configuration validation, health checks, and what must be true
before real traffic.

## Admin API

Every endpoint requires an authenticated session and is authorised by role.
The REST routes and the admin UI call the same service functions, so the two
transports cannot enforce different rules.

| Endpoint | Methods |
|---|---|
| `/api/v1/auth/login`, `/logout`, `/me` | POST, POST, GET |
| `/api/v1/publishers`, `/{id}` | GET POST, GET PATCH |
| `/api/v1/campaigns`, `/{id}` | GET POST, GET PATCH |
| `/api/v1/creatives`, `/{id}` | GET POST, PATCH |
| `/api/v1/destinations`, `/{id}` | GET POST, GET PATCH |
| `/api/v1/destinations/{id}/approve`, `/reject`, `/revoke` | POST |
| `/api/v1/smart-links`, `/{id}` | GET POST, GET PATCH |
| `/api/v1/smart-links/{id}/destination` | POST |
| `/api/v1/reports/overview`, `/funnel`, `/publishers`, `/timeseries` | GET |
| `/api/v1/reports/export` | POST |
| `/api/v1/audit-logs` | GET |
| `/api/v1/users`, `/{id}` | GET POST, PATCH |

There is deliberately no `DELETE` anywhere. UI/UX §7: never destroy historical
attribution. Ending a campaign or a link is the terminal state.

## Status

Features 1–3 are complete and tested:

1. **Foundation and redirect engine** — 20 tables, `GET /c/{slug}`, destination
   allowlisting, bot and link-preview detection, per-click destination version
   pinning.
2. **Admin API and RBAC** — five roles from PRD §3, session auth, publisher /
   campaign / creative / destination / link CRUD, destination approval
   workflow, cost entry, audit logging on every mutation.
3. **Admin dashboard UI** — the ten screens from UI/UX §3, dark navy shell,
   `#FF6B00` primary, Poppins/Inter, per-metric availability labelling.

Features 4–7 are blocked on external input; see `CLAUDE.md` and
`docs/Outstanding_Requirements_Checklist.pdf`.

## Decisions that need sign-off

These were made to keep the build moving and are marked in the code. Each
changes behaviour if answered differently.

| # | Decision | Where | Why it needs an answer |
|---|---|---|---|
| 1 | A Campaign Manager may register a destination but not approve one | `src/lib/auth/rbac.ts` | PRD §3 says the role covers "approved destinations", which is ambiguous. Granting approval would let one person create and approve their own destination, weakening the approval evidence TRD §13 requires. |
| 2 | Integration Developer has read access plus integration settings, and no commercial writes | `src/lib/auth/rbac.ts` | PRD §3 says only "authorized technical configuration". |
| 3 | Publisher permission fields added beyond Backend Schema §2 | `src/db/schema.ts` | TRD §13 requires recording approval evidence, permitted destination types, macros, script and postback rules. The specified schema has nowhere to put them. |
| 4 | A destination URL is immutable once registered | `src/services/destinations.ts` | Editing in place would silently change where historical clicks were sent. Register a new destination and move the link instead. |
| 5 | Withdrawing an approval stops live links immediately | `src/services/destinations.ts` | The alternative is traffic continuing to an unapproved destination until someone notices. |

## Known gaps in this build

- **MFA is not implemented.** TRD §14 requires it for privileged users. The
  `admin_users.mfa_enrolled` column and a standing warning on the Settings page
  record the gap rather than hiding it. Sessions are server-side and revocable
  and sign-in is rate limited, but neither replaces MFA.
- **The rate limiter is in-process.** It protects one instance. Behind more than
  one, the effective limit multiplies by the instance count — move it to Redis
  (TRD §2) before horizontal scaling.
- **CSP allows `script-src 'unsafe-inline'`**, required by Next's hydration
  bootstrap. Tightening it needs a per-request nonce threaded through the
  document. In development the policy also allows `'unsafe-eval'`, because the
  webpack dev runtime evaluates modules with `eval()` — without it every chunk
  fails to execute and the app renders a blank page. Production never sends it.
- **Export is synchronous.** TRD §6 describes it as asynchronous. The only
  export available is click detail, which is capped at 50,000 rows and returns
  in one request. When a report needs a job queue, `/api/v1/reports/export` is
  where it moves.
- **No attribution model is approved**, so no conversion is attributed and the
  attribution coverage panel reports an empty breakdown rather than an invented
  one.
