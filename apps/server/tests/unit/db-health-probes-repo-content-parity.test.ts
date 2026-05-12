// W443.C — drift guard for apps/server/src/db/health-probes-repo.ts.
// V-295b ProbesRepo for health-probe poller + status-page surface.
// Drift here either drops the COUNT(*) FILTER (WHERE ok=true/false)
// pattern (server-local fall-back to two separate queries breaks
// atomicity of the okCount/failCount snapshot) or replaces gte with
// gt on countByTargetSince (boundary probe at `since` instant gets
// dropped from the window).
//
//   • V-295b framing pinned.
//   • recordProbe: 6-field values; returning(); throws on no-row.
//   • recentForTarget: select * where target eq + desc(probedAt)
//     limit(n); map via toRow.
//   • pruneOlderThan: delete where lt(probedAt, before) returning {id};
//     returns rows.length (count).
//   • countByTargetSince framing pinned: single aggregation query —
//     COUNT(*) FILTER (WHERE ok=true) + COUNT(*) FILTER (WHERE
//     ok=false) per target + max(probed_at) overall + max(probed_at)
//     where ok=false.
//   • since boundary via gte (not gt).
//   • Number(okCount/failCount) cast from SQL string return.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/health-probes-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W443.C apps/server/src/db/health-probes-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-295b framing pinned: 'Drizzle-backed ProbesRepo.'", () => {
    expect(body).toMatch(/\/\/ V-295b — Drizzle-backed ProbesRepo\./);
  });

  it('imports: and/desc/eq/gte/lt/sql from drizzle-orm; ProbeRecordRow/ProbesRepo from services/health-probe; Database; systemHealthProbes schema', () => {
    expect(body).toMatch(/import \{ and, desc, eq, gte, lt, sql \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{ ProbeRecordRow, ProbesRepo \} from '\.\.\/services\/health-probe\.js';/,
    );
    expect(body).toMatch(/import \{ systemHealthProbes \} from '\.\/schema\.js';/);
  });

  it('ProbeDbRow type alias + toRow mapper (7 fields: id + target + probedAt + ok + latencyMs + httpStatus + errorMessage)', () => {
    expect(body).toMatch(/type ProbeDbRow = typeof systemHealthProbes\.\$inferSelect;/);
    expect(body).toMatch(
      /function toRow\(row: ProbeDbRow\): ProbeRecordRow \{\s*\n?\s*return \{\s*\n?\s*id: row\.id,\s*\n?\s*target: row\.target,\s*\n?\s*probedAt: row\.probedAt,\s*\n?\s*ok: row\.ok,\s*\n?\s*latencyMs: row\.latencyMs,\s*\n?\s*httpStatus: row\.httpStatus,\s*\n?\s*errorMessage: row\.errorMessage,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it("recordProbe: 6-field values write (target + ok + latencyMs + httpStatus + errorMessage + probedAt); returning(); throws 'system_health_probes insert returned no row' on empty", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*target: input\.target,\s*\n?\s*ok: input\.ok,\s*\n?\s*latencyMs: input\.latencyMs,\s*\n?\s*httpStatus: input\.httpStatus,\s*\n?\s*errorMessage: input\.errorMessage,\s*\n?\s*probedAt: input\.probedAt,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('system_health_probes insert returned no row'\);/,
    );
  });

  it('recentForTarget: where target eq + orderBy desc(probedAt) + limit(n); rows.map(toRow)', () => {
    expect(body).toMatch(
      /async recentForTarget\(target: string, n: number\): Promise<ProbeRecordRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(systemHealthProbes\)\s*\n?\s*\.where\(eq\(systemHealthProbes\.target, target\)\)\s*\n?\s*\.orderBy\(desc\(systemHealthProbes\.probedAt\)\)\s*\n?\s*\.limit\(n\);\s*\n?\s*return rows\.map\(toRow\);\s*\n?\s*\}/,
    );
  });

  it('pruneOlderThan: delete where lt(probedAt, before) returning {id: systemHealthProbes.id}; returns rows.length', () => {
    expect(body).toMatch(
      /async pruneOlderThan\(before: Date\): Promise<number> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.delete\(systemHealthProbes\)\s*\n?\s*\.where\(and\(lt\(systemHealthProbes\.probedAt, before\)\)\)\s*\n?\s*\.returning\(\{ id: systemHealthProbes\.id \}\);\s*\n?\s*return rows\.length;\s*\n?\s*\}/,
    );
  });

  it("countByTargetSince framing pinned: 'Single aggregation query — count ok vs not-ok per target, plus max(probed_at) overall + max(probed_at) where ok=false.'", () => {
    expect(body).toMatch(
      /\/\/ Single aggregation query — count ok vs not-ok per target, plus\s*\n?\s*\/\/ max\(probed_at\) overall \+ max\(probed_at\) where ok=false\./,
    );
  });

  it('countByTargetSince: 5-field select (target + okCount via count(*) filter ok=true + failCount filter ok=false + lastProbeAt max + lastFailureAt max filter ok=false); WHERE gte(probedAt, since) (not gt); groupBy target', () => {
    expect(body).toMatch(
      /\.select\(\{\s*\n?\s*target: systemHealthProbes\.target,\s*\n?\s*okCount: sql<string>`count\(\*\) filter \(where \$\{systemHealthProbes\.ok\} = true\)`,\s*\n?\s*failCount: sql<string>`count\(\*\) filter \(where \$\{systemHealthProbes\.ok\} = false\)`,\s*\n?\s*lastProbeAt: sql<Date>`max\(\$\{systemHealthProbes\.probedAt\}\)`,\s*\n?\s*lastFailureAt: sql<Date \| null>`max\(\$\{systemHealthProbes\.probedAt\}\) filter \(where \$\{systemHealthProbes\.ok\} = false\)`,\s*\n?\s*\}\)\s*\n?\s*\.from\(systemHealthProbes\)\s*\n?\s*\.where\(gte\(systemHealthProbes\.probedAt, since\)\)\s*\n?\s*\.groupBy\(systemHealthProbes\.target\);/,
    );
  });

  it('Output mapping: Number() coerce okCount + failCount (SQL string return); new Date() on lastProbeAt; lastFailureAt new Date() iff truthy else null', () => {
    expect(body).toMatch(
      /return rows\.map\(\(r\) => \(\{\s*\n?\s*target: r\.target,\s*\n?\s*okCount: Number\(r\.okCount\),\s*\n?\s*failCount: Number\(r\.failCount\),\s*\n?\s*lastProbeAt: new Date\(r\.lastProbeAt\),\s*\n?\s*lastFailureAt: r\.lastFailureAt \? new Date\(r\.lastFailureAt\) : null,\s*\n?\s*\}\)\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
