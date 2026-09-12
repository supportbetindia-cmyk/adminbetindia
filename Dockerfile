# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────
# BetIndia Smart Link Manager
#
# Multi-stage: the runtime image carries the traced standalone server and no
# build toolchain. Two targets:
#
#   runner   (default) — the application
#   migrator           — one-off container that applies migrations and exits
#
# Migrations are a separate target on purpose. Running them from the app's
# entrypoint races when more than one instance starts at once, and a partially
# applied schema is worse than a delayed deploy.
# ─────────────────────────────────────────────────────────────

ARG NODE_VERSION=22-alpine

# ── deps ─────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── build ────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# next build runs the app's module graph. Placeholders keep that import-time
# work happy; nothing here is baked into the image, and NODE_ENV is not
# production yet so the boot-time config check does not run.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
ENV IP_HASH_SALT="build-time-placeholder-not-used-at-runtime"

RUN npm run build

# ── migrator ─────────────────────────────────────────────────
# Full dependency tree: drizzle's migrator and tsx are not part of the traced
# standalone output.
FROM node:${NODE_VERSION} AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY drizzle ./drizzle
COPY src/db ./src/db
COPY src/lib ./src/lib
COPY tsconfig.json ./
USER node
CMD ["npx", "tsx", "src/db/migrate.ts"]

# ── runner ───────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as an unprivileged user. `node` already exists in the base image.
RUN mkdir -p /app && chown -R node:node /app

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

# Liveness only. Readiness (`?deep=1`) also checks the database and belongs to
# the orchestrator, not the container — a database blip should not restart a
# healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
