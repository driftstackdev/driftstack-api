// W409.C — drift guard for apps/server/src/services/validation-harness.ts.
// V-218 continuous validation harness — periodic-recapture orchestration
// on top of V-179 RecaptureService. Drift here either skips due schedules
// (silent freshness rot) or double-dispatches (vendor probe spam).
//
//   • V-218 framing pinned: schedule table ownership + processTick finds
//     due rows + dispatches to RecaptureService.triggerRecapture().
//   • Cross-repo dep pinned: Agent 1's V-203 Phase 2A vendor probes
//     wire behind the same triggerRecapture interface; until then the
//     mock from packages/recapture-automation is the dispatch target.
//   • Bootstrap responsibility pinned: setInterval(tick, 60_000) loop
//     alongside webhook delivery worker; pure-cron-style scheduling;
//     slop up to one tick interval acceptable.
//   • cadenceSeconds >= 60 enforced via ConflictError on upsert.
//   • driftstack_internal_admin scope-gate on every admin CRUD method.
//   • findDue: enabled=true AND next_run_at <= now, ordered by
//     next_run_at ASC, capped at `limit`.
//   • markRun: last_run_at=now, last_run_id=runId, next_run_at=now+cadence.
//   • triggerNow: 'manual_request' trigger; optional `reason` spread
//     via `...(reason !== undefined ? { reason } : {})` pattern.
//   • processTick: 'baseline_drift_detected' trigger; default batchSize=10;
//     errors collected per-archetype (no throw — keep harness alive).
//   • lockedVersion (iosVersion + safariVersion) stamped as both
//     baselineVersion AND targetVersion on every dispatched run.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/validation-harness.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W409.C apps/server/src/services/validation-harness.ts content parity', () => {
  const body = read(LIB);

  it('V-218 framing pinned: schedule table ownership + processTick dispatches to RecaptureService.triggerRecapture()', () => {
    expect(body).toMatch(/V-218 — continuous validation harness service\./);
    expect(body).toMatch(
      /Periodic-recapture orchestration on top of V-179 RecaptureService\.\s*\/\/\s*The harness owns the schedule table; processTick\(\) finds due rows\s*\/\/\s*and dispatches to RecaptureService\.triggerRecapture\(\)\. The actual\s*\/\/\s*validation execution \(vendor probes, fingerprint comparison\) lives\s*\/\/\s*in the RecaptureService implementation — this service is just the\s*\/\/\s*scheduler \+ ledger\./,
    );
  });

  it('Cross-repo dep pinned: Agent 1 V-203 Phase 2A vendor probes; mock from packages/recapture-automation until then', () => {
    expect(body).toMatch(
      /Cross-repo dep: when Agent 1's V-203 Phase 2A vendor probes land,\s*\/\/\s*the production RecaptureService can wire vendor-probe execution\s*\/\/\s*behind the same triggerRecapture interface\. Until then, the mock\s*\/\/\s*from packages\/recapture-automation is the dispatch target\./,
    );
  });

  it('Bootstrap responsibility pinned: setInterval(tick, 60_000) alongside webhook delivery worker; slop-tolerant', () => {
    expect(body).toMatch(
      /Bootstrap is responsible for the periodic tick — wire as a\s*\/\/\s*setInterval\(tick, 60_000\) loop alongside the webhook delivery\s*\/\/\s*worker\. Pure-cron-style scheduling \(not exact-timing\); slop of\s*\/\/\s*up to one tick interval is acceptable\./,
    );
  });

  it('cadenceSeconds >= 60 ConflictError on upsert', () => {
    expect(body).toMatch(/if \(input\.cadenceSeconds < 60\) \{/);
    expect(body).toMatch(/throw new ConflictError\('cadence_seconds must be ≥ 60\.'\);/);
  });

  it('driftstack_internal_admin scope-gate on list + upsert + remove + triggerNow', () => {
    expect(body).toMatch(
      /async list\(ctx: AccountContext\): Promise<ValidationScheduleRow\[\]> \{\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
    expect(body).toMatch(
      /async upsert\(\s*ctx: AccountContext,\s*input: UpsertValidationScheduleInput,\s*\): Promise<ValidationScheduleRow> \{\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
    expect(body).toMatch(
      /async remove\(ctx: AccountContext, archetypeId: string\): Promise<void> \{\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
    expect(body).toMatch(
      /async triggerNow\(\s*ctx: AccountContext,\s*archetypeId: string,\s*reason\?: string,\s*\): Promise<\{ runId: string \}> \{\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
  });

  it('remove: throws NotFoundError when repo.remove returns false (descriptive message includes archetypeId)', () => {
    expect(body).toMatch(/const removed = await this\.repo\.remove\(archetypeId\);/);
    expect(body).toMatch(
      /if \(!removed\) \{\s*throw new NotFoundError\(`No validation schedule for archetype "\$\{archetypeId\}"\.`\);/,
    );
  });

  it('ValidationScheduleRow: 9 fields with cadenceSeconds + enabled + lastRunAt|lastRunId nullable + reason nullable', () => {
    expect(body).toMatch(/export interface ValidationScheduleRow \{/);
    expect(body).toMatch(/archetypeId: string;/);
    expect(body).toMatch(/cadenceSeconds: number;/);
    expect(body).toMatch(/enabled: boolean;/);
    expect(body).toMatch(/lastRunAt: Date \| null;/);
    expect(body).toMatch(/nextRunAt: Date;/);
    expect(body).toMatch(/lastRunId: string \| null;/);
    expect(body).toMatch(/reason: string \| null;/);
  });

  it('ValidationSchedulesRepo: 6 methods (list + findByArchetype + upsert + remove + findDue + markRun)', () => {
    expect(body).toMatch(/export interface ValidationSchedulesRepo \{/);
    expect(body).toMatch(/list\(\): Promise<ValidationScheduleRow\[\]>;/);
    expect(body).toMatch(
      /findByArchetype\(archetypeId: string\): Promise<ValidationScheduleRow \| null>;/,
    );
    expect(body).toMatch(
      /upsert\(input: UpsertValidationScheduleInput\): Promise<ValidationScheduleRow>;/,
    );
    expect(body).toMatch(/remove\(archetypeId: string\): Promise<boolean>;/);
    expect(body).toMatch(
      /findDue\(now: Date, limit: number\): Promise<ValidationScheduleRow\[\]>;/,
    );
    expect(body).toMatch(
      /markRun\(archetypeId: string, runId: string, now: Date\): Promise<void>;/,
    );
  });

  it('findDue framing pinned: enabled=true AND next_run_at <= now, ordered by next_run_at ASC, capped at `limit`', () => {
    expect(body).toMatch(
      /Returns up to `limit` schedules where `enabled=true` AND\s*\*\s*`next_run_at <= now`, ordered by next_run_at ASC\. Used by\s*\*\s*processTick\(\) each loop iteration\./,
    );
  });

  it('markRun framing pinned: last_run_at=now + last_run_id=runId + next_run_at=now+cadence_seconds', () => {
    expect(body).toMatch(
      /Mark a tick handled\. Sets last_run_at = now, last_run_id = runId,\s*\*\s*next_run_at = now \+ cadence_seconds\./,
    );
  });

  it('ValidationHarnessRecaptureBridge: minimal triggerRecapture subset with trigger union manual_request|baseline_drift_detected', () => {
    expect(body).toMatch(/\/\*\* Minimal RecaptureService subset the harness needs\. \*\//);
    expect(body).toMatch(/export interface ValidationHarnessRecaptureBridge \{/);
    expect(body).toMatch(
      /triggerRecapture: \(opts: \{\s*trigger: 'manual_request' \| 'baseline_drift_detected';\s*archetypeId: string;\s*baselineVersion: \{ iosVersion: string; safariVersion: string \};\s*targetVersion: \{ iosVersion: string; safariVersion: string \};\s*reason\?: string;\s*\}\) => Promise<\{ id: string \}>;/,
    );
  });

  it('triggerNow framing pinned: manual one-shot without touching schedule; manual_request trigger; optional reason via spread', () => {
    expect(body).toMatch(
      /Manual one-shot trigger: dispatch a recapture for the given\s*\*\s*archetype now without touching the schedule\. Useful when staff\s*\*\s*want to re-validate after a config change without waiting for\s*\*\s*the next tick\./,
    );
    expect(body).toMatch(
      /const run = await this\.recapture\.triggerRecapture\(\{\s*trigger: 'manual_request',\s*archetypeId,\s*baselineVersion: this\.lockedVersion,\s*targetVersion: this\.lockedVersion,\s*\.\.\.\(reason !== undefined \? \{ reason \} : \{\}\),\s*\}\);/,
    );
    expect(body).toMatch(/return \{ runId: run\.id \};/);
  });

  it('processTick: re-entrancy guard (skip overlapping fire) delegating to runTick with default batchSize=10 + baseline_drift_detected trigger + per-archetype error collection (no throw)', () => {
    // Guard wrapper: skip if a prior tick is still running, else delegate to runTick.
    expect(body).toMatch(
      /async processTick\(opts\?: \{ now\?: Date; batchSize\?: number \}\): Promise<ProcessTickResult> \{\s*if \(this\.ticking\) \{\s*return \{ duePicked: 0, dispatched: 0, errors: \[\], skipped: true \};\s*\}\s*this\.ticking = true;\s*try \{\s*return await this\.runTick\(opts\);\s*\} finally \{\s*this\.ticking = false;\s*\}\s*\}/,
    );
    // Real work in runTick: batchSize default + findDue.
    expect(body).toMatch(
      /private async runTick\(opts\?: \{ now\?: Date; batchSize\?: number \}\): Promise<ProcessTickResult> \{\s*const now = opts\?\.now \?\? new Date\(\);\s*const batchSize = opts\?\.batchSize \?\? 10;\s*const due = await this\.repo\.findDue\(now, batchSize\);/,
    );
    expect(body).toMatch(/trigger: 'baseline_drift_detected',/);
    expect(body).toMatch(
      /\} catch \(err\) \{\s*errors\.push\(\{\s*archetypeId: sched\.archetypeId,\s*message: err instanceof Error \? err\.message : 'unknown',\s*\}\);/,
    );
    expect(body).toMatch(/return \{ duePicked: due\.length, dispatched, errors \};/);
  });

  it('processTick: schedule.reason spread via `...(sched.reason !== null ? { reason: sched.reason } : {})` pattern', () => {
    expect(body).toMatch(/\.\.\.\(sched\.reason !== null \? \{ reason: sched\.reason \} : \{\}\),/);
  });

  it('lockedVersion: stamped as BOTH baselineVersion AND targetVersion on dispatched runs (locked-archetype framing)', () => {
    expect(body).toMatch(
      /\/\*\* Used to stamp the locked-archetype baseline version on dispatched runs\. \*\/\s*private readonly lockedVersion: \{ iosVersion: string; safariVersion: string \},/,
    );
  });

  it('ProcessTickResult: 3 fields (duePicked + dispatched + errors array of {archetypeId, message})', () => {
    expect(body).toMatch(/export interface ProcessTickResult \{/);
    expect(body).toMatch(/duePicked: number;/);
    expect(body).toMatch(/dispatched: number;/);
    expect(body).toMatch(/errors: \{ archetypeId: string; message: string \}\[\];/);
  });

  it('imports: AccountContext + requireScope (aliased) + BadRequestError/ConflictError/NotFoundError + ARCHETYPE_REGISTRY', () => {
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
    // V-1582 — BadRequestError joined these when the service started rejecting an
    // archetype absent from the registry.
    expect(body).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
