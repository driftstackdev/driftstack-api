// W1001 — db/health-probes-repo V-295b cross-source invariant. Three-
// hundred-twenty-seventh in the drift-guard series. Pins the apps/
// server/src/db/health-probes-repo.ts Drizzle health-probe repo:
//
//   V-295b anchor — 'V-295b — Drizzle-backed ProbesRepo'.
//
//   DrizzleProbesRepo 4-method surface — recordProbe + recentForTarget
//     + pruneOlderThan + countByTargetSince.
//
//   recordProbe 6-field values — target + ok + latencyMs + httpStatus
//     + errorMessage + probedAt.
//
//   recentForTarget desc(probedAt) limit-n.
//
//   pruneOlderThan returns rows.length via returning({id}) — caller
//   gets the count of pruned rows for reporting.
//
//   countByTargetSince framing — 'Single aggregation query — count ok
//   vs not-ok per target, plus max(probed_at) overall + max(probed_at)
//   where ok=false'.
//
//   countByTargetSince 4 aggregation expressions:
//     - okCount: count(*) filter where ok=true.
//     - failCount: count(*) filter where ok=false.
//     - lastProbeAt: max(probedAt).
//     - lastFailureAt: max(probedAt) filter where ok=false.
//
//   countByTargetSince groupBy target + Number() coercion for count
//     fields (Postgres bigint → JS string by default).
//
//   toRow 7-field mapper — id + target + probedAt + ok + latencyMs +
//     httpStatus + errorMessage.
//
// stays in lockstep across apps/server/src/db/health-probes-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1001 db/health-probes-repo V-295b cross-source invariant', () => {
  // ─── V-295b anchor ───────────────────────────────────────────

  it("CRITICAL apps/server/src/db/health-probes-repo.ts header pins V-295b — 'V-295b — Drizzle-backed ProbesRepo'. The V-295b anchor is the probes-repo provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/\/\/ V-295b — Drizzle-backed ProbesRepo\./);
    expect(p).toMatch(/export class DrizzleProbesRepo implements ProbesRepo \{/);
  });

  // ─── 4-method surface ────────────────────────────────────────

  it('CRITICAL 4-method surface — recordProbe + recentForTarget + pruneOlderThan + countByTargetSince. The 4-method ProbesRepo covers record + read + prune + aggregate.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/async recordProbe\(input: \{/);
    expect(p).toMatch(
      /async recentForTarget\(target: string, n: number\): Promise<ProbeRecordRow\[\]> \{/,
    );
    expect(p).toMatch(/async pruneOlderThan\(before: Date\): Promise<number> \{/);
    expect(p).toMatch(/async countByTargetSince\(since: Date\):/);
  });

  // ─── recordProbe 6-field values ──────────────────────────────

  it('CRITICAL recordProbe 6-field values — target + ok + latencyMs + httpStatus + errorMessage + probedAt. The 6-field shape carries the V-295b auto-probe observation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/target: input\.target,/);
    expect(p).toMatch(/ok: input\.ok,/);
    expect(p).toMatch(/latencyMs: input\.latencyMs,/);
    expect(p).toMatch(/httpStatus: input\.httpStatus,/);
    expect(p).toMatch(/errorMessage: input\.errorMessage,/);
    expect(p).toMatch(/probedAt: input\.probedAt,/);
    expect(p).toMatch(
      /if \(!row\) throw new Error\('system_health_probes insert returned no row'\);/,
    );
  });

  // ─── recentForTarget ─────────────────────────────────────────

  it('CRITICAL recentForTarget where(eq target) + orderBy desc(probedAt) + limit(n). The desc+limit pattern is the standard recent-N query.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/\.where\(eq\(systemHealthProbes\.target, target\)\)/);
    expect(p).toMatch(/\.orderBy\(desc\(systemHealthProbes\.probedAt\)\)/);
    expect(p).toMatch(/\.limit\(n\);/);
  });

  // ─── pruneOlderThan returning length ─────────────────────────

  it("CRITICAL pruneOlderThan uses returning({id}).length to count pruned — 'rows.length'. The returning-array length is the prune-count contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/\.delete\(systemHealthProbes\)/);
    expect(p).toMatch(/\.where\(and\(lt\(systemHealthProbes\.probedAt, before\)\)\)/);
    expect(p).toMatch(/\.returning\(\{ id: systemHealthProbes\.id \}\);/);
    expect(p).toMatch(/return rows\.length;/);
  });

  // ─── countByTargetSince aggregation framing ──────────────────

  it("CRITICAL countByTargetSince framing — 'Single aggregation query — count ok vs not-ok per target, plus max(probed_at) overall + max(probed_at) where ok=false'. The single-aggregation design avoids N+1 status-board queries.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/\/\/ Single aggregation query — count ok vs not-ok per target, plus/);
    expect(p).toMatch(/\/\/ max\(probed_at\) overall \+ max\(probed_at\) where ok=false\./);
  });

  it('CRITICAL countByTargetSince 4 aggregation expressions — okCount count(*) filter (ok=true) + failCount count(*) filter (ok=false) + lastProbeAt max(probedAt) + lastFailureAt max(probedAt) filter (ok=false). The 4-aggregate set is the V-295b status-board query.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(
      /okCount: sql<string>`count\(\*\) filter \(where \$\{systemHealthProbes\.ok\} = true\)`,/,
    );
    expect(p).toMatch(
      /failCount: sql<string>`count\(\*\) filter \(where \$\{systemHealthProbes\.ok\} = false\)`,/,
    );
    expect(p).toMatch(/lastProbeAt: sql<Date>`max\(\$\{systemHealthProbes\.probedAt\}\)`,/);
    expect(p).toMatch(
      /lastFailureAt: sql<Date \| null>`max\(\$\{systemHealthProbes\.probedAt\}\) filter \(where \$\{systemHealthProbes\.ok\} = false\)`,/,
    );
  });

  it('CRITICAL countByTargetSince groupBy target + since-filter via gte. The (target, since) pairing scopes the aggregation per-target + per-time-window.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/\.where\(gte\(systemHealthProbes\.probedAt, since\)\)/);
    expect(p).toMatch(/\.groupBy\(systemHealthProbes\.target\);/);
  });

  it('CRITICAL countByTargetSince row mapper coerces okCount + failCount via Number() (Postgres bigint → JS string by default). lastProbeAt + lastFailureAt coerce via new Date(). The coercion gives JS numeric+Date types.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/okCount: Number\(r\.okCount\),/);
    expect(p).toMatch(/failCount: Number\(r\.failCount\),/);
    expect(p).toMatch(/lastProbeAt: new Date\(r\.lastProbeAt\),/);
    expect(p).toMatch(/lastFailureAt: r\.lastFailureAt \? new Date\(r\.lastFailureAt\) : null,/);
  });

  // ─── toRow 7-field mapper ────────────────────────────────────

  it('CRITICAL toRow 7-field mapper — id + target + probedAt + ok + latencyMs + httpStatus + errorMessage. The 7-field ProbeRecordRow is the service-layer shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts'));
    expect(p).toMatch(/function toRow\(row: ProbeDbRow\): ProbeRecordRow \{/);
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/target: row\.target,/);
    expect(p).toMatch(/probedAt: row\.probedAt,/);
    expect(p).toMatch(/ok: row\.ok,/);
    expect(p).toMatch(/latencyMs: row\.latencyMs,/);
    expect(p).toMatch(/httpStatus: row\.httpStatus,/);
    expect(p).toMatch(/errorMessage: row\.errorMessage,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-health-probes-repo-v295b-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
