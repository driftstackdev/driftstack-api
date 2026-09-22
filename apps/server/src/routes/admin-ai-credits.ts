// The operator's views and tools for AI credits.
//
//   GET  /v1/admin/ai-credits/shadow-report?window_days=7
//   GET  /v1/admin/ai-credits/census
//   GET  /v1/admin/accounts/:id/credits
//   POST /v1/admin/accounts/:id/credits/adjustments
//   PUT/DELETE /v1/admin/accounts/:id/ai-plan-override
//   POST/GET /v1/admin/credit-rate-cards
//   POST /v1/admin/credit-rate-cards/:version/withdraw
//   POST /v1/admin/ai-credits/cutover    (S16 — move accounts onto credits)
//   POST /v1/admin/ai-credits/rollback   (S16 — move one account back)
//
// Auth: `driftstack_internal_admin` for every route above except the two rate-
// card MUTATIONS (publish, withdraw), which are OWNER-ONLY — `app.requireOwner`,
// an identity check against `DRIFTSTACK_OWNER_EMAIL`, not a staff scope (see
// `middleware/auth.ts`). A rate card sets what every customer on credits pays;
// `routes/admin-owner.ts` already gates the platform's other high-power,
// money-shaped surfaces (pricing, secrets) the same way, and the codebase has
// no stronger admin gate than that identity check — "find how owner is
// expressed... if none exists, refuse to invent one" (S15 brief) is answered
// by reusing exactly that gate rather than adding a new scope. GET-ing the
// list of cards stays staff-scoped: reading is not the power this route
// guards.
//
// ⛔ REGISTERED ONLY WHILE THE MODE IS SHADOW OR ENFORCE (`deps.aiCredits !==
// undefined`), same posture as every other credits-gated admin surface.
//
// ⛔ AND NOTHING HERE IS PUBLISHED. Same reasons as the two original routes
// below: `a-route-in-neither-the-spec-nor-the-docs-is-a-decision`,
// `every-registered-route-is-in-the-spec-or-exempt-for-a-stated-reason`,
// `openapi-route-coverage-invariant` all carry every route this file
// registers with the same "staff panel only; AI credits are dark" reason.
//
// AUDIT (D-025). Every route that WRITES calls `deps.adminAudit.record(...)`
// before returning — except a call that changed nothing: a repeat adjustment
// on an already-used idempotency key, or a plan-override DELETE with no live
// override to end. Those write nothing to the ledger either, so there is
// nothing new to attribute; a second `adminAudit` row for the SAME action
// already on file would be the thing that misleads an auditor, not the thing
// that protects them. Same rule for S16's two routes: `credits.cutover_moved`
// is written once per account actually MOVED (never for `already_moved`,
// `not_eligible` or `refuse`, and never at all for a `dry_run`), and
// `credits.cutover_rolled_back` only for an account that WAS on credits
// (never for `not_moved`, and never for a `dry_run`).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AdminCreditAdjustmentRequestSchema,
  AdminRateCardPublishRequestSchema,
  AdminSetPlanOverrideRequestSchema,
  AiCreditsCutoverRequestSchema,
  AiCreditsRollbackRequestSchema,
  creditsToMicro,
  type AdminCreditAdjustmentResponse,
  type AdminCreditsAccountState,
  type AdminPlanOverrideView,
  type AdminRateCardListResponse,
  type AdminRateCardView,
  type AiCreditsCutoverDecision,
  type AiCreditsCutoverResponse,
  type AiCreditsRollbackResponse,
} from '@driftstack/api-types';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';
import type { AiCreditsReportReader } from '../db/ai-credits-report-repo.js';
import {
  CreditLedgerKeyReusedError,
  CreditLotGrantKeyReusedError,
  type CreditLotRecord,
} from '../db/credit-ledger-repo.js';
import { RateCardRefusedError } from '../db/credit-rate-card-repo.js';
import {
  candidateRateCardModels,
  deriveRateCardRows,
} from '../services/credit-rate-card-publisher.js';
import { refreshCreditsAfter } from '../services/credit-grants.js';
import { buildLedgerEntry } from '../services/ai-account-state.js';
import {
  PhaseTwoCohortError,
  summarizeCutoverDecisions,
  type CutoverDecision,
  type CutoverSelector,
} from '../services/credit-cutover.js';
import type {
  AiCreditsAdminSurface,
  AiCreditsCutoverSurface,
  AiCreditsRuntime,
  AiCreditsStateReads,
} from '../services/ai-credits-runtime.js';
import type { DrizzleAiCreditsAdminAuditRepo } from '../db/ai-credits-admin-audit-repo.js';
import type { AccountAuthRepo } from '../services/auth.js';
import {
  buildAdminCreditsAccountState,
  buildForgiveDebtAdjustmentResponse,
  buildGoodwillAdjustmentResponse,
  buildAdminRateCardView,
  buildPlanOverrideView,
  classifyRateCardRefusals,
  clearsNoticeWindow,
  goodwillGrantKey,
  RATE_CARD_NOTICE_HOURS,
} from '../services/admin-credits.js';

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
  /** S15 — the admin mutation surface + the S14 read bundle, both required by
   *  the routes below (the original two routes above use only `report`). */
  aiCredits: AiCreditsRuntime;
  adminAudit: Pick<DrizzleAiCreditsAdminAuditRepo, 'record'>;
  authRepo: Pick<AccountAuthRepo, 'getAccount'>;
  /** Injectable clock; the shadow-report window AND the rate-card notice
   *  check are both computed from it. */
  now?: () => Date;
}

