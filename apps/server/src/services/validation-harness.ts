// V-218 — continuous validation harness service.
//
// Periodic-recapture orchestration on top of V-179 RecaptureService.
// The harness owns the schedule table; processTick() finds due rows
// and dispatches to RecaptureService.triggerRecapture(). The actual
// validation execution (vendor probes, fingerprint comparison) lives
// in the RecaptureService implementation — this service is just the
// scheduler + ledger.
//
// Cross-repo dep: when Agent 1's V-203 Phase 2A vendor probes land,
// the production RecaptureService can wire vendor-probe execution
// behind the same triggerRecapture interface. Until then, the mock
// from packages/recapture-automation is the dispatch target.
//
// Bootstrap is responsible for the periodic tick — wire as a
// setInterval(tick, 60_000) loop alongside the webhook delivery
// worker. Pure-cron-style scheduling (not exact-timing); slop of
// up to one tick interval is acceptable.

import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';

export interface ValidationScheduleRow {
  id: string;
  archetypeId: string;
  cadenceSeconds: number;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date;
  lastRunId: string | null;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertValidationScheduleInput {
  archetypeId: string;
  cadenceSeconds: number;
  enabled: boolean;
  reason?: string | null;
}

export interface ValidationSchedulesRepo {
  list(): Promise<ValidationScheduleRow[]>;
  findByArchetype(archetypeId: string): Promise<ValidationScheduleRow | null>;
  upsert(input: UpsertValidationScheduleInput): Promise<ValidationScheduleRow>;
  remove(archetypeId: string): Promise<boolean>;
  /**
   * Returns up to `limit` schedules where `enabled=true` AND
   * `next_run_at <= now`, ordered by next_run_at ASC. Used by
   * processTick() each loop iteration.
   */
  findDue(now: Date, limit: number): Promise<ValidationScheduleRow[]>;
  /**
   * Mark a tick handled. Sets last_run_at = now, last_run_id = runId,
   * next_run_at = now + cadence_seconds.
   */
  markRun(archetypeId: string, runId: string, now: Date): Promise<void>;
}

/** Minimal RecaptureService subset the harness needs. */
export interface ValidationHarnessRecaptureBridge {
  triggerRecapture: (opts: {
    trigger: 'manual_request' | 'baseline_drift_detected';
    archetypeId: string;
    baselineVersion: { iosVersion: string; safariVersion: string };
    targetVersion: { iosVersion: string; safariVersion: string };
    reason?: string;
  }) => Promise<{ id: string }>;
}

export interface ProcessTickResult {
  duePicked: number;
  dispatched: number;
  errors: { archetypeId: string; message: string }[];
  /** True when this fire was skipped because a prior tick was still running
   *  (re-entrancy guard) — see processTick. */
  skipped?: boolean;
}

/**
 * Every archetype the platform knows about, at any readiness status.
 *
 * V-1582 — deliberately the WHOLE registry rather than `SELECTABLE_ARCHETYPE_IDS`.
 * That narrower set is the customer-facing one (`launch` + `available`), and a
 * validation harness exists precisely to exercise an archetype BEFORE it becomes
 * selectable — gating on the customer set would refuse the one job this service
 * has. `reference` entries are in scope for the same reason.
 */
const KNOWN_ARCHETYPE_IDS: ReadonlySet<string> = new Set(ARCHETYPE_REGISTRY.map((a) => a.id));

/**
 * V-1582 — refuse an archetype the registry does not contain.
 *
 * `PUT /v1/admin/validation-schedules` took `archetype_id: z.string().min(1)` and
 * persisted whatever it was given, with `enabled` defaulting to true and
 * `next_run_at` one cadence out. `findDue` selects exactly `enabled = true AND
 * next_run_at <= now`, so a typo did not fail — it became a row the tick loop
 * re-dispatched every cadence, for an archetype that does not exist, with the
 * ledger recording each fire as a real validation run.
 *
 * NOT applied to `remove`. A schedule written before this guard, or one whose
 * archetype is later retired from the registry, must stay deletable; validating
 * the way out as well as the way in is how a bad row becomes permanent.
 */
function assertKnownArchetype(archetypeId: string): void {
  if (!KNOWN_ARCHETYPE_IDS.has(archetypeId)) {
    throw new BadRequestError(`Unknown archetype "${archetypeId}".`);
  }
}

export class ValidationHarnessService {
  constructor(
    private readonly repo: ValidationSchedulesRepo,
    private readonly recapture: ValidationHarnessRecaptureBridge,
    /** Used to stamp the locked-archetype baseline version on dispatched runs. */
    private readonly lockedVersion: { iosVersion: string; safariVersion: string },
  ) {}

