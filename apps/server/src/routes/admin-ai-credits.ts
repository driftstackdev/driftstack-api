// The operator's two views of the AI-credits shadow era.
//
//   GET /v1/admin/ai-credits/shadow-report?window_days=7
//   GET /v1/admin/ai-credits/census
//
// Auth: `driftstack_internal_admin`, the same gate as every other staff route.
// Read-only, so no audit row is written — and nothing here can be narrowed to
// one customer: both answers are counts and sums over the whole deployment, and
// neither query returns an account id, an email, a session or a task.
//
// ⛔ REGISTERED ONLY WHILE THE MODE IS SHADOW OR ENFORCE. `lib/app.ts` wires
// these on `deps.aiCredits`, which bootstrap leaves absent while
// `DRIFTSTACK_AI_CREDITS_MODE` is off — so a deployment running the production
// default has no route here at all, rather than one that answers 404 and
// discloses by its very existence that the feature is built. Same posture as
// every other gated admin surface (`agentTurnSummaryService`).
//
// ⛔ AND NOTHING HERE IS PUBLISHED. The OpenAPI document must not mention AI
// credits before launch (`nothing-about-an-unreleased-feature-is-in-the-published-spec`
// holds the whole term), so these two are recorded as deliberately undocumented
// staff endpoints in `a-route-in-neither-the-spec-nor-the-docs-is-a-decision` and
// `every-registered-route-is-in-the-spec-or-exempt-for-a-stated-reason`,
// alongside `/v1/admin/agent-turns/summary`, which is withheld for the same
// V-862 reason.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError } from '../lib/errors.js';
import type { AiCreditsReportReader } from '../db/ai-credits-report-repo.js';

/**
 * The widest window the report will look back over.
 *
 * A ceiling, not a preference: the report scans `usage_records` over the window
 * and an operator who typed a year would ask for a sequential scan of the whole
 * table on a staff page nobody is watching the clock on. Thirty days covers the
 * longest §8 exit criterion ("accounts whose 30-day shadow spend exceeds their
 * allowance") with nothing to spare and nothing to argue about.
 */
export const AI_CREDITS_REPORT_MAX_WINDOW_DAYS = 30;
export const AI_CREDITS_REPORT_DEFAULT_WINDOW_DAYS = 7;

const ReportQuery = z.object({
  // Query values arrive as strings.
  window_days: z.coerce
    .number()
    .int()
    .min(1)
    .max(AI_CREDITS_REPORT_MAX_WINDOW_DAYS)
    .default(AI_CREDITS_REPORT_DEFAULT_WINDOW_DAYS),
});

export interface AdminAiCreditsRoutesDeps {
  report: AiCreditsReportReader;
  /** Injectable clock; the window is computed from it. */
  now?: () => Date;
}

export function registerAdminAiCreditsRoutes(
  app: FastifyInstance,
  deps: AdminAiCreditsRoutesDeps,
): void {
  const now = deps.now ?? ((): Date => new Date());

  app.get<{ Querystring: { window_days?: string } }>(
    '/v1/admin/ai-credits/shadow-report',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (req) => {
      const parsed = ReportQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequestError(
          `window_days must be a whole number from 1 to ${AI_CREDITS_REPORT_MAX_WINDOW_DAYS.toString()}.`,
        );
      }
      const until = now();
      const since = new Date(until.getTime() - parsed.data.window_days * 24 * 60 * 60 * 1000);
      return deps.report.shadowReport({ since, until });
    },
  );

  app.get(
    '/v1/admin/ai-credits/census',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async () => deps.report.census(),
  );
}
