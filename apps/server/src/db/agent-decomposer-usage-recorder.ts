// v2-#4 Q.1.e — Drizzle-backed AgentDecomposerUsageRecorder.
//
// Records one usage_records row per ClaudeAgentDecomposer or
// DeterministicAgentDecomposer .decompose() call. The
// `record_type = 'agent_decomposer'` value was added in migration
// 0046; the metadata column holds the per-call telemetry shape
// documented in that migration's header.
//
// quantity = 1 (one decompose call). Aggregations over multiple
// turns sum quantity for "calls made", metadata.cost_usd_cents for
// what was POSTED (the bundled soft cap), or
// metadata.list_price_cost_millicents for what the calls COST — never
// one added to another (see POSTED_COST_FIELD below).
//
// Best-effort recording: AgentRuntime swallows exceptions thrown
// here so a meter-side outage doesn't break the customer's chat
// turn. We still log the original error before re-throwing so
// the Sentry trail captures the failure.

import { listPriceCostMillicents, type ModelCallTokens } from '@driftstack/api-types';
import type { Database } from './client.js';
import { usageRecords } from './schema.js';
import type { AgentDecomposerUsageRecorder } from '../services/agent-runtime.js';
import type { DecomposeUsage } from '../services/agent-decomposer.js';
import type { AccountAuditService } from '../services/account-audit.js';
import type { Logger } from 'pino';

/**
 * THE TWO COST FIELDS ON A USAGE ROW, and why they must never be confused.
 *
 *  · `cost_usd_cents` — what was POSTED, in whole cents. On a bundled row it is
 *    the flat per-turn price (10 on a turn's first row, 0 on the rest), and it is
 *    the ONLY field the bundled monthly soft cap sums (db/bundled-llm-repo.ts).
 *    On an own-key row it is the provider cost rounded UP to a whole cent per
 *    call. It is not the true cost of anything.
 *  · `list_price_cost_millicents` — what the call COST at the provider's list
 *    price, in thousandths of a cent, every token at its own rate and nothing
 *    rounded up (see `listPriceCostMillicents`). Written on bundled AND own-key
 *    rows. Nothing sums it yet: it is the groundwork the credit ledger is built
 *    on, recorded now so that ledger starts from true numbers.
 *
 * Different units in the NAMES, so a query that adds one to the other reads as
 * wrong on sight. Summing the list price into the soft cap would change what a
 * customer's cap means overnight; summing the flat price into the ledger would
 * bill a 40-call turn like a 1-call turn.
 */
export const POSTED_COST_FIELD = 'cost_usd_cents' as const;
export const LIST_PRICE_COST_FIELD = 'list_price_cost_millicents' as const;

/**
 * S11 — the AI-credits task this call was measured against, and the ONLY thing
 * that says a `credit_model_calls` charge and a usage row's list price belong to
 * the same turn.
 *
 * Named here, beside the other two, because the shadow report reads it out of
 * `metadata` as a jsonb key and a reader that spells it differently joins
 * nothing at all — every measured turn would read as having cost zero, and the
 * ratio §8 gates the cutover on would be a rate over an empty denominator.
 * `every-usage-row-a-metered-turn-writes-names-its-credits-task` holds the two
 * spellings against each other.
 */
export const CREDIT_RESERVATION_ID_FIELD = 'credit_reservation_id' as const;

/**
 * One call's token counts, split the way the provider bills them.
 *
 * A cache write the provider did not break down by lifetime is priced at the
 * 1-hour rate — the dearer one, and the one the planner's largest prefix uses —
 * so an unattributed write can overstate a call's cost but never understate it.
 * The Claude adapter splits its own per-call estimate the same way.
 */
export function modelCallTokens(usage: DecomposeUsage): ModelCallTokens {
  const reported5m = usage.anthropicCacheCreation5mInputTokens ?? 0;
  const reported1h = usage.anthropicCacheCreation1hInputTokens ?? 0;
  const writeTotal = Math.max(
    usage.anthropicCacheCreationInputTokens ?? 0,
    reported5m + reported1h,
  );
  return {
    uncachedInput: usage.anthropicInputTokens ?? 0,
    output: usage.anthropicOutputTokens ?? 0,
    cacheRead: usage.anthropicCacheReadInputTokens ?? 0,
    cacheWrite5m: reported5m,
    cacheWrite1h: writeTotal - reported5m,
  };
}

/**
 * The list-price cost of the call this usage block describes: 0 when no model
 * was called (the deterministic decomposer), null when a model was called that
 * the registry cannot price — "unknown" must never be written as "free".
 *
 * Also null when the provider never reported the call's input or output count:
 * a call the customer's Stop cut off before usage came back (the runtime's
 * `abortedCallEvidence`) was still billed by the provider, so filling the gaps
 * with 0 would store a paid call as free. The cache counts may be absent on a
 * complete report (no caching that call), so only these two decide.
 */
