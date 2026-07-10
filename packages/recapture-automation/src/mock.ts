// V-179 — in-memory mock implementations of RecaptureService +
// IosVersionWatcher. Useful for unit tests + GUI-client integration
// against the same surface a future production impl will satisfy.
//
// Mock semantics:
// - triggerRecapture() inserts a queued run; transitions are caller-
//   driven via recordComparison() + finalizeRun().
// - getRun() / listRuns() are deterministic (insertion order with
//   id-tiebreaker).
// - IosVersionWatcher state is in-memory; the production impl would
//   persist to disk or a kv store.

import type {
  IosVersionWatcher,
  ListRunsOpts,
  ListRunsPage,
  RecaptureService,
} from './interfaces.js';
import type {
  FingerprintComparison,
  IosArchetypeVersion,
  IosVersionTransition,
  RecaptureRun,
  TriggerRecaptureOpts,
} from './types.js';

export interface MockRecaptureServiceDeps {
  /** Test seam — defaults to () => Date.now(). */
  now?: () => number;
}

/**
 * Default cap on `MockRecaptureService`'s in-memory `runs` map before the
 * oldest entry (by insertion order) is evicted (Fix 5, 2026-07-01 audit).
 * Recapture runs are a low-frequency event — one per archetype per iOS
 * version bump, not a per-request/per-session thing — but the class is
 * documented as usable for GUI-client integration (see the class doc
 * above), not purely disposable test scaffolding, and each run retains its
 * full `comparisons` array, so it isn't safe to grow unbounded forever.
 * 2,000 is generously above any realistic archetype-matrix × version-bump
 * volume this package's docs describe (dozens of archetypes, occasional
 * bumps) while still bounding worst-case memory.
 */
const DEFAULT_MAX_RUNS = 2_000;

export class MockRecaptureService implements RecaptureService {
  private readonly runs = new Map<string, RecaptureRun>();
  private idCounter = 0;
  private readonly now: () => number;

