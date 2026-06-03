// V-218 — admin routes for the continuous validation harness.
//   GET    /v1/admin/validation-schedules            — list all
//   PUT    /v1/admin/validation-schedules            — upsert one
//   DELETE /v1/admin/validation-schedules/:archetype — remove one
//   POST   /v1/admin/validation-schedules/:archetype/trigger — manual fire

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UpsertValidationScheduleRequestSchema } from '@driftstack/api-types';
import type {
  ValidationHarnessService,
  ValidationScheduleRow,
} from '../services/validation-harness.js';
import { BadRequestError } from '../lib/errors.js';

// Manual-trigger body. `reason` is optional operator free-text persisted
// on the schedule row, so it is validated + length-capped (matching the
// 500-char cap on the force-action reason) rather than read off an
// unchecked `as`-cast — a non-string or unbounded reason must not reach
// the service / the persisted row.
const TriggerValidationScheduleBodySchema = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .optional();

function publicSchedule(row: ValidationScheduleRow): Record<string, unknown> {
  return {
    id: row.id,
    archetype_id: row.archetypeId,
    cadence_seconds: row.cadenceSeconds,
    enabled: row.enabled,
    last_run_at: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    next_run_at: row.nextRunAt.toISOString(),
    last_run_id: row.lastRunId,
    reason: row.reason,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface AdminValidationHarnessRoutesOptions {
  harness: ValidationHarnessService;
}

export function registerAdminValidationHarnessRoutes(
  app: FastifyInstance,
  opts: AdminValidationHarnessRoutesOptions,
): void {
  const { harness } = opts;

  app.get(
    '/v1/admin/validation-schedules',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const rows = await harness.list(ctx);
      return { data: rows.map(publicSchedule) };
    },
  );

  app.put(
    '/v1/admin/validation-schedules',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = UpsertValidationScheduleRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid request body.');
      const row = await harness.upsert(ctx, {
        archetypeId: parsed.data.archetype_id,
        cadenceSeconds: parsed.data.cadence_seconds,
        enabled: parsed.data.enabled,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      });
      return publicSchedule(row);
    },
  );

  app.delete<{ Params: { archetype: string } }>(
    '/v1/admin/validation-schedules/:archetype',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      await harness.remove(ctx, request.params.archetype);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { archetype: string } }>(
    '/v1/admin/validation-schedules/:archetype/trigger',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = TriggerValidationScheduleBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid request body.');
      const out = await harness.triggerNow(ctx, request.params.archetype, parsed.data?.reason);
      return { run_id: out.runId };
    },
  );
}