/** Same shape as every other `acc_<uuid>` parser in the admin route family
 *  (`routes/admin-accounts.ts` etc.) — not shared, by the same precedent. */
const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth/requireOwner');
  return request.account;
}

function requireStateReads(aiCredits: AiCreditsRuntime): AiCreditsStateReads {
  if (aiCredits.stateReads === undefined) {
    throw new Error(
      'aiCredits.stateReads is required by routes/admin-ai-credits.ts; this AiCreditsRuntime fixture predates S14',
    );
  }
  return aiCredits.stateReads;
}

function requireAdmin(aiCredits: AiCreditsRuntime): AiCreditsAdminSurface {
  if (aiCredits.admin === undefined) {
    throw new Error(
      'aiCredits.admin is required by routes/admin-ai-credits.ts; this AiCreditsRuntime fixture predates S15',
    );
  }
  return aiCredits.admin;
}

function requireCutover(aiCredits: AiCreditsRuntime): AiCreditsCutoverSurface {
  if (aiCredits.cutover === undefined) {
    throw new Error(
      'aiCredits.cutover is required by routes/admin-ai-credits.ts; this AiCreditsRuntime fixture predates S16',
    );
  }
  return aiCredits.cutover;
}

/**
 * §4.1's table, restated as a clear refusal rather than a silent no-op:
 * `billing_mode = 'credits'` means "moved" only under `enforce` —
 * `routes/account-ai.ts`'s `isMoved` and `routes/account-bundled-llm.ts`'s
 * `resolveMovedAccount` gate every customer-facing surface the same way. A
 * cutover in `shadow` mode would set `billing_mode` on an account nothing
 * customer-facing yet treats as moved, so it is refused before it writes
 * anything.
 */
function requireEnforceMode(aiCredits: AiCreditsRuntime, action: 'cutover' | 'rollback'): void {
  if (aiCredits.mode !== 'enforce') {
    throw new ConflictError(
      `AI-credits ${action} requires enforce mode; this deployment is in ${aiCredits.mode} mode.`,
      { ai_credits_mode: aiCredits.mode },
    );
  }
}

/** {@link CutoverDecision} on the wire: `account_id` prefixed, `accountId` dropped. */
function toWireCutoverDecision(d: CutoverDecision): AiCreditsCutoverDecision {
  const account_id = `acc_${d.accountId}`;
  switch (d.outcome) {
    case 'move':
      return { outcome: 'move', account_id, ai_source: d.aiSource };
    case 'already_moved':
      return { outcome: 'already_moved', account_id };
    case 'not_eligible':
      return { outcome: 'not_eligible', account_id, reason: d.reason };
    case 'refuse':
      return { outcome: 'refuse', account_id, reason: d.reason };
  }
}

