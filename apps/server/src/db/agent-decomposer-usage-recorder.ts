// v2-#4 Q.1.e — Drizzle-backed AgentDecomposerUsageRecorder.
//
// Records one usage_records row per ClaudeAgentDecomposer or
// DeterministicAgentDecomposer .decompose() call. The
// `record_type = 'agent_decomposer'` value was added in migration
// 0046; the metadata column holds the per-call telemetry shape
// documented in that migration's header.
//
// quantity = 1 (one decompose call). Aggregations over multiple
// turns sum quantity for "calls made" or sum metadata.cost_usd_cents
// for "dollars spent" — both queryable from the same row set.
//
// Best-effort recording: AgentRuntime swallows exceptions thrown
// here so a meter-side outage doesn't break the customer's chat
// turn. We still log the original error before re-throwing so
// the Sentry trail captures the failure.

import type { Database } from './client.js';
import { usageRecords } from './schema.js';
import type { AgentDecomposerUsageRecorder } from '../services/agent-runtime.js';
import type { AccountAuditService } from '../services/account-audit.js';
import type { Logger } from 'pino';

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
    const isBundled = args.keySource === 'bundled';
    const recordType = isBundled ? 'agent_decomposer_bundled' : 'agent_decomposer';
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
    if (isBundled) {
      // Q5=A — surface the POSTED flat cost; the upstream Anthropic-
      // derived cost in args.usage.costUsdCents is intentionally NOT
      // written to metadata so a leaked DB snapshot can't reveal it.
      // Flat charge is per TURN, not per ROW. A read-intent turn posts two
      // rows (decompose + #140 read-back); only the first carries the turn's
      // $0.10 so the monthly cap totals what the customer was sold and what the
      // turn's own response reports. cost_basis stays the documented value on
      // both rows — the turn still posts a flat $0.10 on that basis.
      metadata.cost_usd_cents =
        args.bundledFlatCostAlreadyPosted === true ? 0 : POSTED_BUNDLED_COST_CENTS;
      metadata.cost_basis = 'bundled_flat_per_turn';
    } else if (args.usage.costUsdCents !== undefined) {
      metadata.cost_usd_cents = args.usage.costUsdCents;
    }
    if (args.keySource !== undefined) metadata.key_source = args.keySource;
    // agent-session id stashed in metadata so cost-by-agent-session
    // reports can group without an extra column; the usage_records
    // schema only carries the driftstack-session reference natively.
    metadata.agent_session_id = args.agentSessionId;

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
        metadata,
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
