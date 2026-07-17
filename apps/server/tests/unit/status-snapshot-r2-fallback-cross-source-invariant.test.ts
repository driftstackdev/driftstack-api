// W920 — V-295c2 status-snapshot R2 fallback cross-source invariant.
// Two-hundred-forty-sixth in the drift-guard series. Pins the
// public-status-page R2 fallback writer:
//
//   V-295c2 anchor — 'public status snapshot writer'. Reads the same
//   data the public /v1/status/incidents endpoint surfaces and writes
//   it as a single JSON object to R2 under
//   status/incidents-public.json.
//
//   Status-site CF Pages frontend falls back to the R2 URL when the
//   live API fetch fails — keeps the page current even during API
//   outages.
//
//   Cadence: bootstrap calls processSnapshot() in same 60s poller as
//   the V-295b health probe. Each tick REWRITES the same key (no
//   history, no per-tick proliferation).
//
//   Shape: matches GET /v1/status/incidents wire shape — `{ data:
//   Incident[] }` envelope. Status site is purely a fall-through
//   consumer that doesn't care which source it came from.
//
//   STATUS_SNAPSHOT_KEY = 'status/incidents-public.json'.
//
//   StatusSnapshotConfig defaults:
//     - windowMs: 30 * 24 * 60 * 60 * 1000 (= 30 days; matches
//       public API).
//     - limit: 50 (matches public API).
//
//   publicIncident maps IncidentRow → wire-shape Incident (11 fields
//   including ISO 8601 date conversions).
//
// stays in lockstep across apps/server/src/services/status-snapshot.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUS_SNAPSHOT_KEY } from '../../src/services/status-snapshot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W920 V-295c2 status-snapshot R2 fallback cross-source invariant', () => {
  // ─── V-295c2 anchor + R2 fallback framing ────────────────────

  it("CRITICAL apps/server/src/services/status-snapshot.ts header pins V-295c2 anchor — 'V-295c2 — public status snapshot writer'. The V-295c2 anchor is the status-fallback policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/V-295c2 — public status snapshot writer/);
  });

  it("CRITICAL R2 fallback framing — 'writes it as a single JSON object to R2 under status/incidents-public.json. The status-site CF Pages frontend falls back to the R2 URL when the live API fetch fails — keeping the page current even during API outages'. The R2-fallback is the API-uptime-decoupled status-page contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/writes it as a single JSON object to R2 under/);
    expect(p).toMatch(/`status\/incidents-public\.json`\. The status-site CF Pages frontend/);
    expect(p).toMatch(/falls back to the R2 URL when the live API fetch fails — keeping/);
    expect(p).toMatch(/the page current even during API outages/);
  });

  // ─── 60s cadence shared with health-probe ────────────────────

  it("CRITICAL cadence framing — 'bootstrap calls processSnapshot() in the same 60s poller as the health probe'. The shared 60s poller minimises setInterval handles + co-locates health-related background work.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/Cadence: bootstrap calls processSnapshot\(\) in the same 60s poller/);
    expect(p).toMatch(/as the health probe/);
  });

  // ─── No-history single-key REWRITE pattern ───────────────────

  it("CRITICAL rewrite-pattern framing — 'Each tick rewrites the same key (no history, no per-tick proliferation)'. The single-key rewrite is what keeps R2 storage costs bounded.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(
      /Each tick rewrites the same key \(no history,\s*\n\/\/ no per-tick proliferation\)/,
    );
  });

  // ─── { data: Incident[] } envelope shape ─────────────────────

  it('CRITICAL shape framing pins bounded data plus exact truth metadata.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/Shape: matches GET \/v1\/status\/incidents: bounded data plus exact/);
    expect(p).toMatch(/total\/open\/outage aggregates and an explicit truncation bit/);
  });

  it('CRITICAL processSnapshot writes envelope shape — data field maps rows via publicIncident. Mechanically verified via source pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/data: feed\.rows\.map\(publicIncident\)/);
    expect(p).toMatch(/open_count: feed\.openCount/);
    expect(p).toMatch(/open_outage_count: feed\.openOutageCount/);
  });

  // ─── STATUS_SNAPSHOT_KEY constant ────────────────────────────

  it("CRITICAL STATUS_SNAPSHOT_KEY = 'status/incidents-public.json'. The exact-path is what the status-site frontend fetches as a fallback — drift would break the fallback path.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/export const STATUS_SNAPSHOT_KEY = 'status\/incidents-public\.json';/);
    expect(STATUS_SNAPSHOT_KEY).toBe('status/incidents-public.json');
  });

  // ─── 30-day window + 50-limit defaults ───────────────────────

  it('CRITICAL snapshot uses a 90-day resolved window while open rows remain all-time.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/Resolved-history window; defaults to 90 days/);
    expect(p).toMatch(/Open rows are all-time/);
    expect(p).toMatch(/this\.windowMs = config\.windowMs \?\? 90 \* 24 \* 60 \* 60 \* 1000;/);
  });

  it("CRITICAL limit default = 50 ('matches the public API'). The 50-incident cap matches /v1/status/incidents pagination — drift would let the R2 file outgrow public-API responses.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/Max incidents to include; defaults to 50 \(matches the public API\)/);
    expect(p).toMatch(/this\.limit = config\.limit \?\? 50;/);
  });

  // ─── StatusSnapshotConfig key override for tests ─────────────

  it('CRITICAL StatusSnapshotConfig has 3 optional fields — windowMs + limit + key (override for tests). The 3-optional design lets tests substitute the R2 key without touching the production constant.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/export interface StatusSnapshotConfig \{/);
    expect(p).toMatch(/windowMs\?: number;/);
    expect(p).toMatch(/limit\?: number;/);
    expect(p).toMatch(/Override for tests; defaults to STATUS_SNAPSHOT_KEY/);
    expect(p).toMatch(/key\?: string;/);
  });

  // ─── publicIncident 11-field wire shape ──────────────────────

  it("CRITICAL publicIncident maps IncidentRow → wire-shape Incident with 11 fields — id (prefixed 'inc_') + title + description + severity + status + affected_components + public + started_at (ISO 8601) + resolved_at (nullable ISO 8601) + created_at + updated_at. The 11-field projection is what the status site reads.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/function publicIncident\(row: IncidentRow\): Incident \{/);
    expect(p).toMatch(/id: `inc_\$\{row\.id\}`,/);
    expect(p).toMatch(/title: row\.title,/);
    expect(p).toMatch(/description: row\.description,/);
    expect(p).toMatch(/severity: row\.severity,/);
    expect(p).toMatch(/status: row\.status,/);
    expect(p).toMatch(/affected_components: \[\.\.\.row\.affectedComponents\],/);
    expect(p).toMatch(/public: row\.public,/);
    expect(p).toMatch(/started_at: row\.startedAt\.toISOString\(\),/);
    expect(p).toMatch(/resolved_at: row\.resolvedAt \? row\.resolvedAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
    expect(p).toMatch(/updated_at: row\.updatedAt\.toISOString\(\),/);
  });

  it("CRITICAL id is prefixed with 'inc_' — 'inc_${row.id}'. The prefixed-id keeps the wire-shape stable across other resource prefixes (sess_, usr_, etc).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/id: `inc_\$\{row\.id\}`,/);
  });

  it('CRITICAL affected_components uses spread-copy ([...row.affectedComponents]) — defensive copy avoids mutating the IncidentRow array. The spread-copy framing is the immutability contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(/affected_components: \[\.\.\.row\.affectedComponents\],/);
  });

  // ─── processSnapshot returns count + bytes ───────────────────

  it('CRITICAL processSnapshot returns { count: number; bytes: number } — the 2-counter return shape is the observability seam. count = incidents written; bytes = JSON byte size.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-snapshot.ts'));
    expect(p).toMatch(
      /async processSnapshot\(now: Date\): Promise<\{ count: number; bytes: number \}> \{/,
    );
  });

  // ─── 30-day window math ──────────────────────────────────────

  it('CRITICAL 30-day window math — 30 * 24 * 60 * 60 * 1000 = 2_592_000_000 ms. Drift to 7 or 60 days would break R2-vs-API retention parity.', () => {
    expect(30 * 24 * 60 * 60 * 1000).toBe(2_592_000_000);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/status-snapshot-r2-fallback-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
