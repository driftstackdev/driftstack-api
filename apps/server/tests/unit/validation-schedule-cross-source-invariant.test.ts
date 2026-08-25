// W893 — V-218 ValidationSchedule continuous-validation cross-
// source invariant. Two-hundred-nineteenth in the drift-guard
// series. Pins the V-218 continuous validation harness:
//
//   ValidationSchedule (10 fields, full read shape):
//     id + archetype_id + cadence_seconds + enabled + last_run_at
//     + next_run_at + last_run_id + reason + created_at + updated_at.
//
//   UpsertValidationScheduleRequest (4 fields):
//     - archetype_id: 1+ chars.
//     - cadence_seconds: int, 60s minimum + 1 year maximum
//       (60 * 60 * 24 * 365 = 31_536_000s).
//     - enabled?: default true.
//     - reason?: 500 chars.
//
//   ListValidationSchedulesResponse: { data: array }.
//
//   D-012 + D-025 admin-scope framing pinned at file header.
//
// stays in lockstep across:
//   - packages/api-types/src/admin.ts (Zod canonical).
//
// Drift would silently break:
//   * 60s-min cadence: would let admin create runaway-poll schedules.
//   * 1-year-max cadence: would let perpetually-stale schedules linger.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const CADENCE_MIN_SECONDS = 60;
const CADENCE_MAX_SECONDS = 60 * 60 * 24 * 365;

describe('W893 V-218 ValidationSchedule cross-source invariant', () => {
  // ─── V-218 anchor + admin-scope framing ───────────────────────

  it("CRITICAL packages/api-types/src/admin.ts pins V-218 anchor — 'V-218 — continuous validation harness'. The validation-harness is what keeps the archetype-locked driver behaviorally stable.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/V-218 — continuous validation harness/);
  });

  it("CRITICAL admin.ts file header pins admin-scope framing — 'Routes under /v1/admin/* require the admin scope (see D-012 + D-025)'. The 2-D-anchor pair points to the gating contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/Routes under \/v1\/admin\/\* require the admin/);
    expect(p).toMatch(/scope \(see D-012 \+ D-025\)/);
  });

  // ─── ValidationSchedule 10-field shape ───────────────────────

  it('CRITICAL ValidationScheduleSchema has 10 fields — id + archetype_id + cadence_seconds + enabled + last_run_at (nullable) + next_run_at + last_run_id (nullable) + reason (nullable) + created_at + updated_at. The 10-field shape is the full audit-trail-style read.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    const m = p.match(/ValidationScheduleSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of [
      'id:',
      'archetype_id:',
      'cadence_seconds:',
      'enabled:',
      'last_run_at:',
      'next_run_at:',
      'last_run_id:',
      'reason:',
      'created_at:',
      'updated_at:',
    ]) {
      expect(body, `ValidationScheduleSchema must have ${f}`).toMatch(new RegExp(f));
    }
  });

  it('CRITICAL ValidationSchedule.last_run_at + last_run_id + reason are nullable. last_run_at/last_run_id are null until first run; reason is null when no operator note attached.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    const m = p.match(/ValidationScheduleSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/last_run_at: z\.string\(\)\.nullable\(\)/);
    expect(body).toMatch(/last_run_id: z\.string\(\)\.nullable\(\)/);
    expect(body).toMatch(/reason: z\.string\(\)\.nullable\(\)/);
  });

  // ─── UpsertValidationSchedule cadence bounds ──────────────────

  it('CRITICAL UpsertValidationScheduleRequest cadence_seconds bounds = int().min(60).max(60 * 60 * 24 * 365). The 60s min prevents runaway-poll; the 1-year max prevents perpetually-stale schedules.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /UpsertValidationScheduleRequestSchema = z\.object\(\{[\s\S]+?cadence_seconds: z\s*\.number\(\)\s*\n\s*\.int\(\)\s*\n\s*\.min\(60\)\s*\n\s*\.max\(60 \* 60 \* 24 \* 365\)/,
    );
    // Sanity: the cadence-max evaluates to 1 year in seconds.
    expect(CADENCE_MAX_SECONDS).toBe(31_536_000);
    expect(CADENCE_MIN_SECONDS).toBe(60);
  });

  it('CRITICAL UpsertValidationScheduleRequest 4-field shape — archetype_id (1+) + cadence_seconds (bounded) + enabled (default true) + reason (max 500 optional). enabled.default(true) means new schedules start active.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /UpsertValidationScheduleRequestSchema = z\.object\(\{[\s\S]+?archetype_id: z\.string\(\)\.min\(1\)/,
    );
    expect(p).toMatch(
      /UpsertValidationScheduleRequestSchema[\s\S]+?enabled: z\.boolean\(\)\.optional\(\)\.default\(true\)/,
    );
    expect(p).toMatch(
      /UpsertValidationScheduleRequestSchema[\s\S]+?reason: z\.string\(\)\.max\(500\)\.optional\(\)/,
    );
  });

  // ─── ListValidationSchedules response shape ──────────────────

  it('CRITICAL ListValidationSchedulesResponseSchema = { data: z.array(ValidationScheduleSchema) } — simple wrapper. No pagination (validation-schedule list is bounded by archetype count).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /ListValidationSchedulesResponseSchema = z\.object\(\{\s*\n\s*data: z\.array\(ValidationScheduleSchema\),\s*\n\s*\}\);/,
    );
  });

  // ─── Cadence bound semantics ─────────────────────────────────

  it('CRITICAL cadence_seconds bound rationale — 60s minimum is the minimum poll interval that lets driver-harness runs complete + clean up before next; 1 year maximum is the policy upper-bound for "is this schedule still relevant?" ops review.', () => {
    expect(CADENCE_MIN_SECONDS).toBe(60);
    expect(CADENCE_MAX_SECONDS).toBe(31_536_000);
    // Sanity: 1 year in seconds.
    expect(CADENCE_MAX_SECONDS).toBe(60 * 60 * 24 * 365);
  });

  // ─── Types re-exported ───────────────────────────────────────

  it('CRITICAL all 3 schemas re-export z.infer types — ValidationSchedule + UpsertValidationScheduleRequest + ListValidationSchedulesResponse. Drift-proof typed-import for admin-panel consumers.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /export type ValidationSchedule = z\.infer<typeof ValidationScheduleSchema>;/,
    );
    expect(p).toMatch(
      /export type UpsertValidationScheduleRequest = z\.infer<typeof UpsertValidationScheduleRequestSchema>;/,
    );
    expect(p).toMatch(
      /export type ListValidationSchedulesResponse = z\.infer<typeof ListValidationSchedulesResponseSchema>;/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/validation-schedule-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