export function listPriceOfCall(usage: DecomposeUsage): number | null {
  if (usage.decomposerKind === 'deterministic') return 0;
  if (usage.model === undefined) return null;
  if (usage.anthropicInputTokens === undefined || usage.anthropicOutputTokens === undefined) {
    return null;
  }
  return listPriceCostMillicents(usage.model, modelCallTokens(usage));
}

export class DrizzleAgentDecomposerUsageRecorder implements AgentDecomposerUsageRecorder {
  constructor(
    private readonly database: Database,
    private readonly logger: Logger,
    /**
     * v2-#5 Q.1.f — operator-only audit emission. When non-null, every
     * decompose() call also drops an `agent.decompose.claude` or
     * `agent.decompose.deterministic` row on the customer's audit log
     * (visible via GET /v1/account/audit-log with the right filter).
     * Best-effort: audit-emit failures don't break the usage insert
     * and don't break the customer's chat turn.
     */
    private readonly accountAudit: AccountAuditService | null = null,
  ) {}

  async record(args: Parameters<AgentDecomposerUsageRecorder['record']>[0]): Promise<void> {
    // Arc 1 sub-slice 6.4 (v2-#6) — bundled-LLM turns post a flat
    // $0.10/turn (Q5=A hide actual upstream Anthropic cost) under a
    // distinct record_type so the soft-cap sweep (sub-slice 6.5) can
    // sum only bundled rows.
    //
    // S12 — a MOVED account's turn on `keySource:'credits'` runs on the SAME
    // deployment key as a bundled turn and posts the SAME flat placeholder
    // here: this row is the soft-cap/audit-continuity record, not the
    // customer-facing charge (that is `publicUsage`'s `ceil(charged)`, built
    // from the reservation's own settle, §5.2). Kept under the bundled
    // record_type too, so a query written against `agent_decomposer_bundled`
    // before S12 landed keeps meaning what it always meant.
    const isBundledLike = args.keySource === 'bundled' || args.keySource === 'credits';
    const recordType = isBundledLike ? 'agent_decomposer_bundled' : 'agent_decomposer';
    const POSTED_BUNDLED_COST_CENTS = 10;

    const metadata: Record<string, unknown> = {
      decomposer_kind: args.usage.decomposerKind,
      decompose_result_kind: args.decomposeResultKind,
      tokens_consumed: args.tokensConsumed,
    };
    if (args.usage.model !== undefined) metadata.model = args.usage.model;
    if (args.usage.anthropicInputTokens !== undefined) {
      metadata.anthropic_input_tokens = args.usage.anthropicInputTokens;
    }
    if (args.usage.anthropicOutputTokens !== undefined) {
      metadata.anthropic_output_tokens = args.usage.anthropicOutputTokens;
    }
    // Prompt-cache accounting. ⛔ With caching on, `anthropic_input_tokens` is
    // only the UNCACHED remainder of the prompt, so a row that stored it alone
    // would make a 9k-token cached call look like a 40-token one — and could
    // never be re-priced, because the three parts bill at three different rates.
    // Stored under the provider's own field names so a row reads against the
    // provider's console without a translation table.
    //
    // Written on bundled rows too. They hide the upstream COST (Q5=A), not the
    // token counts — `anthropic_input_tokens` is already on them — and the cache
    // counts are what say whether the flat per-turn price still covers a turn.
    if (args.usage.anthropicCacheCreationInputTokens !== undefined) {
      metadata.anthropic_cache_creation_input_tokens = args.usage.anthropicCacheCreationInputTokens;
    }
    if (args.usage.anthropicCacheReadInputTokens !== undefined) {
      metadata.anthropic_cache_read_input_tokens = args.usage.anthropicCacheReadInputTokens;
    }
    if (args.usage.anthropicCacheCreation5mInputTokens !== undefined) {
      metadata.anthropic_cache_creation_5m_input_tokens =
        args.usage.anthropicCacheCreation5mInputTokens;
    }
    if (args.usage.anthropicCacheCreation1hInputTokens !== undefined) {
      metadata.anthropic_cache_creation_1h_input_tokens =
        args.usage.anthropicCacheCreation1hInputTokens;
    }
    if (args.usage.anthropicPromptTokens !== undefined) {
      metadata.anthropic_prompt_tokens = args.usage.anthropicPromptTokens;
    }
    if (args.usage.anthropicThinkingTokens !== undefined) {
      metadata.anthropic_thinking_tokens = args.usage.anthropicThinkingTokens;
    }
    if (args.usage.anthropicStopReason !== undefined) {
      metadata.anthropic_stop_reason = args.usage.anthropicStopReason;
    }
    if (isBundledLike) {
      // Q5=A — surface the POSTED flat cost; the upstream Anthropic-
      // derived cost in args.usage.costUsdCents is intentionally NOT
      // written to metadata so a leaked DB snapshot can't reveal it.
      // (The list-price cost IS written, as its own field, below: it is the
      // provider's PUBLIC price times the token counts this row already
      // carries, so it discloses nothing a snapshot did not already hold, and
      // the credit ledger cannot be built on a flat number. It is kept out of
      // the customer's audit payload, which is what a customer can read.)
      // Flat charge is per TURN, not per ROW. A read-intent turn posts two
      // rows (decompose + #140 read-back); only the first carries the turn's
      // $0.10 so the monthly cap totals what the customer was sold and what the
      // turn's own response reports. cost_basis stays the documented value on
      // both rows — the turn still posts a flat $0.10 on that basis.
      metadata.cost_usd_cents =
        args.bundledFlatCostAlreadyPosted === true ? 0 : POSTED_BUNDLED_COST_CENTS;
      // S12 — 'credits' gets its OWN basis word. Nothing sums this field by
      // basis today, but a row that says 'bundled_flat_per_turn' for a turn
      // that was in fact charged against a reservation would be a false
      // record the moment anything does.
      metadata.cost_basis = args.keySource === 'credits' ? 'credits' : 'bundled_flat_per_turn';
    } else if (args.usage.costUsdCents !== undefined) {
      metadata.cost_usd_cents = args.usage.costUsdCents;
    }
    if (args.keySource !== undefined) metadata.key_source = args.keySource;
    // agent-session id stashed in metadata so cost-by-agent-session
    // reports can group without an extra column; the usage_records
    // schema only carries the driftstack-session reference natively.
    metadata.agent_session_id = args.agentSessionId;

    // The row carries the list-price cost; the audit payload below does not.
    // That payload lands on the customer's own audit log, and Phase 0 changes
    // nothing a customer can see — on a bundled row it would also show them the
    // cost behind the flat price they were sold.
    const rowMetadata: Record<string, unknown> = {
      ...metadata,
      [LIST_PRICE_COST_FIELD]: listPriceOfCall(args.usage),
      // S11 — the AI-credits task this call was measured (or, after S12,
      // charged) against.
      //
      // ⛔ ON THE ROW, NOT IN THE AUDIT PAYLOAD, and the two are already
      // different objects for exactly this kind of reason. `metadata` is what
      // lands on the CUSTOMER's audit log; until AI credits launch nothing a
      // customer can read may mention them, and a reservation id on their own
      // audit row would be the first thing that did.
      //
      // ⛔ IT IS THE JOIN THE SHADOW REPORT IS BUILT ON. `credit_model_calls`
      // records what a call was charged and cannot know the provider's list
      // price; this row records the list price and cannot know the charge. The
      // "shadow charge is exactly twice list price" check is a ratio between
      // them, and without this id it would be a ratio between two populations
      // that merely overlap — an own-key turn contributes rows here and no
      // calls there, and the ratio would drift toward whatever the window held.
      //
      // Written only when the turn had a meter, so a row from a turn that ran
      // before credits existed and a row from a turn that ran without them are
      // the same shape.
      ...(args.creditReservationId !== undefined
        ? { [CREDIT_RESERVATION_ID_FIELD]: args.creditReservationId }
        : {}),
    };

    try {
      // Idempotent on the caller-supplied row id. `recordUsageRowWithRetry`
      // re-invokes this on any throw, and a write can throw AFTER the server
      // committed (connection reset post-commit, client-side timeout on a
      // statement that landed). Without this, that retry posts a SECOND flat
      // $0.10 row for one turn and the monthly cap is consumed at 2x — the same
      // customer harm as the per-row/per-turn bug fixed in f97cf1349. With a
      // stable id the retry conflicts on the primary key and does nothing.
      //
      // When no id is supplied the database default applies and there is no
      // conflict target to dedupe on, so the write keeps its previous
      // behaviour rather than silently pretending to be retry-safe.
      const insert = this.database.db.insert(usageRecords).values({
        ...(args.recordId !== undefined ? { id: args.recordId } : {}),
        accountId: args.accountId,
        ...(args.driftstackSessionId !== null ? { sessionId: args.driftstackSessionId } : {}),
        recordType,
        quantity: 1,
        metadata: rowMetadata,
        recordedAt: args.now,
      });
      await (args.recordId !== undefined ? insert.onConflictDoNothing() : insert);
    } catch (err) {
      this.logger.error(
        {
          err,
          accountId: args.accountId,
          agentSessionId: args.agentSessionId,
          decomposerKind: args.usage.decomposerKind,
        },
        'DrizzleAgentDecomposerUsageRecorder.record failed',
      );
      throw err;
    }

    // v2-#5 Q.1.f — best-effort audit emission. Failures here do NOT
    // re-throw — usage already recorded successfully, audit drop is
    // additional safety net.
    if (this.accountAudit !== null) {
      try {
        await this.accountAudit.record({
          accountId: args.accountId,
          actorType: 'system',
          action:
            args.usage.decomposerKind === 'claude'
              ? 'agent.decompose.claude'
              : 'agent.decompose.deterministic',
          targetResourceId: `agent_session_${args.agentSessionId}`,
          payload: metadata,
        });
      } catch (err) {
        this.logger.warn(
          { err, accountId: args.accountId, agentSessionId: args.agentSessionId },
          'DrizzleAgentDecomposerUsageRecorder audit emit failed (non-fatal)',
        );
      }
    }
  }
}