/** The start of the whole UTC minute BEFORE the one `at` falls in — see the
 *  call site's own comment for why a goodwill lot's `starts_at` is computed
 *  this way rather than as `at` itself. */
function floorToPriorMinute(at: Date): Date {
  const MINUTE_MS = 60_000;
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS);
}

export function registerAdminAiCreditsRoutes(
  app: FastifyInstance,
  deps: AdminAiCreditsRoutesDeps,
): void {
  const { aiCredits, adminAudit, authRepo } = deps;
  const now = deps.now ?? ((): Date => new Date());

  async function requireAccountExists(accountId: string): Promise<void> {
    const account = await authRepo.getAccount(accountId);
    if (account === null) throw new NotFoundError(`Account "acc_${accountId}" not found.`);
  }

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

  // ── GET /v1/admin/accounts/:id/credits ──────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/credits',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request): Promise<AdminCreditsAccountState> => {
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      await requireAccountExists(accountId);
      const stateReads = requireStateReads(aiCredits);
      const admin = requireAdmin(aiCredits);

      const [account, currentWindow] = await Promise.all([
        aiCredits.accounts.ensureAccount(accountId),
        aiCredits.windows.currentWindow(accountId),
      ]);
      const [
        availableMicro,
        monthlyLot,
        extraLots,
        debtReason,
        reservationsInFlight,
        override,
        ledgerPage,
      ] = await Promise.all([
        aiCredits.accounts.spendableMicro(accountId),
        currentWindow === null
          ? Promise.resolve(null)
          : stateReads.monthlyLotForWindow(accountId, currentWindow.id),
        stateReads.liveExtraLots(accountId),
        stateReads.latestDebtReason(accountId),
        stateReads.openEnforceCountNoLock(accountId),
        admin.planOverrides.get(accountId),
        stateReads.ledgerPageWithBalance(accountId, { limit: 20 }),
      ]);
      const lots: CreditLotRecord[] = [...(monthlyLot === null ? [] : [monthlyLot]), ...extraLots];

      return buildAdminCreditsAccountState({
        publicAccountId: `acc_${accountId}`,
        billingMode: account.billingMode,
        aiSource: account.aiSource,
        aiSourceSetBy: account.aiSourceSetBy,
        aiSourceSetAt: account.aiSourceSetAt,
        currentWindow:
          currentWindow === null
            ? null
            : { windowStart: currentWindow.windowStart, windowEnd: currentWindow.windowEnd },
        lots,
        availableMicro,
        debtMicro: account.debtMicro,
        debtReason,
        reservationsInFlight,
        planOverride: override,
        ledger: ledgerPage.entries.map((entry) =>
          buildLedgerEntry({
            id: entry.id,
            kind: entry.kind,
            deltaMicro: entry.lotDeltaMicro - entry.debtDeltaMicro,
            balanceAfterMicro: entry.balanceAfterMicro,
            createdAt: entry.createdAt,
            lotExpiresAt: entry.lotExpiresAt,
            agentSessionId: entry.agentSessionId,
            model: entry.model,
            rateCardVersion: entry.rateCardVersion,
          }),
        ),
      });
    },
  );

  // ── POST /v1/admin/accounts/:id/credits/adjustments ─────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/credits/adjustments',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request): Promise<AdminCreditAdjustmentResponse> => {
      const ctx = requireCtx(request);
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      await requireAccountExists(accountId);
      const parsed = AdminCreditAdjustmentRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const admin = requireAdmin(aiCredits);

      if (parsed.data.kind === 'goodwill') {
        const { credits, expires_at, reason, idempotency_key } = parsed.data;
        const expiresAt = new Date(expires_at);
        let applied: boolean;
        let lot: CreditLotRecord;
        let debtAfterMicro: number;
        try {
          const result = await admin.transaction(async (tx) => {
            await admin.lockAccount(tx, accountId);
            const inserted = await admin.insertLot(
              {
                accountId,
                kind: 'adjustment',
                grantKey: goodwillGrantKey(accountId, idempotency_key),
                grantedMicro: creditsToMicro(credits),
                // The start of the PRIOR whole minute, not `now()` itself,
                // for two reasons at once:
                //   1. The column is compared against the DATABASE's now()
                //      (the transaction's start, frozen for its whole
                //      duration), and this process's clock reading is taken a
                //      few statements INTO that same transaction — an exact
                //      `now()` here can land a hair after the transaction's
                //      own, making the lot read as "not started yet" to every
                //      `starts_at <= now()` filter (`spendableMicro`,
                //      `settleDebtFromFree`, `reserve()`) for the rest of the
                //      transaction it was funded in. `credit-windows-repo.ts`
                //      never hits this because it derives `starts_at` from a
                //      SQL expression, never a JS Date. A floor to the
                //      CURRENT minute is not enough on its own — a request
                //      that lands right at a minute boundary can still floor
                //      to a value a few ms after the transaction's own now();
                //      going back one whole extra minute clears that too.
                //   2. `insertLot` is idempotent on `grantKey` ONLY when a
                //      repeat call sends the SAME `startsAt` — an unrounded
                //      `now()` differs on every call by construction, so a
                //      genuine retry of the SAME request would be read as a
                //      different one and refused as a grant-key reuse.
                //      Flooring to a whole minute makes same-minute retries
                //      agree; going back one further minute is pure margin
                //      for reason 1 and does not change that.
                startsAt: floorToPriorMinute(now()),
                expiresAt,
              },
              tx,
            );
            const appendResult = await admin.append(
              {
                accountId,
                kind: 'grant',
                lotId: inserted.lot.id,
                amountMicro: inserted.lot.grantedMicro,
                idempotencyKey: `admin_goodwill:${idempotency_key}`,
                actor: 'admin',
                reason,
              },
              tx,
            );
            // A goodwill grant is free credit; the database refuses to COMMIT
            // debt beside spendable credit, so any standing debt is settled
            // from it here — see AiCreditsAdminSurface's own doc comment.
            await admin.settleDebtFromFree(tx, accountId);
            const after = await admin.lockAccount(tx, accountId);
            // `inserted.lot` is a snapshot from BEFORE the grant (and any
            // debt settlement) funded or drew it down — a lot is born with
            // `remaining_micro = 0` — so the response reads the lot back
            // rather than reusing that stale snapshot.
            const fundedLot = await admin.getLot(inserted.lot.id, tx);
            if (fundedLot === null) {
              throw new Error(`goodwill lot ${inserted.lot.id} vanished after it was funded`);
            }
            return {
              lot: fundedLot,
              applied: appendResult.applied,
              debtAfterMicro: after.debtMicro,
            };
          });
          applied = result.applied;
          lot = result.lot;
          debtAfterMicro = result.debtAfterMicro;
        } catch (err) {
          if (
            err instanceof CreditLotGrantKeyReusedError ||
            err instanceof CreditLedgerKeyReusedError
          ) {
            throw new ConflictError(
              'This idempotency key was already used for a different goodwill grant.',
            );
          }
          throw err;
        }
        if (applied) {
          await adminAudit.record({
            adminAccountId: ctx.account.id,
            adminKeyId: ctx.apiKey.id,
            action: 'credits.goodwill_granted',
            targetAccountId: accountId,
            inputPayload: { credits, expires_at, reason, idempotency_key },
            result: 'success',
            ipAddress: readClientIp(request),
          });
        }
        return buildGoodwillAdjustmentResponse({ applied, lot, debtMicro: debtAfterMicro });
      }

      // kind === 'forgive_debt'
      const { reason, idempotency_key } = parsed.data;
      let applied: boolean;
      let forgivenMicro: number;
      let debtAfterMicro: number;
      try {
        const result = await admin.transaction(async (tx) => {
          const before = await admin.lockAccount(tx, accountId);
          if (before.debtMicro <= 0) {
            return { applied: false, forgivenMicro: 0, debtAfterMicro: before.debtMicro };
          }
          const appendResult = await admin.append(
            {
              accountId,
              kind: 'adjustment',
              forgiveDebtMicro: before.debtMicro,
              idempotencyKey: `admin_forgive_debt:${idempotency_key}`,
              actor: 'admin',
              reason,
            },
            tx,
          );
          const after = await admin.lockAccount(tx, accountId);
          return {
            applied: appendResult.applied,
            forgivenMicro: before.debtMicro,
            debtAfterMicro: after.debtMicro,
          };
        });
        applied = result.applied;
        forgivenMicro = result.forgivenMicro;
        debtAfterMicro = result.debtAfterMicro;
      } catch (err) {
        if (err instanceof CreditLedgerKeyReusedError) {
          throw new ConflictError(
            'This idempotency key was already used for a different debt forgiveness.',
          );
        }
        throw err;
      }
      if (applied) {
        await adminAudit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'credits.debt_forgiven',
          targetAccountId: accountId,
          inputPayload: { reason, idempotency_key },
          result: 'success',
          ipAddress: readClientIp(request),
        });
      }
      return buildForgiveDebtAdjustmentResponse({
        applied,
        forgivenMicro,
        debtMicro: debtAfterMicro,
      });
    },
  );

  // ── PUT/DELETE /v1/admin/accounts/:id/ai-plan-override ──────────────────
  app.put<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/ai-plan-override',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request): Promise<AdminPlanOverrideView> => {
      const ctx = requireCtx(request);
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      await requireAccountExists(accountId);
      const parsed = AdminSetPlanOverrideRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const admin = requireAdmin(aiCredits);

      const record = await admin.planOverrides.upsert({
        accountId,
        monthlyCredits: parsed.data.monthly_credits,
        reason: parsed.data.reason,
        endsAt: parsed.data.expires_at === undefined ? null : new Date(parsed.data.expires_at),
        setByKeyId: ctx.apiKey.id,
      });
      // §6.6 — the current window follows the new override immediately,
      // rather than waiting for the next billing event or sweep tick.
      await refreshCreditsAfter({ refreshCredits: admin.refreshCredits }, accountId, {
        trigger: 'admin_tier_change',
        rethrowTransient: false,
        logger: request.log,
      });
      await adminAudit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action: 'credits.plan_override_set',
        targetAccountId: accountId,
        inputPayload: {
          monthly_credits: parsed.data.monthly_credits,
          reason: parsed.data.reason,
          ...(parsed.data.expires_at !== undefined ? { expires_at: parsed.data.expires_at } : {}),
        },
        result: 'success',
        ipAddress: readClientIp(request),
      });
      return buildPlanOverrideView(record);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/ai-plan-override',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request): Promise<{ removed: boolean }> => {
      const ctx = requireCtx(request);
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      await requireAccountExists(accountId);
      const admin = requireAdmin(aiCredits);

      const removed = await admin.planOverrides.end(accountId);
      if (removed) {
        await refreshCreditsAfter({ refreshCredits: admin.refreshCredits }, accountId, {
          trigger: 'admin_tier_change',
          rethrowTransient: false,
          logger: request.log,
        });
        await adminAudit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'credits.plan_override_cleared',
          targetAccountId: accountId,
          inputPayload: {},
          result: 'success',
          ipAddress: readClientIp(request),
        });
      }
      return { removed };
    },
  );

  // ── POST/GET /v1/admin/credit-rate-cards, POST .../:version/withdraw ────
  // Publish and withdraw are OWNER-ONLY (`app.requireOwner`) — see the file
  // header. Listing stays staff-scoped.
  app.post(
    '/v1/admin/credit-rate-cards',
    {
      preHandler: [app.requireOwner, app.rateLimit('global')],
    },
    async (request): Promise<AdminRateCardView> => {
      const ctx = requireCtx(request);
      const parsed = AdminRateCardPublishRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const admin = requireAdmin(aiCredits);

      const effectiveAt = new Date(parsed.data.effective_at);
      const models = candidateRateCardModels();
      const derived = deriveRateCardRows({ markupBp: parsed.data.markup_bp, models });
      if (!derived.ok) {
        const { status, detail } = classifyRateCardRefusals(derived.refusals);
        if (status === 403) throw new ForbiddenError(detail);
        throw new BadRequestError(detail);
      }
      const announcedAt = now();
      if (!clearsNoticeWindow(announcedAt, effectiveAt)) {
        throw new BadRequestError(
          `A rate card must take effect at least ${String(RATE_CARD_NOTICE_HOURS)} hours (30 days) after it is published.`,
        );
      }

      let card;
      try {
        card = await admin.rateCards.publish({
          markupBp: derived.markupBp,
          effectiveAt,
          rows: derived.rows,
          createdByKeyId: ctx.apiKey.id,
        });
      } catch (err) {
        if (err instanceof RateCardRefusedError) {
          throw new BadRequestError(`The rate card was refused: ${err.message}`);
        }
        throw err;
      }
      await adminAudit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action: 'rate_card.published',
        targetResourceId: `rate_card_${String(card.version)}`,
        inputPayload: {
          markup_bp: parsed.data.markup_bp,
          effective_at: parsed.data.effective_at,
          models: derived.rows.map((r) => r.model),
        },
        result: 'success',
        ipAddress: readClientIp(request),
      });
      // Freshly published: its effective_at is at least 30 days out (just
      // checked above), so it is `announced`, never `in_force` — no need to
      // read which card IS in force to answer that correctly.
      return buildAdminRateCardView(card, derived.rows.length, null, now());
    },
  );

  app.get(
    '/v1/admin/credit-rate-cards',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (): Promise<AdminRateCardListResponse> => {
      const admin = requireAdmin(aiCredits);
      const stateReads = requireStateReads(aiCredits);
      const at = now();
      const [cards, counts, inForce] = await Promise.all([
        admin.rateCards.listAll(),
        admin.rateCards.modelCounts(),
        stateReads.cardInForce(at),
      ]);
      return {
        data: cards.map((card) =>
          buildAdminRateCardView(card, counts.get(card.version) ?? 0, inForce?.version ?? null, at),
        ),
      };
    },
  );

  app.post<{ Params: { version: string } }>(
    '/v1/admin/credit-rate-cards/:version/withdraw',
    {
      preHandler: [app.requireOwner, app.rateLimit('global')],
    },
    async (request): Promise<AdminRateCardView> => {
      const ctx = requireCtx(request);
      const version = Number.parseInt(request.params.version, 10);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new BadRequestError('The rate card version must be a positive whole number.');
      }
      const admin = requireAdmin(aiCredits);

      let result;
      try {
        result = await admin.rateCards.withdraw(version);
      } catch (err) {
        if (err instanceof RateCardRefusedError) {
          throw new ConflictError(
            'This rate card has already taken effect and can no longer be withdrawn.',
          );
        }
        throw err;
      }
      if (result.outcome === 'not_found') {
        throw new NotFoundError(`Rate card version ${String(version)} not found.`);
      }
      if (result.outcome === 'already_withdrawn') {
        throw new ConflictError(`Rate card version ${String(version)} was already withdrawn.`);
      }
      await adminAudit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action: 'rate_card.withdrawn',
        targetResourceId: `rate_card_${String(version)}`,
        inputPayload: {},
        result: 'success',
        ipAddress: readClientIp(request),
      });
      const counts = await admin.rateCards.modelCounts();
      return buildAdminRateCardView(result.card, counts.get(version) ?? 0, null, now());
    },
  );

  // ── POST /v1/admin/ai-credits/cutover ───────────────────────────────────
  // §8 step 4. `account_ids` moves the named accounts; `cohort: 'C0'` moves
  // every internal account not already moved. Any other cohort is a
  // well-formed request the SERVICE refuses (`PhaseTwoCohortError` → 400):
  // C1-C4 are Phase 2. `dry_run: true` computes and returns the decision
  // list with nothing locked or written.
  app.post(
    '/v1/admin/ai-credits/cutover',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request): Promise<AiCreditsCutoverResponse> => {
      const ctx = requireCtx(request);
      const parsed = AiCreditsCutoverRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      requireEnforceMode(aiCredits, 'cutover');
      const cutover = requireCutover(aiCredits);

      const selector: CutoverSelector =
        parsed.data.account_ids !== undefined
          ? {
              kind: 'account_ids',
              accountIds: parsed.data.account_ids.map((id) => uuidFromPrefixedId(id, 'acc')),
            }
          : // The schema's `.refine` already requires exactly one of the two;
            // `cohort` is therefore defined whenever `account_ids` is not.
            {
              kind: 'cohort',
              cohort: parsed.data.cohort as NonNullable<typeof parsed.data.cohort>,
            };

      let decisions;
      try {
        decisions = parsed.data.dry_run
          ? await cutover.planCutover(selector)
          : await cutover.runCutover(selector);
      } catch (err) {
        if (err instanceof PhaseTwoCohortError) throw new BadRequestError(err.message);
        throw err;
      }

      // AUDIT (D-025) — one row per account actually moved. Nothing else
      // changed anything: `already_moved`/`not_eligible`/`refuse` wrote
      // nothing, and a dry run wrote nothing at all.
      if (!parsed.data.dry_run) {
        for (const d of decisions) {
          if (d.outcome !== 'move') continue;
          await adminAudit.record({
            adminAccountId: ctx.account.id,
            adminKeyId: ctx.apiKey.id,
            action: 'credits.cutover_moved',
            targetAccountId: d.accountId,
            inputPayload: {
              ai_source: d.aiSource,
              selector:
                parsed.data.account_ids !== undefined
                  ? 'account_ids'
                  : `cohort:${parsed.data.cohort}`,
            },
            result: 'success',
            ipAddress: readClientIp(request),
          });
        }
      }

      const summary = summarizeCutoverDecisions(decisions);
      return {
        dry_run: parsed.data.dry_run,
        decisions: decisions.map(toWireCutoverDecision),
        summary: {
          moved: summary.moved.length,
          already_moved: summary.alreadyMoved.length,
          not_eligible: summary.notEligible.length,
          refused: summary.refused.length,
        },
      };
    },
  );

  // ── POST /v1/admin/ai-credits/rollback ──────────────────────────────────
  // §8 step 7, one account only: "everyone" is an operator action on the
  // environment (setting the mode to shadow), not a route. Restores the
  // legacy consent + cap the cutover snapshotted and clears `ai_source`;
  // touches no ledger row, lot or window, so this month's spend stays
  // exactly as it is.
  app.post(
    '/v1/admin/ai-credits/rollback',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request): Promise<AiCreditsRollbackResponse> => {
      const ctx = requireCtx(request);
      const parsed = AiCreditsRollbackRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      requireEnforceMode(aiCredits, 'rollback');
      const accountId = uuidFromPrefixedId(parsed.data.account_id, 'acc');
      await requireAccountExists(accountId);
      const cutover = requireCutover(aiCredits);

      if (parsed.data.dry_run) {
        const preview = await cutover.previewRollback(accountId);
        return {
          dry_run: true,
          account_id: parsed.data.account_id,
          outcome: preview.outcome,
          restored:
            preview.outcome === 'would_roll_back'
              ? {
                  consent: preview.restored.consent,
                  monthly_cap_usd_cents: preview.restored.capCents,
                }
              : null,
        };
      }

      const result = await cutover.rollbackAccount(accountId);
      if (result.outcome === 'rolled_back') {
        await adminAudit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'credits.cutover_rolled_back',
          targetAccountId: accountId,
          inputPayload: {
            restored_consent: result.restored.consent,
            restored_monthly_cap_usd_cents: result.restored.capCents,
          },
          result: 'success',
          ipAddress: readClientIp(request),
        });
      }
      return {
        dry_run: false,
        account_id: parsed.data.account_id,
        outcome: result.outcome,
        restored:
          result.outcome === 'rolled_back'
            ? { consent: result.restored.consent, monthly_cap_usd_cents: result.restored.capCents }
            : null,
      };
    },
  );
}