  // ─── Admin-facing CRUD ──────────────────────────────────────────────

  async list(ctx: AccountContext): Promise<ValidationScheduleRow[]> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.list();
  }

  async upsert(
    ctx: AccountContext,
    input: UpsertValidationScheduleInput,
  ): Promise<ValidationScheduleRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    assertKnownArchetype(input.archetypeId);
    if (input.cadenceSeconds < 60) {
      throw new ConflictError('cadence_seconds must be ≥ 60.');
    }
    return this.repo.upsert(input);
  }

  async remove(ctx: AccountContext, archetypeId: string): Promise<void> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const removed = await this.repo.remove(archetypeId);
    if (!removed) {
      throw new NotFoundError(`No validation schedule for archetype "${archetypeId}".`);
    }
  }

  /**
   * Manual one-shot trigger: dispatch a recapture for the given
   * archetype now without touching the schedule. Useful when staff
   * want to re-validate after a config change without waiting for
   * the next tick.
   */
  async triggerNow(
    ctx: AccountContext,
    archetypeId: string,
    reason?: string,
  ): Promise<{ runId: string }> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    assertKnownArchetype(archetypeId);
    const run = await this.recapture.triggerRecapture({
      trigger: 'manual_request',
      archetypeId,
      baselineVersion: this.lockedVersion,
      targetVersion: this.lockedVersion,
      ...(reason !== undefined ? { reason } : {}),
    });
    return { runId: run.id };
  }

  // ─── Worker tick (called from bootstrap setInterval) ────────────────

  // Re-entrancy guard for processTick (see its doc comment).
  private ticking = false;

  /**
   * Worker tick. Re-entrancy-guarded: the bootstrap poller is a naive
   * `setInterval` that does NOT await the prior tick, so a tick slower than the
   * interval would overlap the next fire. Overlap would DOUBLE-DISPATCH — two
   * overlapping `findDue` calls both pick the same not-yet-`markRun` schedules,
   * firing duplicate (expensive) recapture runs for one archetype. Skip the
   * overlapping fire (`skipped: true`) — strictly safer; the next interval
   * re-picks anything still due. Delegates the real work to `runTick`.
   */
  async processTick(opts?: { now?: Date; batchSize?: number }): Promise<ProcessTickResult> {
    if (this.ticking) {
      return { duePicked: 0, dispatched: 0, errors: [], skipped: true };
    }
    this.ticking = true;
    try {
      return await this.runTick(opts);
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(opts?: { now?: Date; batchSize?: number }): Promise<ProcessTickResult> {
    const now = opts?.now ?? new Date();
    const batchSize = opts?.batchSize ?? 10;
    const due = await this.repo.findDue(now, batchSize);
    const errors: { archetypeId: string; message: string }[] = [];
    let dispatched = 0;
    for (const sched of due) {
      try {
        const run = await this.recapture.triggerRecapture({
          trigger: 'baseline_drift_detected',
          archetypeId: sched.archetypeId,
          baselineVersion: this.lockedVersion,
          targetVersion: this.lockedVersion,
          ...(sched.reason !== null ? { reason: sched.reason } : {}),
        });
        await this.repo.markRun(sched.archetypeId, run.id, now);
        dispatched++;
      } catch (err) {
        errors.push({
          archetypeId: sched.archetypeId,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return { duePicked: due.length, dispatched, errors };
  }
}
