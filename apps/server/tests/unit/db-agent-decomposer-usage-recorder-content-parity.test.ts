// Drift guard for apps/server/src/db/agent-decomposer-usage-recorder.ts.
// Pins v2-#4 Q.1.e Drizzle-backed AgentDecomposerUsageRecorder. Records
// one usage_records row per .decompose() call. Q5=A bundled flat-cost
// ($0.10/turn) hides upstream Anthropic cost. v2-#5 Q.1.f operator-
// only audit emission is best-effort + non-throwing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/agent-decomposer-usage-recorder.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/agent-decomposer-usage-recorder content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("v2-#4 Q.1.e module-level framing pinned: 'Drizzle-backed AgentDecomposerUsageRecorder. Records one usage_records row per ClaudeAgentDecomposer or DeterministicAgentDecomposer .decompose() call. The record_type = \"agent_decomposer\" value was added in migration 0046; the metadata column holds the per-call telemetry shape documented in that migration's header.' — pinned so the v2-#4 anchor + Q.1.e + migration 0046 + record_type=agent_decomposer + metadata-shape contract all stay documented", () => {
    expect(body).toMatch(/\/\/ v2-#4 Q\.1\.e — Drizzle-backed AgentDecomposerUsageRecorder\./);
    expect(body).toMatch(
      /\/\/ Records one usage_records row per ClaudeAgentDecomposer or\s*\n?\s*\/\/ DeterministicAgentDecomposer \.decompose\(\) call\. The\s*\n?\s*\/\/ `record_type = 'agent_decomposer'` value was added in migration\s*\n?\s*\/\/ 0046/,
    );
  });

  it("Best-effort framing pinned: 'AgentRuntime swallows exceptions thrown here so a meter-side outage doesn't break the customer's chat turn. We still log the original error before re-throwing so the Sentry trail captures the failure.' — pinned so the swallow-at-AgentRuntime + log-then-rethrow-here + Sentry-trail-coverage contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Best-effort recording: AgentRuntime swallows exceptions thrown\s*\n?\s*\/\/ here so a meter-side outage doesn't break the customer's chat\s*\n?\s*\/\/ turn\. We still log the original error before re-throwing so\s*\n?\s*\/\/ the Sentry trail captures the failure\./,
    );
  });

  it("v2-#5 Q.1.f operator-only audit framing pinned: 'When non-null, every decompose() call also drops an agent.decompose.claude or agent.decompose.deterministic row on the customer's audit log (visible via GET /v1/account/audit-log with the right filter). Best-effort: audit-emit failures don't break the usage insert and don't break the customer's chat turn.' — pinned so the audit-fire-on-decompose + visible-via-account-audit-log + audit-failure-non-fatal contract all stay documented", () => {
    expect(body).toMatch(
      /\* v2-#5 Q\.1\.f — operator-only audit emission\. When non-null, every\s*\n?\s*\* decompose\(\) call also drops an `agent\.decompose\.claude` or\s*\n?\s*\* `agent\.decompose\.deterministic` row on the customer's audit log\s*\n?\s*\* \(visible via GET \/v1\/account\/audit-log with the right filter\)\./,
    );
  });

  it("Arc 1 sub-slice 6.4 bundled-cost framing pinned: 'bundled-LLM turns post a flat $0.10/turn (Q5=A hide actual upstream Anthropic cost) under a distinct record_type so the soft-cap sweep (sub-slice 6.5) can sum only bundled rows.' + POSTED_BUNDLED_COST_CENTS = 10 + recordType: isBundled ? 'agent_decomposer_bundled' : 'agent_decomposer' — pinned so the 6.4 anchor + Q5=A hide-upstream-cost + 10-cent-flat-fee + 6.5-soft-cap-sweep cross-reference contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 1 sub-slice 6\.4 \(v2-#6\) — bundled-LLM turns post a flat\s*\n?\s*\/\/ \$0\.10\/turn \(Q5=A hide actual upstream Anthropic cost\) under a\s*\n?\s*\/\/ distinct record_type so the soft-cap sweep \(sub-slice 6\.5\) can\s*\n?\s*\/\/ sum only bundled rows\./,
    );
    expect(body).toMatch(/const POSTED_BUNDLED_COST_CENTS = 10;/);
    // The flat charge is per TURN, not per row. A read-intent turn posts two
    // rows (decompose + #140 read-back), so writing the constant unconditionally
    // debited a bundled customer twice for one turn. The behavioural proof lives
    // in db-agent-decomposer-usage-recorder-bundled-flat-cost.test.ts — this
    // source pin only stops the unconditional form coming back, and it is
    // exactly the kind of guard that could NOT catch the original bug.
    expect(body).toMatch(
      /metadata\.cost_usd_cents =\s*\n?\s*args\.bundledFlatCostAlreadyPosted === true \? 0 : POSTED_BUNDLED_COST_CENTS;/,
    );
    expect(body).not.toMatch(/metadata\.cost_usd_cents = POSTED_BUNDLED_COST_CENTS;/);
    expect(body).toMatch(/metadata\.cost_basis = 'bundled_flat_per_turn';/);
    expect(body).toMatch(
      /const recordType = isBundled \? 'agent_decomposer_bundled' : 'agent_decomposer';/,
    );
  });

  it("Q5=A upstream-cost-NOT-written-to-metadata framing pinned: 'surface the POSTED flat cost; the upstream Anthropic-derived cost in args.usage.costUsdCents is intentionally NOT written to metadata so a leaked DB snapshot can't reveal it.' + metadata.cost_usd_cents = POSTED_BUNDLED_COST_CENTS + metadata.cost_basis = 'bundled_flat_per_turn' — pinned so the Q5=A no-upstream-cost-in-metadata + cost_basis='bundled_flat_per_turn' contract stays documented (drift to writing args.usage.costUsdCents on bundled rows would leak the upstream Anthropic margin in a DB snapshot)", () => {
    expect(body).toMatch(
      /\/\/ Q5=A — surface the POSTED flat cost; the upstream Anthropic-\s*\n?\s*\/\/ derived cost in args\.usage\.costUsdCents is intentionally NOT\s*\n?\s*\/\/ written to metadata so a leaked DB snapshot can't reveal it\./,
    );
  });

  it("Metadata accumulation framing pinned: conditional metadata fields (model + anthropic_input_tokens + anthropic_output_tokens + key_source) + agent_session_id always set + 'agent-session id stashed in metadata so cost-by-agent-session reports can group without an extra column; the usage_records schema only carries the driftstack-session reference natively.' — pinned so the conditional-fields + agent_session_id-in-metadata-for-grouping contract all stay documented", () => {
    expect(body).toMatch(
      /if \(args\.usage\.model !== undefined\) metadata\.model = args\.usage\.model;/,
    );
    expect(body).toMatch(
      /if \(args\.usage\.anthropicInputTokens !== undefined\) \{\s*\n?\s*metadata\.anthropic_input_tokens = args\.usage\.anthropicInputTokens;/,
    );
    expect(body).toMatch(
      /\/\/ agent-session id stashed in metadata so cost-by-agent-session\s*\n?\s*\/\/ reports can group without an extra column; the usage_records\s*\n?\s*\/\/ schema only carries the driftstack-session reference natively\.\s*\n?\s*metadata\.agent_session_id = args\.agentSessionId;/,
    );
  });

  it("Audit-emit-failure non-fatal framing pinned: 'Failures here do NOT re-throw — usage already recorded successfully, audit drop is additional safety net.' + try/catch around accountAudit.record + logger.warn '...audit emit failed (non-fatal)'. Drift to re-throwing on audit-fail would break the customer's chat turn after the meter has already booked the cost", () => {
    expect(body).toMatch(
      /\/\/ v2-#5 Q\.1\.f — best-effort audit emission\. Failures here do NOT\s*\n?\s*\/\/ re-throw — usage already recorded successfully, audit drop is\s*\n?\s*\/\/ additional safety net\./,
    );
    expect(body).toMatch(/'DrizzleAgentDecomposerUsageRecorder audit emit failed \(non-fatal\)'/);
  });
});
