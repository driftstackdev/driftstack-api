// W727 — Dockerfile + docker-compose.yml parity. Fifty-fourth in
// the cross-SDK drift-guard series (W649 + W675-W727).
//
// Pins TWO files governing the container production / dev infra:
//
//   apps/server/Dockerfile — multi-stage production image (Node 22-
//     bookworm-slim builder → runtime), non-root user, /health
//     HEALTHCHECK, SENTRY_RELEASE build-arg, legal/* bundled at
//     /docs/legal.
//
//   docker-compose.yml — local dev infra (Postgres 17 + Redis 7 with
//     persistent volumes + health checks).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const DOCKERFILE = resolve(REPO_ROOT, 'apps/server/Dockerfile');
const COMPOSE = resolve(REPO_ROOT, 'docker-compose.yml');

describe('W727 Dockerfile + docker-compose.yml parity', () => {
  it('both files exist at canonical paths', () => {
    expect(existsSync(DOCKERFILE)).toBe(true);
    expect(existsSync(COMPOSE)).toBe(true);
  });

  // --- Dockerfile -------------------------------------------------

  it('CRITICAL Dockerfile multi-stage shape pinned — `FROM node:22-bookworm-slim AS builder` + `FROM node:22-bookworm-slim AS runtime`. Drift to single-stage would 3× the image size; drift to a different base would change glibc compat.', () => {
    const d = read(DOCKERFILE);
    expect(d).toMatch(/FROM node:22-bookworm-slim AS builder/);
    expect(d).toMatch(/FROM node:22-bookworm-slim AS runtime/);
  });

  it('CRITICAL builder stage installs build deps (python3 + make + g++ + openssl + ca-certificates) and cleans apt lists. Drift to dropping g++ would break native pg/ioredis builds; drift to skipping rm -rf /var/lib/apt/lists/* would leave 30MB+ of apt cache in the builder.', () => {
    const d = read(DOCKERFILE);
    expect(d).toMatch(/python3 make g\+\+ openssl ca-certificates/);
    expect(d).toMatch(/rm -rf \/var\/lib\/apt\/lists\/\*/);
  });

  it('CRITICAL Dockerfile lockfile-cache layering — copy package.json + package-lock.json + workspace manifests BEFORE source, then run install. Drift to copying source first would bust the npm-install cache on every source-only change.', () => {
    const d = read(DOCKERFILE);

    // Manifests copied before npm install.
    expect(d).toMatch(/COPY package\.json package-lock\.json \.\//);
    expect(d).toMatch(/COPY apps\/server\/package\.json \.\/apps\/server\//);
    expect(d).toMatch(/COPY packages\/api-types\/package\.json \.\/packages\/api-types\//);
    expect(d).toMatch(
      /COPY packages\/sdk-typescript\/package\.json \.\/packages\/sdk-typescript\//,
    );

    // Order: manifests → install → source.
    const installIdx = d.indexOf('RUN npm install --no-audit --include=dev');
    const sourceCopyIdx = d.indexOf('COPY apps/server ./apps/server');
    expect(installIdx).toBeGreaterThan(0);
    expect(sourceCopyIdx).toBeGreaterThan(installIdx);
  });

  it('CRITICAL V-041 npm install workaround pinned — `npm install --no-audit --include=dev` (NOT `npm ci`). The lockfile-vs-arborist behavior is flaky; the standing workaround uses npm install. Drift to npm ci could re-introduce the flakiness.', () => {
    const d = read(DOCKERFILE);
    expect(d).toMatch(/V-041/);
    expect(d).toMatch(/npm install --no-audit --include=dev/);
  });

  it('CRITICAL build order: `npx tsc --build packages/api-types` BEFORE `npm run build --workspace=@driftstack/server`. The api-types-first order is what gives the server-build a populated dist/ on the workspace dep.', () => {
    const d = read(DOCKERFILE);

    const apiTypesIdx = d.indexOf('npx tsc --build packages/api-types');
    const serverIdx = d.indexOf('npm run build --workspace=@driftstack/server');
    expect(apiTypesIdx).toBeGreaterThan(0);
    expect(serverIdx).toBeGreaterThan(apiTypesIdx);
  });

  it('CRITICAL builder prunes dev deps via `npm prune --omit=dev --workspaces`. Drift to skipping would leave dev deps in the runtime image (~ +300MB).', () => {
    const d = read(DOCKERFILE);
    expect(d).toMatch(/npm prune --omit=dev --workspaces/);
  });

  it('CRITICAL runtime stage creates non-root `driftstack` system user with UID 1001 + GID 1001. Drift to running as root would let a compromised process write anywhere in the container.', () => {
    const d = read(DOCKERFILE);

    expect(d).toMatch(
      /groupadd --system --gid 1001 driftstack\s*\\\s*\n\s*&&\s*useradd --system --uid 1001 --gid driftstack --shell \/bin\/false driftstack/,
    );
    expect(d).toMatch(/^USER driftstack$/m);
  });

  it('CRITICAL all runtime COPY commands use `--chown=driftstack:driftstack`. Drift to dropping would leave files root-owned in a non-root container (potential permission errors at runtime).', () => {
    const d = read(DOCKERFILE);

    // Every runtime COPY has --chown=driftstack:driftstack.
    const runtimeCopies = d.match(/COPY --from=builder --chown=driftstack:driftstack/g) ?? [];
    expect(runtimeCopies.length, 'chowned builder COPYs').toBeGreaterThanOrEqual(7);

    // Legal copy from build context also chowned.
    expect(d).toMatch(/COPY --chown=driftstack:driftstack docs\/legal \.\/docs\/legal/);
  });

  it('CRITICAL V-047 legal documents bundled at /docs/legal in runtime image. The bundle is what lets LegalDocumentCatalog hydrate at startup without an external mount. Drift to dropping the COPY would crash on boot.', () => {
    const d = read(DOCKERFILE);

    expect(d).toMatch(/Legal documents are read at server startup \(V-047 LegalDocumentCatalog\)/);
    expect(d).toMatch(/Bundle them into the image so the catalog can hydrate without an/);
    expect(d).toMatch(/external mount/);
    expect(d).toMatch(/COPY --chown=driftstack:driftstack docs\/legal \.\/docs\/legal/);
  });

  it('CRITICAL SENTRY_RELEASE ARG → ENV propagation pinned with `""` default. Drift to dropping the default would crash builds without the build-arg (e.g. local dev `docker build` without --build-arg).', () => {
    const d = read(DOCKERFILE);

    expect(d).toMatch(/^ARG SENTRY_RELEASE=""$/m);
    expect(d).toMatch(/^ENV SENTRY_RELEASE=\$\{SENTRY_RELEASE\}$/m);
  });

  it('CRITICAL NODE_ENV=production pinned in the runtime stage. Drift to dropping would let Express/Fastify ship dev-only middleware to production.', () => {
    const d = read(DOCKERFILE);
    expect(d).toMatch(/^ENV NODE_ENV=production$/m);
  });

  it('CRITICAL EXPOSE 7780 pinned. The 7780 port is the default API listen port; drift to a different EXPOSE would mismatch what deploy.yml + docker-compose expects.', () => {
    const d = read(DOCKERFILE);
    expect(d).toMatch(/^EXPOSE 7780$/m);
  });

  it('CRITICAL HEALTHCHECK shape pinned — interval 10s + timeout 3s + start-period 20s + retries 3 + `node -e fetch /health`. Drift to dropping start-period would mark the container unhealthy during cold-start (20s startup budget).', () => {
    const d = read(DOCKERFILE);

    expect(d).toMatch(/HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3/);
    expect(d).toMatch(
      /node -e "fetch\('http:\/\/127\.0\.0\.1:' \+ \(process\.env\.PORT\|\|7780\) \+ '\/health'\)\.then\(r => process\.exit\(r\.ok\?0:1\)\)\.catch\(\(\) => process\.exit\(1\)\)"/,
    );
  });

  it('CRITICAL HEALTHCHECK uses /health for liveness (NOT /ready). The /health probe checks "process up, accepting connections"; /ready additionally checks DB + Redis + R2 reachability. Using /ready for healthcheck would let cold-DB blips force container restarts.', () => {
    const d = read(DOCKERFILE);
    expect(d).toMatch(/\/health is the liveness probe \(process up, accepting connections\)\./);
    expect(d).toMatch(/\/ready is the readiness probe \(DB \+ Redis \+ R2 reachable\)\./);
  });

  it('CRITICAL CMD pinned — `["node", "apps/server/dist/index.js"]`. Drift to a shell-form CMD would break PID-1 signal handling.', () => {
    const d = read(DOCKERFILE);
    expect(d).toMatch(/CMD \["node", "apps\/server\/dist\/index\.js"\]/);
  });

  it('CRITICAL Dockerfile preserves only production artifacts in runtime (node_modules + dist + migrations + api-types + sdk dist + package.json + legal). Drift to copying source code would leak source maps + unused files into production.', () => {
    const d = read(DOCKERFILE);

    // 7-line copy roster from builder stage.
    expect(d).toMatch(/\/app\/node_modules \.\/node_modules/);
    expect(d).toMatch(/\/app\/apps\/server\/dist \.\/apps\/server\/dist/);
    expect(d).toMatch(/\/app\/apps\/server\/package\.json \.\/apps\/server\//);
    expect(d).toMatch(
      /\/app\/apps\/server\/src\/db\/migrations \.\/apps\/server\/src\/db\/migrations/,
    );
    expect(d).toMatch(/\/app\/packages\/api-types \.\/packages\/api-types/);
    expect(d).toMatch(/\/app\/packages\/sdk-typescript\/dist \.\/packages\/sdk-typescript\/dist/);
    expect(d).toMatch(
      /\/app\/packages\/sdk-typescript\/package\.json \.\/packages\/sdk-typescript\//,
    );
    expect(d).toMatch(/\/app\/package\.json \/app\/package-lock\.json \.\//);
  });

  // --- docker-compose.yml -----------------------------------------

  it('CRITICAL docker-compose.yml is LOCAL DEV ONLY — server is NOT in the compose stack (runs on host). Drift to adding the server would couple dev workflow to docker rebuild cycles.', () => {
    const c = read(COMPOSE);
    expect(c).toMatch(/Driftstack API — local dev infra/);
    expect(c).toMatch(/Server itself runs on host \(npm run dev\) so it can/);
    expect(c).toMatch(/attach a debugger and reload via tsx watch/);
  });

  it('CRITICAL Postgres 17-alpine service pinned with persistent volume + canonical creds. Drift to a different image would mismatch what CI uses (W723); drift to a non-persistent volume would lose dev data on `docker compose down`.', () => {
    const c = read(COMPOSE);
    expect(c).toMatch(/image: postgres:17-alpine/);
    expect(c).toMatch(/container_name: driftstack-postgres/);
    expect(c).toMatch(/POSTGRES_USER: driftstack/);
    expect(c).toMatch(/POSTGRES_PASSWORD: driftstack/);
    expect(c).toMatch(/POSTGRES_DB: driftstack/);
    expect(c).toMatch(/PGDATA: \/var\/lib\/postgresql\/data\/pgdata/);
    expect(c).toMatch(/volumes:\s*\n\s*- postgres_data:\/var\/lib\/postgresql\/data/);
  });

  it('CRITICAL Redis 7-alpine service pinned with `--appendonly yes` + persistent volume. The appendonly mode is what gives dev a persistent Redis (drift to dropping would lose Redis state on container restart).', () => {
    const c = read(COMPOSE);
    expect(c).toMatch(/image: redis:7-alpine/);
    expect(c).toMatch(/container_name: driftstack-redis/);
    expect(c).toMatch(/command: \['redis-server', '--appendonly', 'yes'\]/);
    expect(c).toMatch(/volumes:\s*\n\s*- redis_data:\/data/);
  });

  it('CRITICAL both services use `restart: unless-stopped` (PG) / pinned ports + health checks. The unless-stopped policy is what lets `docker compose up -d` survive system restarts during dev.', () => {
    const c = read(COMPOSE);

    expect(c).toMatch(/postgres:\s*\n[\s\S]{0,200}restart: unless-stopped/);
    expect(c).toMatch(/redis:\s*\n[\s\S]{0,200}restart: unless-stopped/);
  });

  it('CRITICAL port mappings pinned — Postgres 5432:5432 + Redis 6379:6379. Drift to different ports would mismatch DATABASE_URL/REDIS_URL in .env defaults.', () => {
    const c = read(COMPOSE);

    expect(c).toMatch(/- '5432:5432'/);
    expect(c).toMatch(/- '6379:6379'/);
  });

  it('CRITICAL health checks match CI image health-cmds — pg_isready + redis-cli ping (same 5s/5s/10 interval/timeout/retries as W723 CI services).', () => {
    const c = read(COMPOSE);

    expect(c).toMatch(/test: \['CMD-SHELL', 'pg_isready -U driftstack -d driftstack'\]/);
    expect(c).toMatch(/test: \['CMD', 'redis-cli', 'ping'\]/);

    // 2 healthcheck blocks each with same interval/timeout/retries.
    const intervals = (c.match(/interval: 5s/g) ?? []).length;
    expect(intervals, 'health interval 5s').toBe(2);

    const retries = (c.match(/retries: 10/g) ?? []).length;
    expect(retries, 'health retries 10').toBe(2);
  });

  it('CRITICAL named volumes (postgres_data + redis_data) declared at root `volumes:` block. Drift to anonymous volumes would let `docker compose down -v` accidentally wipe data without operator awareness.', () => {
    const c = read(COMPOSE);
    expect(c).toMatch(/^volumes:\s*\n\s*postgres_data:\s*\n\s*redis_data:/m);
  });

  it('Dockerfile + compose 5-invariant cluster — multi-stage Node 22 + non-root user + V-047 legal bundle + HEALTHCHECK 10s/3s/20s/3 + V-041 npm install + Postgres 17 + Redis 7 + named volumes.', () => {
    const d = read(DOCKERFILE);
    const c = read(COMPOSE);

    expect(d).toMatch(/node:22-bookworm-slim AS builder/);
    expect(d).toMatch(/USER driftstack/);
    expect(d).toMatch(/V-047/);
    expect(d).toMatch(/HEALTHCHECK --interval=10s/);
    expect(d).toMatch(/V-041/);

    expect(c).toMatch(/postgres:17-alpine/);
    expect(c).toMatch(/redis:7-alpine/);
    expect(c).toMatch(/postgres_data:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/dockerfile-compose-parity.test.ts')),
    ).toBe(true);
  });
});
