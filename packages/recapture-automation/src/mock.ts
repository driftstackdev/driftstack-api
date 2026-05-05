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
  IosVersionTransition,
  RecaptureRun,
  TriggerRecaptureOpts,
} from './types.js';

export interface MockRecaptureServiceDeps {
  /** Test seam — defaults to () => Date.now(). */
  now?: () => number;
}

export class MockRecaptureService implements RecaptureService {
  private readonly runs = new Map<string, RecaptureRun>();
  private idCounter = 0;
  private readonly now: () => number;

  constructor(deps: MockRecaptureServiceDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
  }

  triggerRecapture(opts: TriggerRecaptureOpts): Promise<RecaptureRun> {
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
    return Promise.resolve(run);
  }

  getRun(runId: string): Promise<RecaptureRun | null> {
    return Promise.resolve(this.runs.get(runId) ?? null);
  }

  listRuns(opts: ListRunsOpts = {}): Promise<ListRunsPage> {
    const limit = Math.min(opts.limit ?? 50, 200);
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
      if (idx >= 0) entries = entries.slice(idx + 1);
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
