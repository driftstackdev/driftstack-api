// W460.C — drift guard for packages/recapture-automation/src/atlas.ts.
// V-533.B atlas builder. Drift here either drops the
// completed-only filter (in-progress/failed/cancelled runs leak
// partial data into the canonical snapshot and incident-response
// queries return wrong "should look like" values) or breaks the
// oldest-first walk for canonical snapshots (newer values get
// overwritten by older ones and the atlas drifts backwards).
//
//   • V-533.B framing pinned + 'V-533.A shipped the matrix expander
//     + dedup; this slice adds the atlas aggregation layer that
//     turns a chronological list of completed recapture runs into a
//     per-archetype stability view.'
//   • 3 operational questions framing pinned (stability across N
//     captures + canonical baseline per (archetype, iOS-version) +
//     version-transition impact for re-baselining work).
//   • 'Pure-data layer: takes already-completed RecaptureRun[] and
//     returns derived aggregates. No I/O, no service calls. The
//     runner that feeds runs in (admin route / scheduled job) is
//     V-533.C territory.'
//   • SurfaceStability 9-field with 4-value classification union
//     ('stable'|'drifting'|'erroring'|'volatile') + thresholds pinned
//     ('stable' matchRate >= 0.95 + 'erroring' errorCount/total >= 0.25
//     + 'drifting' diff-dominated + 'volatile' mixed signals).
//   • ArchetypeVersionSnapshot 4-field + surfaces Record<string,
//     {value: string|null; capturedAtMs: number}>.
//   • VersionTransitionImpact 6-field (from + to + runCount +
//     totalDiff + totalError + totalMatch).
//   • Atlas 6-field aggregate (runCount + archetypeCount +
//     stabilityByArchetype + snapshots + transitions + generatedAtMs).
//   • STABLE_THRESHOLD 0.95 + ERROR_THRESHOLD 0.25 constants.
//   • buildAtlas: completed-only filter; oldest-first snapshot walk
//     'later writes overwrite, so the final state is the most-
//     recent value per surface'; capture_error + missing_surface
//     skipped from snapshots.
//   • snapshotKey: `${archetypeId}@${iosVersion}+${safariVersion}`.
//   • classifyOutcomes inline helper for admin-route point queries.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recapture-automation/src/atlas.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W460.C packages/recapture-automation/src/atlas.ts content parity', () => {
  const body = read(LIB);

  it("V-533.B framing pinned: 'V-533.B — atlas builder.' + 'V-533.A shipped the matrix expander + dedup; this slice adds the atlas aggregation layer that turns a chronological list of completed recapture runs into a per-archetype stability view.'", () => {
    expect(body).toMatch(/\/\/ V-533\.B — atlas builder\./);
    expect(body).toMatch(
      /\/\/ Second sub-slice of V-533\. V-533\.A shipped the matrix expander \+ dedup;\s*\n?\s*\/\/ this slice adds the atlas aggregation layer that turns a chronological\s*\n?\s*\/\/ list of completed recapture runs into a per-archetype stability view\./,
    );
  });

  it("3 operational questions framing pinned: (1) 'Across the last N captures of archetype X, which surfaces are stable, drifting, or chronically erroring?' (2) 'For a given (archetype, iOS-version) pair, what's the canonical baseline value of every surface?' (3) 'Which version transitions caused the most diffs?'", () => {
    expect(body).toMatch(
      /\/\/\s+- Across the last N captures of archetype X, which surfaces are\s*\n?\s*\/\/\s+stable, drifting, or chronically erroring\?/,
    );
    expect(body).toMatch(
      /\/\/\s+- For a given \(archetype, iOS-version\) pair, what's the canonical\s*\n?\s*\/\/\s+baseline value of every surface\? \(For incident response: "what\s*\n?\s*\/\/\s+should this look like right now\?"\)/,
    );
    expect(body).toMatch(
      /\/\/\s+- Which version transitions caused the most diffs\? \(Useful for\s*\n?\s*\/\/\s+prioritising re-baselining work after Apple ships a major\.\)/,
    );
  });

  it("Pure-data layer framing pinned: 'takes already-completed RecaptureRun[] and returns derived aggregates. No I/O, no service calls. The runner that feeds runs in (admin route / scheduled job) is V-533.C territory.'", () => {
    expect(body).toMatch(
      /\/\/ Pure-data layer: takes already-completed `RecaptureRun\[\]` and returns\s*\n?\s*\/\/ derived aggregates\. No I\/O, no service calls\. The runner that feeds\s*\n?\s*\/\/ runs in \(admin route \/ scheduled job\) is V-533\.C territory\./,
    );
  });

  it("SurfaceStability 9-field + 4-value classification union ('stable'|'drifting'|'erroring'|'volatile') + classification thresholds pinned ('stable' matchRate >= 0.95 + 'drifting' < 0.95 + drift-gap + 'erroring' errorCount/totalCount >= 0.25 + 'volatile' mixed signals)", () => {
    expect(body).toMatch(
      /\*\s*Classification:\s*\n?\s*\*\s+'stable'\s+= matchRate >= 0\.95\.\s*\n?\s*\*\s+'drifting' = matchRate < 0\.95 AND drift accounts for the gap\.\s*\n?\s*\*\s+'erroring' = errorCount \/ totalCount >= 0\.25\.\s*\n?\s*\*\s+'volatile' = neither stable, drift-only, nor error-only — mixed signals\./,
    );
    expect(body).toMatch(/classification: 'stable' \| 'drifting' \| 'erroring' \| 'volatile';/);
  });

  it("ArchetypeVersionSnapshot framing pinned: 'most recent run's value where outcome was match or diff (i.e. the surface returned SOMETHING)' + 4-field with surfaces Record<string, {value: string|null; capturedAtMs: number}>", () => {
    expect(body).toMatch(
      /\/\*\* Per-\(archetype, version\) snapshot of canonical surface values\. The\s*\n?\s*\*\s*"canonical" value is the most recent run's value where outcome was\s*\n?\s*\*\s*`match` or `diff` \(i\.e\. the surface returned SOMETHING\)\. \*\//,
    );
    expect(body).toMatch(
      /export interface ArchetypeVersionSnapshot \{\s*\n?\s*archetypeId: string;\s*\n?\s*iosVersion: string;\s*\n?\s*safariVersion: string;\s*\n?\s*\/\*\* Per-surface canonical values\. \*\/\s*\n?\s*surfaces: Record<string, \{ value: string \| null; capturedAtMs: number \}>;\s*\n?\s*\}/,
    );
  });

  it("VersionTransitionImpact framing pinned: 'Useful for finding the version bumps that caused the most reference drift.' + 6-field (fromIosVersion + toIosVersion + runCount + totalDiffCount + totalErrorCount + totalMatchCount)", () => {
    expect(body).toMatch(
      /\/\*\* Per-version-transition aggregate\. Useful for finding the version\s*\n?\s*\*\s*bumps that caused the most reference drift\. \*\/\s*\n?\s*export interface VersionTransitionImpact \{\s*\n?\s*fromIosVersion: string;\s*\n?\s*toIosVersion: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Total runs covering this transition\. \*\/\s*\n?\s*runCount: number;\s*\n?\s*\/\*\* Total diffs across those runs \(sum of run\.diffCount\)\. \*\/\s*\n?\s*totalDiffCount: number;\s*\n?\s*\/\*\* Total errors across those runs \(sum of run\.errorCount\)\. \*\/\s*\n?\s*totalErrorCount: number;\s*\n?\s*\/\*\* Total matches across those runs \(sum of run\.matchCount\)\. \*\/\s*\n?\s*totalMatchCount: number;/,
    );
  });

  it("Atlas 6-field aggregate (runCount status=='completed' only + archetypeCount + stabilityByArchetype Record sorted-by-surfaceId + snapshots Record key `<archetypeId>@<iosVersion>+<safariVersion>` + transitions sorted by (from, to) + generatedAtMs)", () => {
    expect(body).toMatch(
      /export interface Atlas \{\s*\n?\s*\/\*\* Number of runs that contributed to the atlas \(status === 'completed' only\)\. \*\/\s*\n?\s*runCount: number;\s*\n?\s*\/\*\* Number of distinct archetypes the atlas covers\. \*\/\s*\n?\s*archetypeCount: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Per-\(archetype, version\) canonical snapshots\. Map key is\s*\n?\s*\*\s*`<archetypeId>@<iosVersion>\+<safariVersion>`\. \*\/\s*\n?\s*snapshots: Record<string, ArchetypeVersionSnapshot>;/,
    );
  });

  it("BuildAtlasOpts framing pinned: 'Only status === completed runs are included; in-progress / failed / cancelled runs are skipped (their data is partial or stale by definition).' + STABLE_THRESHOLD 0.95 + ERROR_THRESHOLD 0.25 constants", () => {
    expect(body).toMatch(
      /\/\*\* Runs to aggregate\. Only `status === 'completed'` runs are included;\s*\n?\s*\*\s*in-progress \/ failed \/ cancelled runs are skipped \(their data is\s*\n?\s*\*\s*partial or stale by definition\)\. \*\/\s*\n?\s*runs: readonly RecaptureRun\[\];/,
    );
    expect(body).toMatch(
      /\/\*\* Match-rate threshold above which a surface is classified `stable`\. \*\/\s*\n?\s*const STABLE_THRESHOLD = 0\.95;\s*\n?\s*\/\*\* Error-rate threshold above which a surface is classified `erroring`\. \*\/\s*\n?\s*const ERROR_THRESHOLD = 0\.25;/,
    );
  });

  it("buildAtlas determinism framing pinned: 'given the same set of runs (in any order) and the same generatedAtMs, returns the same Atlas.' + completed-only filter + 5-outcome zero-counts default + classification ordering (stable → erroring → drifting → volatile)", () => {
    expect(body).toMatch(
      /\*\s*Aggregate the supplied runs into an Atlas\. Pure function — given the\s*\n?\s*\*\s*same set of runs \(in any order\) and the same generatedAtMs, returns\s*\n?\s*\*\s*the same Atlas\./,
    );
    expect(body).toMatch(
      /const completed = opts\.runs\.filter\(\(r\) => r\.status === 'completed'\);\s*\n?\s*const generatedAtMs = opts\.generatedAtMs \?\? Date\.now\(\);/,
    );
    expect(body).toMatch(
      /const counts = archMap\.get\(cmp\.surfaceId\) \?\? \{\s*\n?\s*match: 0,\s*\n?\s*diff: 0,\s*\n?\s*capture_error: 0,\s*\n?\s*new_surface: 0,\s*\n?\s*missing_surface: 0,\s*\n?\s*\};/,
    );
    // Discrete pins for the 4-way classification (the prior single regex had
    // >5 \s*\n? groups — catastrophic-backtracking risk per the parity-test rule).
    expect(body).toMatch(/if \(matchRate >= STABLE_THRESHOLD\) \{/);
    expect(body).toMatch(/classification = 'stable';/);
    expect(body).toMatch(/\} else if \(errorRate >= ERROR_THRESHOLD\) \{/);
    expect(body).toMatch(/classification = 'erroring';/);
    // 'drifting' requires diff to dominate ALL other non-match outcomes —
    // including missing_surface, else a missing-dominant surface mislabels.
    expect(body).toMatch(/counts\.diff > counts\.capture_error/);
    expect(body).toMatch(/counts\.diff > counts\.new_surface/);
    expect(body).toMatch(/counts\.diff > counts\.missing_surface/);
    expect(body).toMatch(/classification = 'drifting';/);
    expect(body).toMatch(/classification = 'volatile';/);
  });

  it("Snapshot walk: oldest-first sort + 'Walking runs oldest-first → later writes overwrite, so the final state is the most-recent value per surface'; capture_error + missing_surface skipped from snapshot writes; capturedAtMs fallback completedAtMs ?? createdAtMs", () => {
    expect(body).toMatch(
      /const completedSorted = \[\.\.\.completed\]\.sort\(\s*\n?\s*\(a, b\) => \(a\.completedAtMs \?\? 0\) - \(b\.completedAtMs \?\? 0\),\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /if \(cmp\.outcome === 'capture_error' \|\| cmp\.outcome === 'missing_surface'\) \{\s*\n?\s*continue;\s*\n?\s*\}\s*\n?\s*\/\/ Walking runs oldest-first → later writes overwrite, so the\s*\n?\s*\/\/ final state is the most-recent value per surface\.\s*\n?\s*existing\.surfaces\[cmp\.surfaceId\] = \{\s*\n?\s*value: cmp\.recapturedValue,\s*\n?\s*capturedAtMs: run\.completedAtMs \?\? run\.createdAtMs,\s*\n?\s*\};/,
    );
  });

  it('Transition impact aggregation: key `${fromIosVersion}→${toIosVersion}` + zero-defaults runCount/totalDiff/totalError/totalMatch + sort by (fromIosVersion, toIosVersion) localeCompare; snapshotKey: `${archetypeId}@${iosVersion}+${safariVersion}`', () => {
    expect(body).toMatch(
      /const key = `\$\{fromIosVersion\}→\$\{toIosVersion\}`;\s*\n?\s*const existing = transitionMap\.get\(key\) \?\? \{\s*\n?\s*fromIosVersion,\s*\n?\s*toIosVersion,\s*\n?\s*runCount: 0,\s*\n?\s*totalDiffCount: 0,\s*\n?\s*totalErrorCount: 0,\s*\n?\s*totalMatchCount: 0,\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const transitions = \[\.\.\.transitionMap\.values\(\)\]\.sort\(\(a, b\) => \{\s*\n?\s*const fromCmp = a\.fromIosVersion\.localeCompare\(b\.fromIosVersion\);\s*\n?\s*if \(fromCmp !== 0\) return fromCmp;\s*\n?\s*return a\.toIosVersion\.localeCompare\(b\.toIosVersion\);\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /function snapshotKey\(run: RecaptureRun\): string \{\s*\n?\s*return `\$\{run\.archetypeId\}@\$\{run\.targetVersion\.iosVersion\}\+\$\{run\.targetVersion\.safariVersion\}`;\s*\n?\s*\}/,
    );
  });

  it("classifyOutcomes inline helper framing pinned: 'classify ONE surface's outcomes inline without going through buildAtlas. Useful for admin-route point queries.' + total === 0 → 'volatile' early return + same threshold ordering as buildAtlas", () => {
    expect(body).toMatch(
      /\/\*\* Convenience: classify ONE surface's outcomes inline without going\s*\n?\s*\*\s*through buildAtlas\. Useful for admin-route point queries\. \*\/\s*\n?\s*export function classifyOutcomes\(counts: \{\s*\n?\s*match: number;\s*\n?\s*diff: number;\s*\n?\s*capture_error: number;\s*\n?\s*new_surface: number;\s*\n?\s*missing_surface: number;\s*\n?\s*\}\): SurfaceStability\['classification'\] \{/,
    );
    // Discrete pins (avoids the >5 \s*\n? backtracking risk); same threshold
    // ordering as buildAtlas, with drifting also gated on missing_surface.
    expect(body).toMatch(/if \(total === 0\) return 'volatile';/);
    expect(body).toMatch(/const matchRate = counts\.match \/ total;/);
    expect(body).toMatch(/const errorRate = counts\.capture_error \/ total;/);
    expect(body).toMatch(/if \(matchRate >= STABLE_THRESHOLD\) return 'stable';/);
    expect(body).toMatch(/if \(errorRate >= ERROR_THRESHOLD\) return 'erroring';/);
    expect(body).toMatch(/return 'drifting';/);
    expect(body).toMatch(/return 'volatile';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
