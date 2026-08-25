// W957 — V-218 + V-179 validation-harness cross-source invariant.
// Two-hundred-eighty-third in the drift-guard series. Pins the
// continuous validation harness service:
//
//   V-218 anchor — 'V-218 — continuous validation harness service'.
//
//   Service responsibility framing — 'Periodic-recapture
//   orchestration on top of V-179 RecaptureService. The harness
//   owns the schedule table; processTick() finds due rows and
//   dispatches to RecaptureService.triggerRecapture(). The actual
//   validation execution (vendor probes, fingerprint comparison)
//   lives in the RecaptureService implementation — this service is
//   just the scheduler + ledger'.
//
//   V-203 forward-wiring framing — 'Cross-repo dep: when Agent 1's
//   V-203 Phase 2A vendor probes land, the production
//   RecaptureService can wire vendor-probe execution behind the
//   same triggerRecapture interface. Until then, the mock from
//   packages/recapture-automation is the dispatch target'.
//
//   Bootstrap cadence framing — 'Bootstrap is responsible for the
//   periodic tick — wire as a setInterval(tick, 60_000) loop
//   alongside the webhook delivery worker. Pure-cron-style
//   scheduling (not exact-timing); slop of up to one tick interval
//   is acceptable'.
//
//   ValidationScheduleRow (10 fields):
//     - id + archetypeId + cadenceSeconds + enabled +
//       lastRunAt (nullable) + nextRunAt + lastRunId (nullable) +
//       reason (nullable) + createdAt + updatedAt.
//
//   UpsertValidationScheduleInput (4-field write shape):
//     - archetypeId + cadenceSeconds + enabled + reason? (nullable).
//
//   ValidationSchedulesRepo (6-method seam):
//     - list + findByArchetype + upsert + remove + findDue
//       (enabled=true AND next_run_at<=now, asc) + markRun
//       (sets last_run_at + last_run_id + next_run_at).
//
//   findDue JSDoc — 'Returns up to limit schedules where
//   enabled=true AND next_run_at <= now, ordered by next_run_at
//   ASC. Used by processTick() each loop iteration'.
//
//   markRun JSDoc — 'Mark a tick handled. Sets last_run_at = now,
//   last_run_id = runId, next_run_at = now + cadence_seconds'.
//
// stays in lockstep across apps/server/src/services/validation-harness.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W957 V-218 + V-179 validation-harness cross-source invariant', () => {
  // ─── V-218 anchor + service intro ────────────────────────────

  it("CRITICAL apps/server/src/services/validation-harness.ts header pins V-218 anchor — 'V-218 — continuous validation harness service'. The V-218 anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/V-218 — continuous validation harness service/);
  });

  // ─── V-179 RecaptureService wiring framing ───────────────────

  it("CRITICAL V-179 wiring framing — 'Periodic-recapture orchestration on top of V-179 RecaptureService. The harness owns the schedule table; processTick() finds due rows and dispatches to RecaptureService.triggerRecapture(). The actual validation execution (vendor probes, fingerprint comparison) lives in the RecaptureService implementation — this service is just the scheduler + ledger'. The scheduler-vs-execution split is the V-218/V-179 boundary.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/Periodic-recapture orchestration on top of V-179 RecaptureService\./);
    expect(p).toMatch(/The harness owns the schedule table; processTick\(\) finds due rows/);
    expect(p).toMatch(/and dispatches to RecaptureService\.triggerRecapture\(\)\. The actual/);
    expect(p).toMatch(/validation execution \(vendor probes, fingerprint comparison\) lives/);
    expect(p).toMatch(/in the RecaptureService implementation — this service is just the/);
    expect(p).toMatch(/scheduler \+ ledger\./);
  });

  // ─── V-203 forward-wiring framing ────────────────────────────

  it("CRITICAL V-203 forward-wiring framing — 'Cross-repo dep: when Agent 1's V-203 Phase 2A vendor probes land, the production RecaptureService can wire vendor-probe execution behind the same triggerRecapture interface. Until then, the mock from packages/recapture-automation is the dispatch target'. The same-interface + V-203-future-wiring is the swap-without-breaking-callers contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/Cross-repo dep: when Agent 1's V-203 Phase 2A vendor probes land,/);
    expect(p).toMatch(/the production RecaptureService can wire vendor-probe execution/);
    expect(p).toMatch(/behind the same triggerRecapture interface\. Until then, the mock/);
    expect(p).toMatch(/from packages\/recapture-automation is the dispatch target\./);
  });

  // ─── Bootstrap cadence: setInterval(60_000) ──────────────────

  it("CRITICAL bootstrap cadence framing — 'Bootstrap is responsible for the periodic tick — wire as a setInterval(tick, 60_000) loop alongside the webhook delivery worker. Pure-cron-style scheduling (not exact-timing); slop of up to one tick interval is acceptable'. The 60s setInterval + pure-cron + 1-tick-slop framing is the cadence contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/Bootstrap is responsible for the periodic tick — wire as a/);
    expect(p).toMatch(/setInterval\(tick, 60_000\) loop alongside the webhook delivery/);
    expect(p).toMatch(/worker\. Pure-cron-style scheduling \(not exact-timing\); slop of/);
    expect(p).toMatch(/up to one tick interval is acceptable\./);
  });

  // ─── ValidationScheduleRow 10-field shape ────────────────────

  it('CRITICAL ValidationScheduleRow has 10 fields — id + archetypeId + cadenceSeconds + enabled + lastRunAt (nullable) + nextRunAt + lastRunId (nullable) + reason (nullable) + createdAt + updatedAt. The 10-field shape carries per-archetype scheduling state + last-run-id audit trail.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/export interface ValidationScheduleRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/archetypeId: string;/);
    expect(p).toMatch(/cadenceSeconds: number;/);
    expect(p).toMatch(/enabled: boolean;/);
    expect(p).toMatch(/lastRunAt: Date \| null;/);
    expect(p).toMatch(/nextRunAt: Date;/);
    expect(p).toMatch(/lastRunId: string \| null;/);
    expect(p).toMatch(/reason: string \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
    expect(p).toMatch(/updatedAt: Date;/);
  });

  // ─── UpsertValidationScheduleInput 4-field write shape ───────

  it('CRITICAL UpsertValidationScheduleInput has 4 fields — archetypeId + cadenceSeconds + enabled + reason? (nullable). The 4-field write shape is what admin upsert calls consume.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/export interface UpsertValidationScheduleInput \{/);
    expect(p).toMatch(/archetypeId: string;/);
    expect(p).toMatch(/cadenceSeconds: number;/);
    expect(p).toMatch(/enabled: boolean;/);
    expect(p).toMatch(/reason\?: string \| null;/);
  });

  // ─── ValidationSchedulesRepo 6-method interface ──────────────

  it('CRITICAL ValidationSchedulesRepo has 6 methods — list + findByArchetype + upsert + remove + findDue + markRun. The 6-method seam covers CRUD + the 2 tick-loop primitives (findDue + markRun).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/export interface ValidationSchedulesRepo \{/);
    expect(p).toMatch(/list\(\): Promise<ValidationScheduleRow\[\]>;/);
    expect(p).toMatch(
      /findByArchetype\(archetypeId: string\): Promise<ValidationScheduleRow \| null>;/,
    );
    expect(p).toMatch(
      /upsert\(input: UpsertValidationScheduleInput\): Promise<ValidationScheduleRow>;/,
    );
    expect(p).toMatch(/remove\(archetypeId: string\): Promise<boolean>;/);
    expect(p).toMatch(/findDue\(now: Date, limit: number\): Promise<ValidationScheduleRow\[\]>;/);
    expect(p).toMatch(/markRun\(archetypeId: string, runId: string, now: Date\): Promise<void>;/);
  });

  // ─── findDue framing ─────────────────────────────────────────

  it("CRITICAL findDue JSDoc — 'Returns up to limit schedules where enabled=true AND next_run_at <= now, ordered by next_run_at ASC. Used by processTick() each loop iteration'. The 3-condition filter (enabled + due + limit) + asc-order is the tick-loop primitive.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/Returns up to `limit` schedules where `enabled=true` AND/);
    expect(p).toMatch(/`next_run_at <= now`, ordered by next_run_at ASC\. Used by/);
    expect(p).toMatch(/processTick\(\) each loop iteration\./);
  });

  // ─── markRun framing ─────────────────────────────────────────

  it("CRITICAL markRun JSDoc — 'Mark a tick handled. Sets last_run_at = now, last_run_id = runId, next_run_at = now + cadence_seconds'. The 3-column-set + now+cadence next-run-at is the tick-completion primitive.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/Mark a tick handled\. Sets last_run_at = now, last_run_id = runId,/);
    expect(p).toMatch(/next_run_at = now \+ cadence_seconds\./);
  });

  // ─── 2-error class import ────────────────────────────────────

  it('CRITICAL imports 3 error classes — BadRequestError + ConflictError + NotFoundError. The palette covers malformed-reference + state-conflict + row-missing states.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    // V-1582 — a third class joined the palette when the service began refusing an
    // archetype the registry does not contain. That is neither a state conflict nor
    // a missing row: it is a malformed reference, so it is a bad request.
    expect(p).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('CRITICAL imports requireScope as throwIfMissingScope from lib/errors-helpers — scope-gate primitive (matches the convention across services).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
  });

  // ─── AccountContext type import ──────────────────────────────

  it('CRITICAL imports AccountContext type from auth.ts — service methods take AccountContext for scope-checking (matches the service-vs-route audit-split + account-scope pattern across the codebase).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts'));
    expect(p).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/validation-harness-v218-v179-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
