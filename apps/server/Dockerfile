# Driftstack API server — production image.
#
# Multi-stage build. Stage 1 compiles the TypeScript workspace to dist/;
# stage 2 ships only the production runtime artefacts on a slim Node 22
# image. No source maps in the final image (Sentry uploads them
# separately during the deploy job).
#
# Build context is the monorepo root. The image runs the API server
# (apps/server) only; the GUI client + SDKs are not part of this image.

# ─── Stage 1: build ───────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build deps. Postgres native modules (pg, ioredis) need
# OpenSSL dev headers; node-gyp needs python + make + g++.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy lockfile + workspace manifests first for better layer caching.
# The actual source code copies in a later step so dependency
# installation isn't invalidated by source-only changes.
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json tsconfig.eslint.json ./
COPY apps/server/package.json ./apps/server/
COPY packages/api-types/package.json ./packages/api-types/
COPY packages/sdk-typescript/package.json ./packages/sdk-typescript/
COPY packages/webhook-delivery/package.json ./packages/webhook-delivery/

# `npm ci` would be ideal but our lockfile-vs-arborist behaviour is
# flaky in some environments (V-041). `npm install --no-audit` is the
# standing workaround; verify behaviour matches the lockfile via a
# downstream `npm ls` check in the deploy pipeline.
RUN npm install --no-audit --include=dev

# Copy source.
COPY apps/server ./apps/server
COPY packages/api-types ./packages/api-types
COPY packages/sdk-typescript ./packages/sdk-typescript
COPY packages/webhook-delivery ./packages/webhook-delivery

# Build api-types + webhook-delivery first (both are runtime deps of
# the server's services/durable-webhook-delivery.ts), then the server.
RUN npx tsc --build packages/api-types packages/webhook-delivery
RUN npm run build --workspace=@driftstack/server

# Prune dev dependencies for the runtime image.
RUN npm prune --omit=dev --workspaces

# ─── Stage 2: runtime ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Run as non-root.
RUN groupadd --system --gid 1001 driftstack \
  && useradd --system --uid 1001 --gid driftstack --shell /bin/false driftstack

WORKDIR /app

# Copy production node_modules + built dist + manifests.
COPY --from=builder --chown=driftstack:driftstack /app/node_modules ./node_modules
COPY --from=builder --chown=driftstack:driftstack /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=driftstack:driftstack /app/apps/server/package.json ./apps/server/
COPY --from=builder --chown=driftstack:driftstack /app/apps/server/src/db/migrations ./apps/server/src/db/migrations
COPY --from=builder --chown=driftstack:driftstack /app/packages/api-types ./packages/api-types
COPY --from=builder --chown=driftstack:driftstack /app/packages/webhook-delivery/dist ./packages/webhook-delivery/dist
COPY --from=builder --chown=driftstack:driftstack /app/packages/webhook-delivery/package.json ./packages/webhook-delivery/
# sdk-typescript was previously COPY'd at runtime but the server has
# no production imports of @driftstack/sdk (only a comment reference
# in webhook-signing.ts). Dropping the COPY closes the deploy-time
# error 'failed to compute cache key: packages/sdk-typescript/dist
# not found' that surfaced once webhook-delivery was added and the
# build cache no longer masked sdk-typescript not being explicitly
# built. Builder stage still copies sdk-typescript/package.json so
# `npm install --workspaces` resolves the workspace symlink.
COPY --from=builder --chown=driftstack:driftstack /app/package.json /app/package-lock.json ./

# Legal documents are read at server startup (V-047 LegalDocumentCatalog).
# Bundle them into the image so the catalog can hydrate without an
# external mount.
COPY --chown=driftstack:driftstack docs/legal ./docs/legal

USER driftstack

# SENTRY_RELEASE — passed in via --build-arg from the deploy
# pipeline; matches the `release` field on Sentry source-map uploads
# so error stack traces resolve to original source. No-op in dev
# (build arg unset → empty string → Sentry init treats as undefined).
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=${SENTRY_RELEASE}

# The server listens on PORT (default 7780 in dev; production deploys
# typically run behind a reverse proxy and bind to 8080 or similar).
ENV NODE_ENV=production
EXPOSE 7780

# /health is the liveness probe (process up, accepting connections).
# /ready is the readiness probe (DB + Redis + R2 reachable).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT||7780) + '/health').then(r => process.exit(r.ok?0:1)).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
