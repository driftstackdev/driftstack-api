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
      /Periodic-recapture orchestration on top of V-179 RecaptureService\.\s*\n?\s*\/\/\s*The harness owns the schedule table; processTick\(\) finds due rows\s*\n?\s*\/\/\s*and dispatches to RecaptureService\.triggerRecapture\(\)\. The actual\s*\n?\s*\/\/\s*validation execution \(vendor probes, fingerprint comparison\) lives\s*\n?\s*\/\/\s*in the RecaptureService implementation — this service is just the\s*\n?\s*\/\/\s*scheduler \+ ledger\./,
    );
  });

  it('Cross-repo dep pinned: Agent 1 V-203 Phase 2A vendor probes; mock from packages/recapture-automation until then', () => {
    expect(body).toMatch(
      /Cross-repo dep: when Agent 1's V-203 Phase 2A vendor probes land,\s*\n?\s*\/\/\s*the production RecaptureService can wire vendor-probe execution\s*\n?\s*\/\/\s*behind the same triggerRecapture interface\. Until then, the mock\s*\n?\s*\/\/\s*from packages\/recapture-automation is the dispatch target\./,
    );
  });

  it('Bootstrap responsibility pinned: setInterval(tick, 60_000) alongside webhook delivery worker; slop-tolerant', () => {
    expect(body).toMatch(
      /Bootstrap is responsible for the periodic tick — wire as a\s*\n?\s*\/\/\s*setInterval\(tick, 60_000\) loop alongside the webhook delivery\s*\n?\s*\/\/\s*worker\. Pure-cron-style scheduling \(not exact-timing\); slop of\s*\n?\s*\/\/\s*up to one tick interval is acceptable\./,
    );
  });

  it('cadenceSeconds >= 60 ConflictError on upsert', () => {
    expect(body).toMatch(/if \(input\.cadenceSeconds < 60\) \{/);
    expect(body).toMatch(/throw new ConflictError\('cadence_seconds must be ≥ 60\.'\);/);
  });

  it('driftstack_internal_admin scope-gate on list + upsert + remove + triggerNow', () => {
    expect(body).toMatch(
      /async list\(ctx: AccountContext\): Promise<ValidationScheduleRow\[\]> \{\s*\n?\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
    expect(body).toMatch(
      /async upsert\(\s*\n?\s*ctx: AccountContext,\s*\n?\s*input: UpsertValidationScheduleInput,\s*\n?\s*\): Promise<ValidationScheduleRow> \{\s*\n?\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
    expect(body).toMatch(
      /async remove\(ctx: AccountContext, archetypeId: string\): Promise<void> \{\s*\n?\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
    expect(body).toMatch(
      /async triggerNow\(\s*\n?\s*ctx: AccountContext,\s*\n?\s*archetypeId: string,\s*\n?\s*reason\?: string,\s*\n?\s*\): Promise<\{ runId: string \}> \{\s*\n?\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
  });

  it('remove: throws NotFoundError when repo.remove returns false (descriptive message includes archetypeId)', () => {
    expect(body).toMatch(/const removed = await this\.repo\.remove\(archetypeId\);/);
    expect(body).toMatch(
      /if \(!removed\) \{\s*\n?\s*throw new NotFoundError\(`No validation schedule for archetype "\$\{archetypeId\}"\.`\);/,
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
      /Returns up to `limit` schedules where `enabled=true` AND\s*\n?\s*\*\s*`next_run_at <= now`, ordered by next_run_at ASC\. Used by\s*\n?\s*\*\s*processTick\(\) each loop iteration\./,
    );
  });

  it('markRun framing pinned: last_run_at=now + last_run_id=runId + next_run_at=now+cadence_seconds', () => {
    expect(body).toMatch(
      /Mark a tick handled\. Sets last_run_at = now, last_run_id = runId,\s*\n?\s*\*\s*next_run_at = now \+ cadence_seconds\./,
    );
  });

  it('ValidationHarnessRecaptureBridge: minimal triggerRecapture subset with trigger union manual_request|baseline_drift_detected', () => {
    expect(body).toMatch(/\/\*\* Minimal RecaptureService subset the harness needs\. \*\//);
    expect(body).toMatch(/export interface ValidationHarnessRecaptureBridge \{/);
    expect(body).toMatch(
      /triggerRecapture: \(opts: \{\s*\n?\s*trigger: 'manual_request' \| 'baseline_drift_detected';\s*\n?\s*archetypeId: string;\s*\n?\s*baselineVersion: \{ iosVersion: string; safariVersion: string \};\s*\n?\s*targetVersion: \{ iosVersion: string; safariVersion: string \};\s*\n?\s*reason\?: string;\s*\n?\s*\}\) => Promise<\{ id: string \}>;/,
    );
  });

  it('triggerNow framing pinned: manual one-shot without touching schedule; manual_request trigger; optional reason via spread', () => {
    expect(body).toMatch(
      /Manual one-shot trigger: dispatch a recapture for the given\s*\n?\s*\*\s*archetype now without touching the schedule\. Useful when staff\s*\n?\s*\*\s*want to re-validate after a config change without waiting for\s*\n?\s*\*\s*the next tick\./,
    );
    expect(body).toMatch(
      /const run = await this\.recapture\.triggerRecapture\(\{\s*\n?\s*trigger: 'manual_request',\s*\n?\s*archetypeId,\s*\n?\s*baselineVersion: this\.lockedVersion,\s*\n?\s*targetVersion: this\.lockedVersion,\s*\n?\s*\.\.\.\(reason !== undefined \? \{ reason \} : \{\}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/return \{ runId: run\.id \};/);
  });

  it('processTick: re-entrancy guard (skip overlapping fire) delegating to runTick with default batchSize=10 + baseline_drift_detected trigger + per-archetype error collection (no throw)', () => {
    // Guard wrapper: skip if a prior tick is still running, else delegate to runTick.
    expect(body).toMatch(
      /async processTick\(opts\?: \{ now\?: Date; batchSize\?: number \}\): Promise<ProcessTickResult> \{\s*\n?\s*if \(this\.ticking\) \{\s*\n?\s*return \{ duePicked: 0, dispatched: 0, errors: \[\], skipped: true \};\s*\n?\s*\}\s*\n?\s*this\.ticking = true;\s*\n?\s*try \{\s*\n?\s*return await this\.runTick\(opts\);\s*\n?\s*\} finally \{\s*\n?\s*this\.ticking = false;\s*\n?\s*\}\s*\n?\s*\}/,
    );
    // Real work in runTick: batchSize default + findDue.
    expect(body).toMatch(
      /private async runTick\(opts\?: \{ now\?: Date; batchSize\?: number \}\): Promise<ProcessTickResult> \{\s*\n?\s*const now = opts\?\.now \?\? new Date\(\);\s*\n?\s*const batchSize = opts\?\.batchSize \?\? 10;\s*\n?\s*const due = await this\.repo\.findDue\(now, batchSize\);/,
    );
    expect(body).toMatch(/trigger: 'baseline_drift_detected',/);
    expect(body).toMatch(
      /\} catch \(err\) \{\s*\n?\s*errors\.push\(\{\s*\n?\s*archetypeId: sched\.archetypeId,\s*\n?\s*message: err instanceof Error \? err\.message : 'unknown',\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/return \{ duePicked: due\.length, dispatched, errors \};/);
  });

  it('processTick: schedule.reason spread via `...(sched.reason !== null ? { reason: sched.reason } : {})` pattern', () => {
    expect(body).toMatch(/\.\.\.\(sched\.reason !== null \? \{ reason: sched\.reason \} : \{\}\),/);
  });

  it('lockedVersion: stamped as BOTH baselineVersion AND targetVersion on dispatched runs (locked-archetype framing)', () => {
    expect(body).toMatch(
      /\/\*\* Used to stamp the locked-archetype baseline version on dispatched runs\. \*\/\s*\n?\s*private readonly lockedVersion: \{ iosVersion: string; safariVersion: string \},/,
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
