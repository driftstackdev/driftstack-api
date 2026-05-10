// V-533.B — atlas builder.
//
// Second sub-slice of V-533. V-533.A shipped the matrix expander + dedup;
// this slice adds the atlas aggregation layer that turns a chronological
// list of completed recapture runs into a per-archetype stability view.
//
// The atlas answers operational questions that any single run can't:
//
//   - Across the last N captures of archetype X, which surfaces are
//     stable, drifting, or chronically erroring?
//   - For a given (archetype, iOS-version) pair, what's the canonical
//     baseline value of every surface? (For incident response: "what
//     should this look like right now?")
//   - Which version transitions caused the most diffs? (Useful for
//     prioritising re-baselining work after Apple ships a major.)
//
// Pure-data layer: takes already-completed `RecaptureRun[]` and returns
// derived aggregates. No I/O, no service calls. The runner that feeds
// runs in (admin route / scheduled job) is V-533.C territory.

import type { FingerprintComparisonOutcome, RecaptureRun } from './types.js';

/** Per-surface stability summary aggregated across the runs supplied. */
export interface SurfaceStability {
  surfaceId: string;
  /** Number of times this surface appeared with a `match` outcome. */
  matchCount: number;
  /** Number of `diff` outcomes — drift, but the surface returns a value. */
  diffCount: number;
  /** Number of `capture_error` outcomes — surface couldn't be captured. */
  errorCount: number;
  /** Number of `new_surface` outcomes — surface appeared in a capture but
   *  wasn't in the baseline at that time. */
  newSurfaceCount: number;
  /** Number of `missing_surface` outcomes — baseline had it, capture didn't. */
  missingSurfaceCount: number;
  /** Total appearances (sum of all above). */
  totalCount: number;
  /** Match rate in [0, 1] (matchCount / totalCount). */
  matchRate: number;
  /** Classification:
   *    'stable'   = matchRate >= 0.95.
   *    'drifting' = matchRate < 0.95 AND drift accounts for the gap.
   *    'erroring' = errorCount / totalCount >= 0.25.
   *    'volatile' = neither stable, drift-only, nor error-only — mixed signals. */
  classification: 'stable' | 'drifting' | 'erroring' | 'volatile';
}

/** Per-(archetype, version) snapshot of canonical surface values. The
 *  "canonical" value is the most recent run's value where outcome was
 *  `match` or `diff` (i.e. the surface returned SOMETHING). */
export interface ArchetypeVersionSnapshot {
  archetypeId: string;
  iosVersion: string;
  safariVersion: string;
  /** Per-surface canonical values. */
  surfaces: Record<string, { value: string | null; capturedAtMs: number }>;
}

/** Per-version-transition aggregate. Useful for finding the version
 *  bumps that caused the most reference drift. */
export interface VersionTransitionImpact {
  fromIosVersion: string;
  toIosVersion: string;
  /** Total runs covering this transition. */
  runCount: number;
  /** Total diffs across those runs (sum of run.diffCount). */
  totalDiffCount: number;
  /** Total errors across those runs (sum of run.errorCount). */
  totalErrorCount: number;
  /** Total matches across those runs (sum of run.matchCount). */
  totalMatchCount: number;
}

/** Aggregate atlas across all runs supplied to the builder. */
export interface Atlas {
  /** Number of runs that contributed to the atlas (status === 'completed' only). */
  runCount: number;
  /** Number of distinct archetypes the atlas covers. */
  archetypeCount: number;
  /** Per-archetype surface stability. Map key is archetypeId; value is a
   *  sorted-by-surfaceId list of SurfaceStability entries. */
  stabilityByArchetype: Record<string, readonly SurfaceStability[]>;
  /** Per-(archetype, version) canonical snapshots. Map key is
   *  `<archetypeId>@<iosVersion>+<safariVersion>`. */
  snapshots: Record<string, ArchetypeVersionSnapshot>;
  /** Per-version-transition aggregate, sorted by (fromIosVersion,
   *  toIosVersion). */
  transitions: readonly VersionTransitionImpact[];
  /** Generation timestamp (ms epoch). */
  generatedAtMs: number;
}

export interface BuildAtlasOpts {
  /** Runs to aggregate. Only `status === 'completed'` runs are included;
   *  in-progress / failed / cancelled runs are skipped (their data is
   *  partial or stale by definition). */
  runs: readonly RecaptureRun[];
  /** Optional override for the generation timestamp; defaults to
   *  Date.now(). Useful for deterministic tests. */
  generatedAtMs?: number;
}

/** Match-rate threshold above which a surface is classified `stable`. */
const STABLE_THRESHOLD = 0.95;
/** Error-rate threshold above which a surface is classified `erroring`. */
const ERROR_THRESHOLD = 0.25;

/**
 * Aggregate the supplied runs into an Atlas. Pure function — given the
 * same set of runs (in any order) and the same generatedAtMs, returns
 * the same Atlas.
 */
