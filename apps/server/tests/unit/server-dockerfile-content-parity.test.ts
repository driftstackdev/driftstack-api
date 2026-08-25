// W538.B — drift guard for apps/server/Dockerfile.
// Multi-stage production image. Drift here either breaks the V-041
// npm install workaround (would surface flaky lockfile-vs-arborist
// failures), drops the V-047 legal-document bundling (would break
// LegalDocumentCatalog hydration at server startup), or weakens the
// non-root user posture (would run prod server as root).
//
//   • Multi-stage rationale + Sentry source-map separate-upload framing.
//   • Stage 1 base: node:22-bookworm-slim AS builder.
//   • apt deps: python3 make g++ openssl ca-certificates (Postgres
//     pg native + node-gyp).
//   • V-041 'npm install --no-audit --include=dev' rationale.
//   • Build api-types first (sdk-typescript depends on it).
//   • Stage 2: non-root driftstack user (uid 1001).
//   • V-047 docs/legal bundle for LegalDocumentCatalog hydration.
//   • SENTRY_RELEASE build-arg passthrough.
//   • NODE_ENV=production + EXPOSE 7780.
//   • HEALTHCHECK fetching /health.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/Dockerfile');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W538.B apps/server/Dockerfile content parity', () => {
  const body = read(LIB);

  it("Multi-stage + Sentry sourcemap framing pinned: '# Driftstack API server — production image.' + '# Multi-stage build. Stage 1 compiles the TypeScript workspace to dist/; stage 2 ships only the production runtime artefacts on a slim Node 22 image. No source maps in the final image (Sentry uploads them separately during the deploy job).' + '# Build context is the monorepo root. The image runs the API server (apps/server) only; the GUI client + SDKs are not part of this image.' — pinned so the multi-stage + slim-Node-22 + no-source-maps-in-final-image (Sentry uploads separately during deploy) + monorepo-root-build-context + server-only (no GUI/SDKs) commitment survives", () => {
    expect(body).toMatch(/# Driftstack API server — production image\./);
    expect(body).toMatch(
      /# Multi-stage build\. Stage 1 compiles the TypeScript workspace to dist\/;\s*# stage 2 ships only the production runtime artefacts on a slim Node 22\s*# image\. No source maps in the final image \(Sentry uploads them\s*# separately during the deploy job\)\./,
    );
    expect(body).toMatch(
      /# Build context is the monorepo root\. The image runs the API server\s*# \(apps\/server\) only; the GUI client \+ SDKs are not part of this image\./,
    );
  });

  it("Stage-1 builder + apt-deps + V-041 npm-install framing pinned: 'FROM node:22-bookworm-slim AS builder' + 'WORKDIR /app' + apt-get install 'python3 make g++ openssl ca-certificates' (Postgres native + node-gyp) + 'npm install --no-audit --include=dev' with V-041 rationale: '`npm ci` would be ideal but our lockfile-vs-arborist behaviour is flaky in some environments (V-041). `npm install --no-audit` is the standing workaround; verify behaviour matches the lockfile via a downstream `npm ls` check in the deploy pipeline.' — pinned so the bookworm-slim + 5-apt-dep set + V-041 npm-install-not-ci workaround + downstream-npm-ls-verification commitment survives", () => {
    expect(body).toMatch(/FROM node:22-bookworm-slim AS builder/);
    expect(body).toMatch(/WORKDIR \/app/);
    expect(body).toMatch(
      /RUN apt-get update && apt-get install -y --no-install-recommends \\\s*python3 make g\+\+ openssl ca-certificates \\/,
    );
    expect(body).toMatch(
      /# `npm ci` would be ideal but our lockfile-vs-arborist behaviour is\s*# flaky in some environments \(V-041\)\. `npm install --no-audit` is the\s*# standing workaround; verify behaviour matches the lockfile via a\s*# downstream `npm ls` check in the deploy pipeline\./,
    );
    expect(body).toMatch(/RUN npm install --no-audit --include=dev/);
  });

  it("Build-order + prune-dev-deps framing pinned: api-types + webhook-delivery built first (both are runtime deps of services/durable-webhook-delivery.ts) + 'RUN npx tsc --build packages/api-types packages/webhook-delivery' + 'RUN npm run build --workspace=@driftstack/server' + '# Prune dev dependencies for the runtime image.' + 'RUN npm prune --omit=dev --workspaces' — pinned so the runtime-deps-built-first + server-build-via-workspace + prune-dev-deps-for-runtime commitment survives (webhook-delivery added 2026-05-15 after CI runs failed 5+ times with 'Cannot find module @driftstack/webhook-delivery')", () => {
    expect(body).toMatch(/# Build api-types \+ webhook-delivery first \(both are runtime deps of/);
    expect(body).toMatch(
      /# the server's services\/durable-webhook-delivery\.ts\), then the server\./,
    );
    expect(body).toMatch(/RUN npx tsc --build packages\/api-types packages\/webhook-delivery/);
    expect(body).toMatch(/RUN npm run build --workspace=@driftstack\/server/);
    expect(body).toMatch(/# Prune dev dependencies for the runtime image\./);
    expect(body).toMatch(/RUN npm prune --omit=dev --workspaces/);
  });

  it("Stage-2 runtime + non-root user framing pinned: 'FROM node:22-bookworm-slim AS runtime' + '# Run as non-root.' + 'RUN groupadd --system --gid 1001 driftstack && useradd --system --uid 1001 --gid driftstack --shell /bin/false driftstack' + 'USER driftstack' — pinned so the non-root-uid-1001 driftstack + /bin/false-shell (no interactive shell available even if compromised) + USER-driftstack-switch commitment survives (drift to running as root would let a server-process compromise escalate to container-root)", () => {
    expect(body).toMatch(/FROM node:22-bookworm-slim AS runtime/);
    expect(body).toMatch(/# Run as non-root\./);
    expect(body).toMatch(
      /RUN groupadd --system --gid 1001 driftstack \\\s*&& useradd --system --uid 1001 --gid driftstack --shell \/bin\/false driftstack/,
    );
    expect(body).toMatch(/USER driftstack/);
  });

  it("V-047 legal-docs bundling framing pinned: '# Legal documents are read at server startup (V-047 LegalDocumentCatalog). Bundle them into the image so the catalog can hydrate without an external mount.' + 'COPY --chown=driftstack:driftstack docs/legal ./docs/legal' — pinned so the V-047 anchor + LegalDocumentCatalog-hydration-without-external-mount commitment survives (drift to dropping this COPY would break server startup with 'LegalDocumentCatalog: docs/legal not found')", () => {
    expect(body).toMatch(
      /# Legal documents are read at server startup \(V-047 LegalDocumentCatalog\)\.\s*# Bundle them into the image so the catalog can hydrate without an\s*# external mount\./,
    );
    expect(body).toMatch(/COPY --chown=driftstack:driftstack docs\/legal \.\/docs\/legal/);
  });

  it("SENTRY_RELEASE + NODE_ENV + EXPOSE + HEALTHCHECK + CMD framing pinned: 'ARG SENTRY_RELEASE=\"\"' + 'ENV SENTRY_RELEASE=${SENTRY_RELEASE}' with deploy-pipeline pass-through rationale + 'ENV NODE_ENV=production' + 'EXPOSE 7780' (dev default; prod usually behind reverse proxy on 8080) + '/health is the liveness probe (process up, accepting connections). /ready is the readiness probe (DB + Redis + R2 reachable).' + HEALTHCHECK on /health + CMD node apps/server/dist/index.js — pinned so the Sentry-release-from-build-arg + NODE_ENV=production + 7780-port + /health-liveness-vs-/ready-readiness-distinction + node-dist-entry commitment survives", () => {
    expect(body).toMatch(/ARG SENTRY_RELEASE=""/);
    expect(body).toMatch(/ENV SENTRY_RELEASE=\$\{SENTRY_RELEASE\}/);
    expect(body).toMatch(/ENV NODE_ENV=production/);
    expect(body).toMatch(/EXPOSE 7780/);
    expect(body).toMatch(
      /# \/health is the liveness probe \(process up, accepting connections\)\.\s*# \/ready is the readiness probe \(DB \+ Redis \+ R2 reachable\)\./,
    );
    expect(body).toMatch(
      /HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \\\s*CMD node -e "fetch\('http:\/\/127\.0\.0\.1:' \+ \(process\.env\.PORT\|\|7780\) \+ '\/health'\)\.then\(r => process\.exit\(r\.ok\?0:1\)\)\.catch\(\(\) => process\.exit\(1\)\)"/,
    );
    expect(body).toMatch(/CMD \["node", "apps\/server\/dist\/index\.js"\]/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
