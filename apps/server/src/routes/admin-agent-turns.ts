// Admin view of the AI automation's health.
//
//   GET /v1/admin/agent-turns/summary?window_hours=24
//
// Auth: driftstack_internal_admin scope, the same gate as every other staff
// route. Read-only; no audit row is written, because nothing customer-specific
// is read — the underlying table holds no account, session, task, URL or answer
// (see services/agent-turn-telemetry.ts), so this response is aggregates over
// the whole deployment and cannot be narrowed to one customer.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError } from '../lib/errors.js';
import {
  AGENT_TURN_SUMMARY_DEFAULT_WINDOW_HOURS,
  AGENT_TURN_SUMMARY_MAX_WINDOW_HOURS,
  type AgentTurnSummaryService,
} from '../services/agent-turn-summary.js';

export interface AdminAgentTurnsRoutesDeps {
  summary: AgentTurnSummaryService;
}

const SummaryQuery = z.object({
  // Query values arrive as strings. Bounded by the retention window: asking
  // for longer than is kept would return a number that silently means less
  // than its label says.
  window_hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(AGENT_TURN_SUMMARY_MAX_WINDOW_HOURS)
    .default(AGENT_TURN_SUMMARY_DEFAULT_WINDOW_HOURS),
});

export function registerAdminAgentTurnsRoutes(
  app: FastifyInstance,
  deps: AdminAgentTurnsRoutesDeps,
): void {
  app.get<{ Querystring: { window_hours?: string } }>(
    '/v1/admin/agent-turns/summary',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (req) => {
      const parsed = SummaryQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequestError(
          `window_hours must be a whole number from 1 to ${AGENT_TURN_SUMMARY_MAX_WINDOW_HOURS.toString()}.`,
        );
      }
      return deps.summary.summarize(parsed.data.window_hours);
    },
  );
}
