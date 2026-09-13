# Deployment

The app serves two very different things from one origin:

- `go.betindia.games/c/{slug}` — public redirect traffic, latency-critical
- `go.betindia.games/login` — the admin panel

Clicks are redirected to `www.betindia.bet`, which is a separate site owned by
the web team.

## Where to host it

**Host in Singapore, `ap-southeast-1`** — the same region as the Neon project.

This is counter-intuitive and worth stating plainly: the redirect endpoint does
a `SELECT` then an `INSERT` before sending the user anywhere. Those are two
sequential round trips. Putting the app in Mumbai and the database in Singapore
pays that distance twice per click; putting the app next to the database pays
it zero times, and the user crosses the ocean once either way — which they do
regardless of where the app runs.

Neon has no India region, so Singapore is the closest available.

## Build and run

```bash
docker build -t smartlink .
docker run -p 3000:3000 --env-file .env.production smartlink
```

The image uses Next's standalone output: the runtime carries only traced
modules and no build toolchain, runs as the unprivileged `node` user, and boots
in well under a second.

## Migrations

Migrations are a **separate step**, not part of the app's startup. Running them
from an entrypoint races when more than one instance starts at once, and a
half-applied schema is worse than a delayed deploy.

```bash
docker build --target migrator -t smartlink-migrate .
docker run --rm --env-file .env.production smartlink-migrate
```

Or from CI / a jump box:

```bash
npm ci && npm run db:migrate
```

Migrations use the **unpooled** endpoint. `migrate.ts` prefers
`DIRECT_DATABASE_URL` or `DATABASE_URL_UNPOOLED`, and **refuses to run** if that
URL names a different server than `DATABASE_URL` — the check exists because a
run scoped to one database by `--env-file` can otherwise inherit a direct URL
from another `.env` and migrate the wrong server entirely.

## Required configuration

The server validates its configuration at boot and **refuses to start** on any
error. Each rule below describes a deployment that would otherwise run, serve
traffic, and be silently wrong.

| Variable | Requirement |
|---|---|
| `DATABASE_URL` | Pooled endpoint. Not a default password. `sslmode=verify-full` for a remote database. |
| `DATABASE_URL_UNPOOLED` | Direct endpoint, migrations only. Must be the same server. |
| `IP_HASH_SALT` | At least 32 random characters, not a placeholder. No raw IP is ever stored — only a salted hash, and a short salt is brute-forceable over the IP space. |
| `SMART_LINK_BASE_URL` | Must be `https://`. Session cookies are `Secure` and will not be sent over http. |
| `NODE_ENV` | `production`. Enables Secure cookies; makes `db:seed` and `db:reset` refuse to run. |
| `DESTINATION_HOST_ALLOWLIST` | Warned if unset. `*` is refused — it disables open-redirect protection (TRD §5). |
| `INTERAKT_WEBHOOK_SECRET` | Warned if unset; the capture endpoint then accepts unauthenticated events and records them as such. |

A refusal looks like this, and is the intended behaviour:

```
[config] refusing to start — production configuration is not valid:
  • IP_HASH_SALT is only 9 characters. Use at least 32 random characters…
  • SMART_LINK_BASE_URL must be https in production, got "http://…"
  • DATABASE_URL uses a well-known default password.
```

Generate a real salt with:

```bash
openssl rand -hex 32
```

## Location data (optional)

Clicks record an estimated city, region and country. It is optional: without a
database the fields read `unavailable` and redirects are unaffected.

1. Download **GeoLite City** in **GeoIP2 Binary (.mmdb)** format from MaxMind —
   not the CSV editions, which this code cannot read.
2. Extract `GeoLite2-City.mmdb` from the archive (~63 MB).
3. Place it at `data/GeoLite2-City.mmdb` and set `GEOIP_DB_PATH`.

The file is gitignored and excluded from the Docker image, so it must be
mounted or copied onto the host separately:

```
docker run -v /srv/geoip:/app/data -e GEOIP_DB_PATH=/app/data/GeoLite2-City.mmdb …
```

Notes:

