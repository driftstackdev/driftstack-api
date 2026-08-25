// W459.B — drift guard for packages/recapture-automation/src/mock.ts.
// V-179 in-memory MockRecaptureService + MockIosVersionWatcher.
// Drift here either drops the caller-driven state-machine framing
// (queued → in_progress when first recordComparison arrives) or
// breaks the per-outcome aggregate-count increment branches
// (matchCount/diffCount/etc. lose conditional increments, run
// summaries silently underreport).
//
//   • V-179 framing pinned + mock-semantics 4-bullet list:
//     triggerRecapture queued; transitions caller-driven; getRun
//     /listRuns deterministic; IosVersionWatcher in-memory.
//   • MockRecaptureServiceDeps: now test seam.
//   • triggerRecapture: id format `rcap_${padStart(8, '0')}` +
//     12-field RecaptureRun shape (status:'queued' + empty
//     comparisons + zero aggregates + startedAtMs:null +
//     completedAtMs:null + createdAtMs:now).
//   • listRuns: limit cap 200; archetypeId+status filters;
//     newest-first by createdAtMs with id-localeCompare tiebreak;
//     cursor skip via findIndex.
//   • recordComparison: throws on missing run; first call
//     transitions 'queued' → 'in_progress' + sets startedAtMs:
//     now(); appends comparison; per-outcome aggregate count
//     increment (match/diff/capture_error/new_surface/missing_surface).
//   • finalizeRun: throws on missing run; 3-state target
//     ('completed'|'failed'|'cancelled') + completedAtMs:now.
//   • MockIosVersionWatcherDeps: initialLastSeen + pendingTransitions
//     test seams.
//   • MockIosVersionWatcher: getLastSeenVersion returns lastSeen;
//     pollForTransition shifts from pending; recordTransitionHandled
//     sets lastSeen = transition.toIosVersion.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recapture-automation/src/mock.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W459.B packages/recapture-automation/src/mock.ts content parity', () => {
  const body = read(LIB);

  it("V-179 framing pinned: 'V-179 — in-memory mock implementations of RecaptureService + IosVersionWatcher. Useful for unit tests + GUI-client integration against the same surface a future production impl will satisfy.'", () => {
    expect(body).toMatch(
      /\/\/ V-179 — in-memory mock implementations of RecaptureService \+\s*\/\/ IosVersionWatcher\. Useful for unit tests \+ GUI-client integration\s*\/\/ against the same surface a future production impl will satisfy\./,
    );
  });

  it("Mock semantics framing pinned: triggerRecapture queued + 'transitions are caller-driven via recordComparison() + finalizeRun().' + getRun/listRuns deterministic (insertion order with id-tiebreaker) + IosVersionWatcher in-memory 'production impl would persist to disk or a kv store'", () => {
    expect(body).toMatch(
      /\/\/ Mock semantics:\s*\/\/ - triggerRecapture\(\) inserts a queued run; transitions are caller-\s*\/\/\s*driven via recordComparison\(\) \+ finalizeRun\(\)\.\s*\/\/ - getRun\(\) \/ listRuns\(\) are deterministic \(insertion order with\s*\/\/\s*id-tiebreaker\)\.\s*\/\/ - IosVersionWatcher state is in-memory; the production impl would\s*\/\/\s*persist to disk or a kv store\./,
    );
  });

  it("MockRecaptureServiceDeps: now test seam 'defaults to () => Date.now()'", () => {
    expect(body).toMatch(
      /export interface MockRecaptureServiceDeps \{\s*\/\*\* Test seam — defaults to \(\) => Date\.now\(\)\. \*\/\s*now\?: \(\) => number;\s*\}/,
    );
  });

  it("triggerRecapture: id format `rcap_${padStart(8, '0')}` + 12-field RecaptureRun shape (status:'queued' + empty comparisons + 5 zero aggregates + startedAtMs:null + completedAtMs:null + createdAtMs:this.now())", () => {
    expect(body).toMatch(
      /const id = `rcap_\$\{this\.idCounter\.toString\(\)\.padStart\(8, '0'\)\}`;\s*const run: RecaptureRun = \{\s*id,\s*trigger: opts\.trigger,\s*archetypeId: opts\.archetypeId,\s*baselineVersion: opts\.baselineVersion,\s*targetVersion: opts\.targetVersion,\s*status: 'queued',\s*comparisons: \[\],\s*matchCount: 0,\s*diffCount: 0,\s*errorCount: 0,\s*newSurfaceCount: 0,\s*missingSurfaceCount: 0,\s*startedAtMs: null,\s*completedAtMs: null,\s*createdAtMs: this\.now\(\),\s*\};/,
    );
  });

  it('getRun: Promise.resolve(map.get(id) ?? null); listRuns: limit cap min(opts.limit ?? 50, 200); archetypeId + status optional filters; newest-first sort by createdAtMs with id-localeCompare tiebreak; cursor skip via findIndex + slice(idx+1), and TERMINATES pagination (empty + null cursor) when the cursor row is no longer in the filtered set (no infinite loop)', () => {
    expect(body).toMatch(
      /getRun\(runId: string\): Promise<RecaptureRun \| null> \{\s*return Promise\.resolve\(this\.runs\.get\(runId\) \?\? null\);\s*\}/,
    );
    // Clamped: capped at 200 AND floored at 1 (a negative/zero limit no longer
    // yields a wrong-sized slice + a bogus non-null cursor).
    expect(body).toMatch(/const limit = Math\.max\(1, Math\.min\(opts\.limit \?\? 50, 200\)\);/);
    expect(body).toMatch(
      /entries\.sort\(\(a, b\) => \{\s*if \(a\.createdAtMs !== b\.createdAtMs\) return b\.createdAtMs - a\.createdAtMs;\s*return a\.id\.localeCompare\(b\.id\);\s*\}\);/,
    );
    // Cursor found → slice past it. Cursor NOT found (row dropped out of the
    // filtered set) → terminate with empty data + null cursor, NOT the
    // unsliced list + a stale cursor (which looped forever).
    expect(body).toMatch(
      /if \(opts\.cursor !== undefined\) \{\s*const idx = entries\.findIndex\(\(r\) => r\.id === opts\.cursor\);\s*if \(idx >= 0\) \{\s*entries = entries\.slice\(idx \+ 1\);\s*\} else \{/,
    );
    expect(body).toMatch(/return Promise\.resolve\(\{ data: \[\], nextCursor: null \}\);/);
  });

  it("recordComparison: throws 'recordComparison: run ${runId} not found' on missing; first call transitions 'queued' → 'in_progress' (via status ternary) + sets startedAtMs ?? this.now(); appends comparison; per-outcome aggregate count increment (match/diff/capture_error/new_surface/missing_surface)", () => {
    expect(body).toMatch(
      /if \(!run\) throw new Error\(`recordComparison: run \$\{runId\} not found`\);/,
    );
    expect(body).toMatch(
      /comparisons: \[\.\.\.run\.comparisons, comparison\],\s*status: run\.status === 'queued' \? 'in_progress' : run\.status,\s*startedAtMs: run\.startedAtMs \?\? this\.now\(\),/,
    );
    expect(body).toMatch(
      /matchCount: run\.matchCount \+ \(comparison\.outcome === 'match' \? 1 : 0\),/,
    );
    expect(body).toMatch(
      /diffCount: run\.diffCount \+ \(comparison\.outcome === 'diff' \? 1 : 0\),/,
    );
    expect(body).toMatch(
      /errorCount: run\.errorCount \+ \(comparison\.outcome === 'capture_error' \? 1 : 0\),/,
    );
    expect(body).toMatch(
      /newSurfaceCount: run\.newSurfaceCount \+ \(comparison\.outcome === 'new_surface' \? 1 : 0\),/,
    );
    expect(body).toMatch(
      /missingSurfaceCount:\s*run\.missingSurfaceCount \+ \(comparison\.outcome === 'missing_surface' \? 1 : 0\),/,
    );
  });

  it("finalizeRun: throws 'finalizeRun: run ${runId} not found' on missing; 3-state target ('completed'|'failed'|'cancelled') + completedAtMs:this.now()", () => {
    expect(body).toMatch(
      /finalizeRun\(runId: string, status: 'completed' \| 'failed' \| 'cancelled'\): Promise<RecaptureRun> \{\s*const run = this\.runs\.get\(runId\);\s*if \(!run\) throw new Error\(`finalizeRun: run \$\{runId\} not found`\);\s*const updated: RecaptureRun = \{\s*\.\.\.run,\s*status,\s*completedAtMs: this\.now\(\),\s*\};/,
    );
  });

  it("MockIosVersionWatcherDeps: 2 test seams (initialLastSeen + pendingTransitions 'Seed transitions to surface on subsequent pollForTransition() calls.')", () => {
    expect(body).toMatch(
      /export interface MockIosVersionWatcherDeps \{\s*initialLastSeen\?: string;\s*\/\*\* Seed transitions to surface on subsequent pollForTransition\(\) calls\. \*\/\s*pendingTransitions\?: IosVersionTransition\[\];\s*\}/,
    );
  });

  it('MockIosVersionWatcher: 3 methods (getLastSeenVersion returns lastSeen + pollForTransition shifts from pending queue + recordTransitionHandled sets lastSeen = transition.toIosVersion)', () => {
    expect(body).toMatch(
      /getLastSeenVersion\(\): Promise<string \| null> \{\s*return Promise\.resolve\(this\.lastSeen\);\s*\}/,
    );
    expect(body).toMatch(
      /pollForTransition\(\): Promise<IosVersionTransition \| null> \{\s*return Promise\.resolve\(this\.pending\.shift\(\) \?\? null\);\s*\}/,
    );
    expect(body).toMatch(
      /recordTransitionHandled\(transition: IosVersionTransition\): Promise<void> \{\s*this\.lastSeen = transition\.toIosVersion;\s*return Promise\.resolve\(\);\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
