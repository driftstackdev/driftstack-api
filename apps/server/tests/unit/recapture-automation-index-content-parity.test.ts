// W456.A — drift guard for packages/recapture-automation/src/index.ts.
// @driftstack/recapture-automation public surface barrel spanning
// V-533.{A,B,C} sub-slices. Drift here either drops a sub-slice
// export (consumers building against the package break mid-refactor
// when the named helper disappears) or accidentally re-exports an
// internal helper not meant for public consumption.
//
//   • header framing pinned.
//   • core types: 8 type re-exports from ./types (FingerprintComparison
//     + outcome + IosArchetypeVersion + IosVersionTransition +
//     RecaptureRun + RecaptureStatus + RecaptureTrigger +
//     TriggerRecaptureOpts).
//   • core interfaces: 4 (IosVersionWatcher + ListRunsOpts +
//     ListRunsPage + RecaptureService).
//   • mocks: 2 value exports + 2 mock deps types (
//     MockIosVersionWatcher + MockRecaptureService +
//     MockIosVersionWatcherDeps + MockRecaptureServiceDeps).
//   • V-533.A matrix: 2 types (CaptureMatrixSpec + ComparisonSummary)
//     + 4 value exports (dedupComparisons + expandCaptureMatrix +
//     groupComparisonsByCategory + summarizeComparisons).
//   • V-533.B atlas: 5 types (ArchetypeVersionSnapshot + Atlas +
//     BuildAtlasOpts + SurfaceStability + VersionTransitionImpact) +
//     2 value exports (buildAtlas + classifyOutcomes).
//   • V-533.C scheduler: 5 types + 1 value export
//     (scheduleRecaptureBatch).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recapture-automation/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W456.A packages/recapture-automation/src/index.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: '@driftstack/recapture-automation public surface.'", () => {
    expect(body).toMatch(/\/\/ @driftstack\/recapture-automation public surface\./);
  });

  it('8 core type re-exports from ./types.js (FingerprintComparison + FingerprintComparisonOutcome + IosArchetypeVersion + IosVersionTransition + RecaptureRun + RecaptureStatus + RecaptureTrigger + TriggerRecaptureOpts)', () => {
    expect(body).toMatch(
      /export type \{\s*FingerprintComparison,\s*FingerprintComparisonOutcome,\s*IosArchetypeVersion,\s*IosVersionTransition,\s*RecaptureRun,\s*RecaptureStatus,\s*RecaptureTrigger,\s*TriggerRecaptureOpts,\s*\} from '\.\/types\.js';/,
    );
  });

  it('4 core interface re-exports from ./interfaces.js (IosVersionWatcher + ListRunsOpts + ListRunsPage + RecaptureService)', () => {
    expect(body).toMatch(
      /export type \{\s*IosVersionWatcher,\s*ListRunsOpts,\s*ListRunsPage,\s*RecaptureService,\s*\} from '\.\/interfaces\.js';/,
    );
  });

  it('Mock value+type exports from ./mock.js: 2 value (MockIosVersionWatcher + MockRecaptureService) + 2 type (MockIosVersionWatcherDeps + MockRecaptureServiceDeps)', () => {
    expect(body).toMatch(
      /export \{\s*MockIosVersionWatcher,\s*MockRecaptureService,\s*type MockIosVersionWatcherDeps,\s*type MockRecaptureServiceDeps,\s*\} from '\.\/mock\.js';/,
    );
  });

  it("V-533.A framing pinned 'capture matrix runner + dedup' + 2 type re-exports (CaptureMatrixSpec + ComparisonSummary) + 4 value exports (dedupComparisons + expandCaptureMatrix + groupComparisonsByCategory + summarizeComparisons)", () => {
    expect(body).toMatch(/\/\/ V-533\.A — capture matrix runner \+ dedup\./);
    expect(body).toMatch(
      /export type \{ CaptureMatrixSpec, ComparisonSummary \} from '\.\/matrix\.js';/,
    );
    expect(body).toMatch(
      /export \{\s*dedupComparisons,\s*expandCaptureMatrix,\s*groupComparisonsByCategory,\s*summarizeComparisons,\s*\} from '\.\/matrix\.js';/,
    );
  });

  it("V-533.B framing pinned 'atlas builder' + 5 type re-exports (ArchetypeVersionSnapshot + Atlas + BuildAtlasOpts + SurfaceStability + VersionTransitionImpact) + 2 value exports (buildAtlas + classifyOutcomes)", () => {
    expect(body).toMatch(/\/\/ V-533\.B — atlas builder\./);
    expect(body).toMatch(
      /export type \{\s*ArchetypeVersionSnapshot,\s*Atlas,\s*BuildAtlasOpts,\s*SurfaceStability,\s*VersionTransitionImpact,\s*\} from '\.\/atlas\.js';/,
    );
    expect(body).toMatch(/export \{ buildAtlas, classifyOutcomes \} from '\.\/atlas\.js';/);
  });

  it("V-533.C framing pinned 'recapture scheduler' + 5 type re-exports (ArchetypeRunHistory + SchedulePriority + ScheduleEntry + ScheduleRecaptureBatchOpts + ScheduleRecaptureBatchResult) + scheduleRecaptureBatch value export", () => {
    expect(body).toMatch(/\/\/ V-533\.C — recapture scheduler\./);
    expect(body).toMatch(
      /export type \{\s*ArchetypeRunHistory,\s*SchedulePriority,\s*ScheduleEntry,\s*ScheduleRecaptureBatchOpts,\s*ScheduleRecaptureBatchResult,\s*\} from '\.\/scheduler\.js';/,
    );
    expect(body).toMatch(/export \{ scheduleRecaptureBatch \} from '\.\/scheduler\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