  constructor(
    deps: MockRecaptureServiceDeps = {},
    /** Cap on `runs` before the oldest (by insertion order) is evicted. */
    private readonly maxEntries: number = DEFAULT_MAX_RUNS,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Fix 2 (2026-07-01 audit) dedup lookup: an existing `'queued'` or
   * `'in_progress'` run for the same (archetypeId, targetVersion) that
   * `triggerRecapture()` should return instead of inserting a duplicate.
   * Without this, two concurrent `triggerRecapture()` calls with identical
   * opts (or a scheduled batch racing a human "trigger now" action) each
   * see no run yet exists and both insert independent `'queued'` runs.
   *
   * NOTE for whoever wires the scheduler (scheduler.ts) driver to this
   * service: this dedup does NOT know about scheduler.ts's stale
   * in-flight-lease-expiry check (STALE_IN_FLIGHT_MS) — if a driver
   * reschedules an archetype because the scheduler decided its prior run
   * is abandoned, but that prior run is still `'in_progress'` here (never
   * finalized), this lookup will hand back the SAME stale run rather than
   * inserting the fresh one the scheduler intended. That's out of scope
   * for this fix (mock.ts has no knowledge of scheduler.ts's staleness
   * policy) — a production driver would need to finalize/cancel the stale
   * run (or otherwise make it non-'in_progress') before re-triggering.
   */
  private findInFlightRun(
    archetypeId: string,
    targetVersion: IosArchetypeVersion,
  ): RecaptureRun | null {
    for (const run of this.runs.values()) {
      if (
        run.archetypeId === archetypeId &&
        run.targetVersion.iosVersion === targetVersion.iosVersion &&
        run.targetVersion.safariVersion === targetVersion.safariVersion &&
        (run.status === 'queued' || run.status === 'in_progress')
      ) {
        return run;
      }
    }
    return null;
  }

  triggerRecapture(opts: TriggerRecaptureOpts): Promise<RecaptureRun> {
    const existing = this.findInFlightRun(opts.archetypeId, opts.targetVersion);
    if (existing) {
      return Promise.resolve(existing);
    }
    this.idCounter += 1;
    const id = `rcap_${this.idCounter.toString().padStart(8, '0')}`;
    const run: RecaptureRun = {
      id,
      trigger: opts.trigger,
      archetypeId: opts.archetypeId,
      baselineVersion: opts.baselineVersion,
      targetVersion: opts.targetVersion,
      status: 'queued',
      comparisons: [],
      matchCount: 0,
      diffCount: 0,
      errorCount: 0,
      newSurfaceCount: 0,
      missingSurfaceCount: 0,
      startedAtMs: null,
      completedAtMs: null,
      createdAtMs: this.now(),
    };
    this.runs.set(id, run);
    // Fix 5 (2026-07-01 audit): oldest-evicted size cap, mirroring the
    // established bounded-Map pattern used elsewhere in this codebase (e.g.
    // apps/server's session-page-state-store.ts) — insert first, then drop
    // the oldest entry if that pushed the map over the cap.
    if (this.runs.size > this.maxEntries) {
      const oldest = this.runs.keys().next().value;
      if (oldest !== undefined) this.runs.delete(oldest);
    }
    return Promise.resolve(run);
  }

  getRun(runId: string): Promise<RecaptureRun | null> {
    return Promise.resolve(this.runs.get(runId) ?? null);
  }

  listRuns(opts: ListRunsOpts = {}): Promise<ListRunsPage> {
    // Clamp to a sane range: a negative/zero limit would otherwise slice
    // wrong (e.g. `slice(0, -1)` drops the last row) AND emit a bogus
    // non-null nextCursor, and an oversized one blows the page cap.
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    let entries = Array.from(this.runs.values());
    if (opts.archetypeId !== undefined) {
      entries = entries.filter((r) => r.archetypeId === opts.archetypeId);
    }
    if (opts.status !== undefined) {
      entries = entries.filter((r) => r.status === opts.status);
    }
    // Newest-first.
    entries.sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
      return a.id.localeCompare(b.id);
    });
    if (opts.cursor !== undefined) {
      const idx = entries.findIndex((r) => r.id === opts.cursor);
      if (idx >= 0) {
        entries = entries.slice(idx + 1);
      } else {
        // The cursor row is no longer in the filtered set — e.g. its status
        // changed between pages so it dropped out of a status filter, or it was
        // deleted. We can't safely resume from a row we can't find, and
        // returning the unsliced list with a fresh nextCursor would hand the
        // client page 1 again + a cursor it already holds → an infinite paging
        // loop. Terminate pagination instead.
        return Promise.resolve({ data: [], nextCursor: null });
      }
    }
    const page = entries.slice(0, limit);
    const nextCursor = entries.length > limit ? (page[page.length - 1]?.id ?? null) : null;
    return Promise.resolve({ data: page, nextCursor });
  }

  recordComparison(runId: string, comparison: FingerprintComparison): Promise<RecaptureRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`recordComparison: run ${runId} not found`);
    const updated: RecaptureRun = {
      ...run,
      comparisons: [...run.comparisons, comparison],
      status: run.status === 'queued' ? 'in_progress' : run.status,
      startedAtMs: run.startedAtMs ?? this.now(),
      matchCount: run.matchCount + (comparison.outcome === 'match' ? 1 : 0),
      diffCount: run.diffCount + (comparison.outcome === 'diff' ? 1 : 0),
      errorCount: run.errorCount + (comparison.outcome === 'capture_error' ? 1 : 0),
      newSurfaceCount: run.newSurfaceCount + (comparison.outcome === 'new_surface' ? 1 : 0),
      missingSurfaceCount:
        run.missingSurfaceCount + (comparison.outcome === 'missing_surface' ? 1 : 0),
    };
    this.runs.set(runId, updated);
    return Promise.resolve(updated);
  }

  finalizeRun(runId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<RecaptureRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`finalizeRun: run ${runId} not found`);
    const updated: RecaptureRun = {
      ...run,
      status,
      completedAtMs: this.now(),
    };
    this.runs.set(runId, updated);
    return Promise.resolve(updated);
  }
}

export interface MockIosVersionWatcherDeps {
  initialLastSeen?: string;
  /** Seed transitions to surface on subsequent pollForTransition() calls. */
  pendingTransitions?: IosVersionTransition[];
}

export class MockIosVersionWatcher implements IosVersionWatcher {
  private lastSeen: string | null;
  private readonly pending: IosVersionTransition[];

  constructor(deps: MockIosVersionWatcherDeps = {}) {
    this.lastSeen = deps.initialLastSeen ?? null;
    this.pending = [...(deps.pendingTransitions ?? [])];
  }

  getLastSeenVersion(): Promise<string | null> {
    return Promise.resolve(this.lastSeen);
  }

  pollForTransition(): Promise<IosVersionTransition | null> {
    return Promise.resolve(this.pending.shift() ?? null);
  }

  recordTransitionHandled(transition: IosVersionTransition): Promise<void> {
    this.lastSeen = transition.toIosVersion;
    return Promise.resolve();
  }
}
