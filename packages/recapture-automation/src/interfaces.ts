// V-179 — recapture automation interfaces.

import type {
  FingerprintComparison,
  IosVersionTransition,
  RecaptureRun,
  RecaptureStatus,
  TriggerRecaptureOpts,
} from './types.js';

export interface ListRunsOpts {
  /** Filter to a specific archetype. Omit for all. */
  archetypeId?: string;
  /** Filter to a specific status. Omit for all. */
  status?: RecaptureStatus;
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Cursor from a prior response. */
  cursor?: string;
}

export interface ListRunsPage {
  data: readonly RecaptureRun[];
  nextCursor: string | null;
}

/**
 * Top-level recapture orchestration service. Operators
 * (founder + future automation) call `triggerRecapture()` when
 * a version bump is detected; the service queues + runs the
 * capture passes against the configured archetypes.
 */
export interface RecaptureService {
  /**
   * Queue a new recapture run. Returns the run record with status
   * `'queued'`; the worker picks it up + transitions through
   * `'in_progress'` → `'completed'` / `'failed'`.
   *
   * Idempotency contract (Fix 2, 2026-07-01 audit): if a run already
   * exists for the same `(archetypeId, targetVersion)` pair whose status
   * is `'queued'` or `'in_progress'`, implementations MUST return that
   * existing run rather than inserting a duplicate. Callers (including
   * concurrent/racing callers — e.g. a scheduled batch racing a human
   * "trigger now" action) can rely on `triggerRecapture()` never
   * double-dispatching a capture that's already in flight for the same
   * target.
   */
  triggerRecapture(opts: TriggerRecaptureOpts): Promise<RecaptureRun>;

  /** Look up a run by id. */
  getRun(runId: string): Promise<RecaptureRun | null>;

  /** Paginated listing of runs, optionally filtered. */
  listRuns(opts?: ListRunsOpts): Promise<ListRunsPage>;

  /**
   * Append a per-surface comparison to a run-in-progress. Called by
   * the capture worker as it walks each surface from file 121 + the
   * cumulative-rig snapshot. Aggregates (matchCount / diffCount /
   * etc.) update on the run record.
   */
  recordComparison(runId: string, comparison: FingerprintComparison): Promise<RecaptureRun>;

  /**
   * Mark a run terminal. `'completed'` if the worker finished all
   * surfaces; `'failed'` if it bailed mid-run. The run's aggregate
   * counts reflect the per-surface comparisons accumulated so far.
   */
  finalizeRun(runId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<RecaptureRun>;
}

/**
 * Detection layer — watches for new iOS minor versions. Out of
 * scope for V-179 implementation; the interface is the seam so a
 * future Apple-release-notes scraper / RSS watcher can drop in.
 *
 * Today: when Agent 1 notices a new iOS version, founder triggers
 * recapture manually via `RecaptureService.triggerRecapture()`.
 */
export interface IosVersionWatcher {
  /**
   * Last seen iOS version. Tracked across watcher invocations so
   * the watcher can detect transitions. Stored externally
   * (filesystem JSON, key/value store) — implementations supply
   * persistence.
   */
  getLastSeenVersion(): Promise<string | null>;

  /**
   * Check upstream (Apple release notes, etc.) for a version
   * newer than `getLastSeenVersion()`. Returns the transition if
   * one is detected. Implementations CAN call this from a cron
   * (daily) or a manual trigger.
   */
  pollForTransition(): Promise<IosVersionTransition | null>;

  /** Acknowledge a transition has been handled. */
  recordTransitionHandled(transition: IosVersionTransition): Promise<void>;
}
