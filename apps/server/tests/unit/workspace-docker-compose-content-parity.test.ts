// W538.A — drift guard for /docker-compose.yml (workspace root).
// Local-dev infra: Postgres 17 + Redis 7. Drift here either changes
// the dev DB credentials (would break the drizzle.config DATABASE_URL
// fallback wired in W528.C) or bumps the Postgres major version
// (would force every developer to wipe their local volume).
//
//   • Postgres 17-alpine + Redis 7-alpine (intentional version pins).
//   • Server runs on host (npm run dev) so it can attach a debugger
//     and reload via tsx watch — only DB+Redis live in compose.
//   • Postgres: driftstack/driftstack credentials + driftstack DB +
//     port 5432:5432 + PGDATA at /var/lib/postgresql/data/pgdata.
//   • Redis: appendonly:yes (persistence) + port 6379:6379.
//   • Healthchecks: pg_isready + redis-cli ping (5s interval, 5s
//     timeout, 10 retries).
//   • 2 named volumes: postgres_data + redis_data.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docker-compose.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W538.A /docker-compose.yml content parity', () => {
  const body = read(LIB);

  it("Header + server-on-host framing pinned: '# Driftstack API — local dev infra.' + '# Postgres 17 + Redis 7. Server itself runs on host (npm run dev) so it can' + '# attach a debugger and reload via tsx watch.' — pinned so the local-dev-infra-only + Postgres-17 + Redis-7 + server-stays-on-host (for debugger + tsx-watch reload) commitment survives (drift to dockerising the server too would break the canonical dev workflow that relies on host-side tsx watch)", () => {
    expect(body).toMatch(/# Driftstack API — local dev infra\./);
    expect(body).toMatch(
      /# Postgres 17 \+ Redis 7\. Server itself runs on host \(npm run dev\) so it can\s*# attach a debugger and reload via tsx watch\./,
    );
  });

  it("Postgres service framing pinned: 'image: postgres:17-alpine' + 'container_name: driftstack-postgres' + 'restart: unless-stopped' + 'POSTGRES_USER: driftstack' + 'POSTGRES_PASSWORD: driftstack' + 'POSTGRES_DB: driftstack' + 'PGDATA: /var/lib/postgresql/data/pgdata' + 'ports: 5432:5432' + 'volumes: postgres_data:/var/lib/postgresql/data' — pinned so the Postgres-17-alpine + driftstack/driftstack/driftstack 3-credential (parity with drizzle.config DATABASE_URL fallback) + PGDATA-subdir + 5432-port + named-volume commitment survives (drift to a different password would break every dev's local connection; drift to a different DB name would break drizzle-kit migrations)", () => {
    expect(body).toMatch(/image: postgres:17-alpine/);
    expect(body).toMatch(/container_name: driftstack-postgres/);
    expect(body).toMatch(/restart: unless-stopped/);
    expect(body).toMatch(/POSTGRES_USER: driftstack/);
    expect(body).toMatch(/POSTGRES_PASSWORD: driftstack/);
    expect(body).toMatch(/POSTGRES_DB: driftstack/);
    expect(body).toMatch(/PGDATA: \/var\/lib\/postgresql\/data\/pgdata/);
    expect(body).toMatch(/- '5432:5432'/);
    expect(body).toMatch(/- postgres_data:\/var\/lib\/postgresql\/data/);
  });

  it("Redis service + appendonly framing pinned: 'image: redis:7-alpine' + 'container_name: driftstack-redis' + 'command: [\"redis-server\", \"--appendonly\", \"yes\"]' (persistence enabled so dev data survives restart) + 'ports: 6379:6379' + 'volumes: redis_data:/data' — pinned so the Redis-7-alpine + appendonly-yes persistence + 6379-port + named-volume commitment survives (drift to dropping --appendonly would force every dev to re-seed their local cache after each restart)", () => {
    expect(body).toMatch(/image: redis:7-alpine/);
    expect(body).toMatch(/container_name: driftstack-redis/);
    expect(body).toMatch(/command: \['redis-server', '--appendonly', 'yes'\]/);
    expect(body).toMatch(/- '6379:6379'/);
    expect(body).toMatch(/- redis_data:\/data/);
  });

  it('Healthcheck framing pinned: Postgres \'test: ["CMD-SHELL", "pg_isready -U driftstack -d driftstack"]\' + Redis \'test: ["CMD", "redis-cli", "ping"]\' + both with \'interval: 5s + timeout: 5s + retries: 10\' — pinned so the pg_isready + redis-cli-ping healthchecks + 5s/5s/10 retry budget commitment survives (drift to tighter intervals would surface false-negative health failures on cold-start; drift to looser would let test:e2e:setup miss real Postgres failures)', () => {
    expect(body).toMatch(/test: \['CMD-SHELL', 'pg_isready -U driftstack -d driftstack'\]/);
    expect(body).toMatch(/test: \['CMD', 'redis-cli', 'ping'\]/);
    expect(body).toMatch(/interval: 5s/);
    expect(body).toMatch(/timeout: 5s/);
    expect(body).toMatch(/retries: 10/);
  });

  it("Named volumes framing pinned: 'volumes: postgres_data + redis_data' (top-level declaration enables docker compose to manage volume lifecycle separately from container restart) — pinned so the 2-named-volume commitment survives (drift to anonymous volumes would lose Postgres data on container recreation)", () => {
    expect(body).toMatch(/^volumes:\s*postgres_data:\s*redis_data:/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