- **Resolution is a local lookup.** No geolocation API is called. An external
  request would ship user IPs to a third party with no data-processing
  agreement, and add 50–200 ms to a redirect budgeted at p95 < 300 ms.
- **The database is loaded at startup**, not on the first click. Loading the
  63 MB file costs ~120 ms; without warming, the first click after every deploy
  pays it. Roughly 63 MB of resident memory — worth knowing on a small instance.
- **Behind Cloudflare or Vercel**, their geo headers are used instead and no
  database is needed. Cloudflare gives country free; city is Enterprise-only.
- **Accuracy on Indian mobile is limited.** Carriers route through regional
  gateways, so a user in a smaller city often resolves to the state capital.
  Region is the level worth trusting. The UI labels city as an estimate.
- MaxMind refreshes weekly. A year-old database drifts as ranges are
  reassigned; use the permalink from your MaxMind account for scheduled updates.

## Health checks

| Endpoint | Use |
|---|---|
| `GET /api/health` | **Liveness.** Process-only, no database. |
| `GET /api/health?deep=1` | **Readiness.** Also checks the database; 503 when unreachable. |

Point restart policies at the shallow check and load-balancer readiness at the
deep one. A database blip should take an instance out of rotation, not restart
a perfectly healthy process.

Neither endpoint reveals a version, hostname or error text.

## First deploy

1. Point `go.betindia.games` at the host (A record). Until this exists, no
   tracking link can exist at all.
2. Terminate TLS in front of the app — cookies are `Secure` in production, so
   plain http silently breaks sign-in.
3. Run migrations (above).
4. Create the first admin:
   ```bash
   npm run db:bootstrap-admin -- --email you@betindia.games --name "Your Name"
   ```
   Never run `db:seed` against production — it creates a demo publisher,
   campaign and links, which PRD §9 forbids presenting as real data. It refuses
   when `NODE_ENV=production`.
5. Confirm `GET /api/health?deep=1` returns 200.
6. Confirm `GET /c/{slug}` on a real link returns a 302 with a `Location`
   pointing at `www.betindia.bet`.

## Before real traffic

- **Upgrade the Neon plan.** On the free tier scale-to-zero cannot be disabled:
  the compute suspends after 5 minutes idle and the next query pays the wake-up.
  A measured deep health check against a suspended compute took **971 ms** — on
  a redirect endpoint that is a real person waiting. The paid plan also raises
  point-in-time recovery beyond the current 6 hours and allows IP restrictions.
- **Restrict database access.** `allowed_ips` is currently empty and
  `block_public_connections` is false, so the database accepts connections from
  any address with credentials.
- **Take a backup and test restoring it.** An untested backup is not a backup.
- **MFA is not implemented.** TRD §14 requires it for privileged users. A
  password is currently the only thing protecting a full-access account.
- **The rate limiter is in-process.** Correct on one instance; the effective
  limit multiplies by the instance count behind a load balancer. Move it to a
  shared store before scaling out.

## If you deploy behind LiteSpeed / Apache

The app sets its security headers in `src/middleware.ts`. A reverse proxy can
silently replace them, and on the current `go.betindia.games` host it does:

```
sent by the app:  default-src 'self'; script-src 'self' 'unsafe-inline';
                  frame-ancestors 'none'; object-src 'none'; base-uri 'self'; …
received by the browser:  upgrade-insecure-requests
```

Everything except `content-security-policy` survives. The result is a site with
no CSP worth the name: no `frame-ancestors`, no `object-src`, no `base-uri`,
no `form-action`.

Fix it at the proxy — either stop it setting the header so the app's own value
passes through, or set the full policy there. In `.htaccess`:

```apache
<IfModule mod_headers.c>
  # Let the application's policy through rather than replacing it
  Header unset Content-Security-Policy
  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
</IfModule>
```

Verify with:

```bash
curl -sI https://go.betindia.games/login | grep -i -e content-security -e strict-transport
```

## Scaling notes

Sessions live in the database, so multiple instances work for authentication.
Two things do not scale horizontally as written: the rate limiter above, and
CSV export, which is synchronous and capped at 50,000 rows.
