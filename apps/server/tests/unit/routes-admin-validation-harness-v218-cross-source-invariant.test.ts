// W1032 — routes/admin-validation-harness V-218 cross-source
// invariant. Three-hundred-fifty-eighth in the drift-guard series.
// Pins the apps/server/src/routes/admin-validation-harness.ts admin
// schedule routes:
//
//   V-218 anchor — 'V-218 — admin routes for the continuous
//   validation harness'.
//
//   4-endpoint inventory:
//     - GET    /v1/admin/validation-schedules            — list all.
//     - PUT    /v1/admin/validation-schedules            — upsert.
//     - DELETE /v1/admin/validation-schedules/:archetype — remove.
//     - POST   /v1/admin/validation-schedules/:archetype/trigger.
//
//   All preHandler [requireScope('driftstack_internal_admin'),
//     rateLimit('global')].
//
//   PUT body — UpsertValidationScheduleRequestSchema (api-types) +
//     BadRequestError on Zod fail.
//
//   PUT upsert maps snake → camel — archetype_id → archetypeId +
//     cadence_seconds → cadenceSeconds + enabled + optional reason.
//
//   DELETE returns 204 No Content.
//
//   trigger POST — body zod-validated (reason optional, ≤500; no `as`
//   cast) then returns { run_id: out.runId }.
//
//   publicSchedule 10-field — id + archetype_id + cadence_seconds +
//     enabled + nullable last_run_at (ISO) + next_run_at (ISO) +
//     last_run_id + reason + created_at (ISO) + updated_at (ISO).
//
// stays in lockstep across apps/server/src/routes/admin-validation-harness.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1032 routes/admin-validation-harness V-218 cross-source invariant', () => {
  it('CRITICAL V-218 anchor + 4-endpoint inventory.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-validation-harness.ts'));
    expect(p).toMatch(/V-218 — admin routes for the continuous validation harness\./);
    expect(p).toMatch(/GET\s+\/v1\/admin\/validation-schedules\s+— list all/);
    expect(p).toMatch(/PUT\s+\/v1\/admin\/validation-schedules\s+— upsert one/);
    expect(p).toMatch(/DELETE \/v1\/admin\/validation-schedules\/:archetype — remove one/);
    expect(p).toMatch(
      /POST\s+\/v1\/admin\/validation-schedules\/:archetype\/trigger — manual fire/,
    );
  });

  it("CRITICAL all 4 routes preHandler [requireScope('driftstack_internal_admin'), rateLimit('global')].", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-validation-harness.ts'));
    const matches =
      p.match(
        /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\]/g,
      ) ?? [];
    expect(matches.length).toBe(4);
  });

  it('CRITICAL PUT body validated via UpsertValidationScheduleRequestSchema + BadRequestError on fail.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-validation-harness.ts'));
    expect(p).toMatch(
      /import \{ UpsertValidationScheduleRequestSchema \} from '@driftstack\/api-types';/,
    );
    expect(p).toMatch(
      /const parsed = UpsertValidationScheduleRequestSchema\.safeParse\(request\.body \?\? \{\}\);/,
    );
    expect(p).toMatch(
      /if \(!parsed\.success\) throw new BadRequestError\('Invalid request body\.'\);/,
    );
  });

  it('CRITICAL PUT upsert snake→camel mapping — archetype_id→archetypeId + cadence_seconds→cadenceSeconds + enabled + optional reason.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-validation-harness.ts'));
    expect(p).toMatch(/archetypeId: parsed\.data\.archetype_id,/);
    expect(p).toMatch(/cadenceSeconds: parsed\.data\.cadence_seconds,/);
    expect(p).toMatch(/enabled: parsed\.data\.enabled,/);
    expect(p).toMatch(
      /\.\.\.\(parsed\.data\.reason !== undefined \? \{ reason: parsed\.data\.reason \} : \{\}\),/,
    );
  });

  it('CRITICAL DELETE returns 204 No Content + trigger POST validates its body (reason ≤500, no `as` cast) then returns { run_id: out.runId }.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-validation-harness.ts'));
    expect(p).toMatch(/await harness\.remove\(ctx, request\.params\.archetype\);/);
    expect(p).toMatch(/return reply\.code\(204\)\.send\(\);/);
    // Trigger body is zod-validated + capped (no unchecked `as` cast).
    expect(p).toMatch(
      /const parsed = TriggerValidationScheduleBodySchema\.safeParse\(request\.body \?\? \{\}\);/,
    );
    expect(p).toMatch(/reason: z\.string\(\)\.min\(1\)\.max\(500\)\.optional\(\),/);
    expect(p).toMatch(
      /const out = await harness\.triggerNow\(ctx, request\.params\.archetype, parsed\.data\?\.reason\);/,
    );
    expect(p).toMatch(/return \{ run_id: out\.runId \};/);
  });

  it('CRITICAL publicSchedule 10-field — id + archetype_id + cadence_seconds + enabled + nullable last_run_at + next_run_at + last_run_id + reason + created_at + updated_at.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-validation-harness.ts'));
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/archetype_id: row\.archetypeId,/);
    expect(p).toMatch(/cadence_seconds: row\.cadenceSeconds,/);
    expect(p).toMatch(/enabled: row\.enabled,/);
    expect(p).toMatch(/last_run_at: row\.lastRunAt \? row\.lastRunAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/next_run_at: row\.nextRunAt\.toISOString\(\),/);
    expect(p).toMatch(/last_run_id: row\.lastRunId,/);
    expect(p).toMatch(/reason: row\.reason,/);
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
    expect(p).toMatch(/updated_at: row\.updatedAt\.toISOString\(\),/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-validation-harness-v218-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