export function buildAtlas(opts: BuildAtlasOpts): Atlas {
  const completed = opts.runs.filter((r) => r.status === 'completed');
  const generatedAtMs = opts.generatedAtMs ?? Date.now();

  // Stability roll-up: archetypeId → surfaceId → counts.
  const stabilityCounts = new Map<
    string,
    Map<string, Record<FingerprintComparisonOutcome, number>>
  >();
  for (const run of completed) {
    if (!stabilityCounts.has(run.archetypeId)) {
      stabilityCounts.set(run.archetypeId, new Map());
    }
    const archMap = stabilityCounts.get(run.archetypeId);
    if (!archMap) continue;
    for (const cmp of run.comparisons) {
      const counts = archMap.get(cmp.surfaceId) ?? {
        match: 0,
        diff: 0,
        capture_error: 0,
        new_surface: 0,
        missing_surface: 0,
      };
      counts[cmp.outcome] += 1;
      archMap.set(cmp.surfaceId, counts);
    }
  }

  const stabilityByArchetype: Record<string, readonly SurfaceStability[]> = {};
  for (const [archetypeId, archMap] of stabilityCounts.entries()) {
    const entries: SurfaceStability[] = [];
    for (const [surfaceId, counts] of archMap.entries()) {
      const total =
        counts.match +
        counts.diff +
        counts.capture_error +
        counts.new_surface +
        counts.missing_surface;
      const matchRate = total === 0 ? 0 : counts.match / total;
      const errorRate = total === 0 ? 0 : counts.capture_error / total;
      let classification: SurfaceStability['classification'];
      if (matchRate >= STABLE_THRESHOLD) {
        classification = 'stable';
      } else if (errorRate >= ERROR_THRESHOLD) {
        classification = 'erroring';
      } else if (counts.diff > counts.capture_error && counts.diff > counts.new_surface) {
        classification = 'drifting';
      } else {
        classification = 'volatile';
      }
      entries.push({
        surfaceId,
        matchCount: counts.match,
        diffCount: counts.diff,
        errorCount: counts.capture_error,
        newSurfaceCount: counts.new_surface,
        missingSurfaceCount: counts.missing_surface,
        totalCount: total,
        matchRate,
        classification,
      });
    }
    entries.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
    stabilityByArchetype[archetypeId] = entries;
  }

  // Snapshots: most-recent canonical value per (archetype, version, surface).
  const snapshots: Record<string, ArchetypeVersionSnapshot> = {};
  const completedSorted = [...completed].sort(
    (a, b) => (a.completedAtMs ?? 0) - (b.completedAtMs ?? 0),
  );
  for (const run of completedSorted) {
    const key = snapshotKey(run);
    const existing = snapshots[key] ?? {
      archetypeId: run.archetypeId,
      iosVersion: run.targetVersion.iosVersion,
      safariVersion: run.targetVersion.safariVersion,
      surfaces: {},
    };
    for (const cmp of run.comparisons) {
      if (cmp.outcome === 'capture_error' || cmp.outcome === 'missing_surface') {
        continue;
      }
      // Walking runs oldest-first → later writes overwrite, so the
      // final state is the most-recent value per surface.
      existing.surfaces[cmp.surfaceId] = {
        value: cmp.recapturedValue,
        capturedAtMs: run.completedAtMs ?? run.createdAtMs,
      };
    }
    snapshots[key] = existing;
  }

  // Per-transition impact (fromIosVersion → toIosVersion).
  const transitionMap = new Map<string, VersionTransitionImpact>();
  for (const run of completed) {
    const fromIosVersion = run.baselineVersion.iosVersion;
    const toIosVersion = run.targetVersion.iosVersion;
    const key = `${fromIosVersion}→${toIosVersion}`;
    const existing = transitionMap.get(key) ?? {
      fromIosVersion,
      toIosVersion,
      runCount: 0,
      totalDiffCount: 0,
      totalErrorCount: 0,
      totalMatchCount: 0,
    };
    existing.runCount += 1;
    existing.totalDiffCount += run.diffCount;
    existing.totalErrorCount += run.errorCount;
    existing.totalMatchCount += run.matchCount;
    transitionMap.set(key, existing);
  }
  const transitions = [...transitionMap.values()].sort((a, b) => {
    const fromCmp = a.fromIosVersion.localeCompare(b.fromIosVersion);
    if (fromCmp !== 0) return fromCmp;
    return a.toIosVersion.localeCompare(b.toIosVersion);
  });

  return {
    runCount: completed.length,
    archetypeCount: stabilityCounts.size,
    stabilityByArchetype,
    snapshots,
    transitions,
    generatedAtMs,
  };
}

function snapshotKey(run: RecaptureRun): string {
  return `${run.archetypeId}@${run.targetVersion.iosVersion}+${run.targetVersion.safariVersion}`;
}

/** Convenience: classify ONE surface's outcomes inline without going
 *  through buildAtlas. Useful for admin-route point queries. */
export function classifyOutcomes(counts: {
  match: number;
  diff: number;
  capture_error: number;
  new_surface: number;
  missing_surface: number;
}): SurfaceStability['classification'] {
  const total =
    counts.match + counts.diff + counts.capture_error + counts.new_surface + counts.missing_surface;
  if (total === 0) return 'volatile';
  const matchRate = counts.match / total;
  const errorRate = counts.capture_error / total;
  if (matchRate >= STABLE_THRESHOLD) return 'stable';
  if (errorRate >= ERROR_THRESHOLD) return 'erroring';
  if (counts.diff > counts.capture_error && counts.diff > counts.new_surface) return 'drifting';
  return 'volatile';
}
