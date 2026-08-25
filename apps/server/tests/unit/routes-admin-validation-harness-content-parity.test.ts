// W416.B — drift guard for apps/server/src/routes/admin-validation-harness.ts.
// V-218 admin routes for the continuous validation harness. CRUD +
// trigger-now manual fire. Drift here either drops the scope-gate on
// any of the 4 routes (lets non-admin scopes mutate validation
// schedules) or breaks the wire shape (snake_case vs camelCase
// columns) so the admin GUI table stops parsing rows.
//
//   • V-218 framing pinned: 4 routes — GET (list all) + PUT (upsert
//     one) + DELETE (remove one) + POST trigger (manual fire).
//   • UpsertValidationScheduleRequestSchema from @driftstack/api-types
//     (SDK mirror).
//   • Scope-gate posture: requireScope('driftstack_internal_admin') +
//     rateLimit('global') on ALL 4 routes.
//   • publicSchedule: id + archetype_id + cadence_seconds + enabled +
//     last_run_at nullable ISO + next_run_at ISO + last_run_id +
//     reason + created_at/updated_at ISO.
//   • Upsert: snake-case → camelCase + spread-conditional `reason`.
//   • Delete: 204 reply; route param `:archetype` passed verbatim.
//   • Trigger: body zod-validated (reason optional, ≤500) →
//     parsed.data?.reason; returns { run_id }.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-validation-harness.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W416.B apps/server/src/routes/admin-validation-harness.ts content parity', () => {
  const body = read(LIB);

  it('V-218 framing pinned: 4 routes — list + upsert + remove + manual-fire trigger', () => {
    expect(body).toMatch(/V-218 — admin routes for the continuous validation harness\./);
    expect(body).toMatch(/GET\s+\/v1\/admin\/validation-schedules\s+— list all/);
    expect(body).toMatch(/PUT\s+\/v1\/admin\/validation-schedules\s+— upsert one/);
    expect(body).toMatch(/DELETE \/v1\/admin\/validation-schedules\/:archetype — remove one/);
    expect(body).toMatch(
      /POST\s+\/v1\/admin\/validation-schedules\/:archetype\/trigger — manual fire/,
    );
  });

  it('publicSchedule: id + archetype_id + cadence_seconds + enabled + nullable last_run_at ISO + next_run_at ISO + reason + created/updated ISO', () => {
    expect(body).toMatch(
      /function publicSchedule\(row: ValidationScheduleRow\): Record<string, unknown> \{/,
    );
    expect(body).toMatch(/id: row\.id,/);
    expect(body).toMatch(/archetype_id: row\.archetypeId,/);
    expect(body).toMatch(/cadence_seconds: row\.cadenceSeconds,/);
    expect(body).toMatch(/enabled: row\.enabled,/);
    expect(body).toMatch(/last_run_at: row\.lastRunAt \? row\.lastRunAt\.toISOString\(\) : null,/);
    expect(body).toMatch(/next_run_at: row\.nextRunAt\.toISOString\(\),/);
    expect(body).toMatch(/last_run_id: row\.lastRunId,/);
    expect(body).toMatch(/reason: row\.reason,/);
    expect(body).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
    expect(body).toMatch(/updated_at: row\.updatedAt\.toISOString\(\),/);
  });

  it("Scope-gate on ALL 4 routes: requireScope('driftstack_internal_admin') + rateLimit('global')", () => {
    const matches = body.match(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/g,
    );
    expect(matches?.length).toBe(4);
  });

  it('UpsertValidationScheduleRequestSchema imported from @driftstack/api-types (SDK mirror)', () => {
    expect(body).toMatch(
      /import \{ UpsertValidationScheduleRequestSchema \} from '@driftstack\/api-types';/,
    );
  });

  it('GET: harness.list(ctx) + { data: rows.map(publicSchedule) }', () => {
    expect(body).toMatch(
      /app\.get\(\s*'\/v1\/admin\/validation-schedules',[\s\S]+?const rows = await harness\.list\(ctx\);\s*return \{ data: rows\.map\(publicSchedule\) \};/,
    );
  });

  it("PUT upsert: zod safeParse → 400 'Invalid request body.'; snake→camel + spread-conditional reason; returns publicSchedule(row); D-025 audit-gap fix wraps the call in withAudit action validation_schedule.upserted", () => {
    expect(body).toMatch(
      /const parsed = UpsertValidationScheduleRequestSchema\.safeParse\(request\.body \?\? \{\}\);\s*if \(!parsed\.success\) throw new BadRequestError\('Invalid request body\.'\);/,
    );
    expect(body).toMatch(
      /const row = await withAudit\(\s*request,\s*'validation_schedule\.upserted',\s*parsed\.data\.archetype_id,/,
    );
    expect(body).toMatch(
      /harness\.upsert\(ctx, \{\s*archetypeId: parsed\.data\.archetype_id,\s*cadenceSeconds: parsed\.data\.cadence_seconds,\s*enabled: parsed\.data\.enabled,\s*\.\.\.\(parsed\.data\.reason !== undefined \? \{ reason: parsed\.data\.reason \} : \{\}\),\s*\}\),/,
    );
    expect(body).toMatch(/return publicSchedule\(row\);/);
  });

  it('DELETE: typed :archetype Params; harness.remove(ctx, archetype) wrapped in withAudit action validation_schedule.removed; 204 reply', () => {
    expect(body).toMatch(
      /app\.delete<\{ Params: \{ archetype: string \} \}>\(\s*'\/v1\/admin\/validation-schedules\/:archetype',/,
    );
    expect(body).toMatch(
      /await withAudit\(request, 'validation_schedule\.removed', request\.params\.archetype, \{\}, \(\) =>\s*harness\.remove\(ctx, request\.params\.archetype\),\s*\);/,
    );
    expect(body).toMatch(/return reply\.code\(204\)\.send\(\);/);
  });

  it('POST trigger: body validated (reason optional, capped) → parsed.data?.reason; harness.triggerNow returns runId wrapped in withAudit action validation_schedule.triggered; reply { run_id }', () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ archetype: string \} \}>\(\s*'\/v1\/admin\/validation-schedules\/:archetype\/trigger',/,
    );
    // Body is zod-validated + length-capped (no unchecked `as` cast).
    expect(body).toMatch(/reason: z\.string\(\)\.min\(1\)\.max\(500\)\.optional\(\),/);
    expect(body).toMatch(
      /const parsed = TriggerValidationScheduleBodySchema\.safeParse\(request\.body \?\? \{\}\);/,
    );
    expect(body).toMatch(
      /if \(!parsed\.success\) throw new BadRequestError\('Invalid request body\.'\);/,
    );
    expect(body).toMatch(
      /const out = await withAudit\(\s*request,\s*'validation_schedule\.triggered',\s*request\.params\.archetype,/,
    );
    expect(body).toMatch(
      /\(\) => harness\.triggerNow\(ctx, request\.params\.archetype, parsed\.data\?\.reason\),/,
    );
    expect(body).toMatch(/return \{ run_id: out\.runId \};/);
  });

  it('Account-context invariant: !ctx → "account context missing after requireAuth" in every handler + the D-025 withAudit helper (5 total: 4 route handlers + withAudit)', () => {
    const matches = body.match(
      /if \(!ctx\) throw new Error\('account context missing after requireAuth'\);/g,
    );
    expect(matches?.length).toBe(5);
  });

  it('AdminValidationHarnessRoutesOptions: { harness: ValidationHarnessService; audit: AdminAuditService } (D-025 audit-gap fix)', () => {
    expect(body).toMatch(
      /export interface AdminValidationHarnessRoutesOptions \{\s*harness: ValidationHarnessService;/,
    );
    expect(body).toMatch(/audit: AdminAuditService;/);
  });

  it('imports: FastifyInstance + FastifyRequest + ValidationHarnessService/ValidationScheduleRow + BadRequestError + AdminAuditService/AdminAuditAction + readClientIp (D-025 audit-gap fix)', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{\s*ValidationHarnessService,\s*ValidationScheduleRow,\s*\} from '\.\.\/services\/validation-harness\.js';/,
    );
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(
      /import type \{ AdminAuditService, AdminAuditAction \} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
  });

  it('D-025 audit-gap fix: withAudit helper wraps upsert/remove/trigger with audit-on-success + audit-on-error, matching admin-accounts.ts withAudit shape', () => {
    expect(body).toMatch(
      /async function withAudit<T>\(\s*request: FastifyRequest,\s*action: AdminAuditAction,\s*archetypeId: string,\s*inputPayload: Record<string, unknown>,\s*perform: \(\) => Promise<T>,\s*\): Promise<T> \{/,
    );
    expect(body).toMatch(/result: 'success',/);
    expect(body).toMatch(/result: `error: \$\{code\}`,/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
