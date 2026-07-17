// Drift guard for apps/server/src/services/agent-runtime.ts. Pins the
// AI-COMPOSE end-to-end turn pipeline — RunTurnArgs/RunTurnResult
// shape, manual-mode pass-through, Q.1.b hybrid error classification,
// session-closed short-circuit, usage recorder + event bus + metrics
// optional-dependency contracts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-runtime.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-runtime content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-COMPOSE module-level framing pinned: 'AgentRuntime composes the three AI-CHAT primitives (AgentDecomposer + AgentSessionsRepo + AgentExecutor) into the single end-to-end loop the dashboard chat UI hits per turn: user-message → load AgentSession → decomposer.decompose() → (refuse | clarify | plan→executor.execute) → debit tokens → append transcripts → return turn result.' — pinned so the AI-COMPOSE anchor + 3-primitive composition + 6-step end-to-end pipeline all stay documented", () => {
    expect(body).toMatch(
      /\/\/ AI-COMPOSE — AgentRuntime composes the three AI-CHAT primitives\s*\n?\s*\/\/ \(AgentDecomposer \+ AgentSessionsRepo \+ AgentExecutor\) into the\s*\n?\s*\/\/ single end-to-end loop the dashboard chat UI hits per turn:/,
    );
    expect(body).toMatch(
      /\/\/ {3}user-message → load AgentSession → decomposer\.decompose\(\) →\s*\n?\s*\/\/ {5}\(refuse \| clarify \| plan→executor\.execute\) → debit tokens →\s*\n?\s*\/\/ {5}append transcripts → return turn result/,
    );
  });

  it("3-primitive interface-stability framing pinned: 'the contract is testable end-to-end without any of them needing a real backend. Each can be swapped (Deterministic→Claude; Stub→Wired; InMemory→Drizzle) without changing the runtime.' — pinned so the 3-backend-swap-without-change-to-runtime contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ This is the FIRST place where the three primitive interfaces meet,\s*\n?\s*\/\/ so the contract is testable end-to-end without any of them needing\s*\n?\s*\/\/ a real backend\. Each can be swapped \(Deterministic→Claude;\s*\n?\s*\/\/ Stub→Wired; InMemory→Drizzle\) without changing the runtime\./,
    );
  });

  it("BYOK byokApiKey RunTurnArgs framing pinned: 'BYOK Anthropic API key threaded through from the route layer (resolved from per-customer storage or the deployment fallback; see DecomposeArgs.byokAnthropicApiKey JSDoc for the priority order). NEVER logged, NEVER persisted into the transcript. DeterministicAgentDecomposer ignores it; AI-B1.b Claude wire forwards as the x-api-key header on the Anthropic API call.' — pinned so the route-resolves-the-key + NEVER-logged + NEVER-persisted-to-transcript + Deterministic-ignores + Claude-forwards-as-x-api-key contract stay documented", () => {
    expect(body).toMatch(
      /\* BYOK Anthropic API key threaded through from the route layer\s*\n?\s*\*\s+\(resolved from per-customer storage or the deployment fallback;\s*\n?\s*\*\s+see `DecomposeArgs\.byokAnthropicApiKey` JSDoc for the priority\s*\n?\s*\*\s+order\)\. NEVER logged, NEVER persisted into the transcript\./,
    );
    expect(body).toMatch(
      /\*\s+DeterministicAgentDecomposer ignores it; AI-B1\.b Claude wire\s*\n?\s*\*\s+forwards as the `x-api-key` header on the Anthropic API call\./,
    );
  });

  it("Arc 1 sub-slice 6.4 keySource discriminator framing pinned: 'which leg of the route's resolution chain produced byokApiKey. The usage recorder writes a distinct record_type for bundled so the soft-cap sweep (sub-slice 6.5) can sum bundled-only spend without double-counting BYOK turns. Defaults to none so existing callers (which don't pass keySource) keep recording under the generic agent_decomposer record_type.' — pinned so the 5-source-enum (header/cached/bundled/fallback/none) + bundled-distinct-record-type + sub-slice-6.5-soft-cap-sweep cross-reference all stay documented", () => {
    expect(body).toMatch(
      /\* Arc 1 sub-slice 6\.4 \(v2-#6\) — which leg of the route's\s*\n?\s*\*\s+resolution chain produced `byokApiKey`\. The usage recorder\s*\n?\s*\*\s+writes a distinct record_type for 'bundled' so the soft-cap\s*\n?\s*\*\s+sweep \(sub-slice 6\.5\) can sum bundled-only spend without\s*\n?\s*\*\s+double-counting BYOK turns\./,
    );
    expect(body).toMatch(/keySource\?: 'header' \| 'cached' \| 'bundled' \| 'fallback' \| 'none';/);
  });

  it('RunTurnResult internal/public discriminants include plan/clarify/refuse, session/account concurrency, closed, and manual paths', () => {
    expect(body).toMatch(/export type RunTurnResult =/);
    expect(body).toMatch(/kind: 'plan-executed';/);
    expect(body).toMatch(/kind: 'clarify';/);
    expect(body).toMatch(/kind: 'refuse';/);
    expect(body).toMatch(/kind: 'session-closed';/);
    expect(body).toMatch(/kind: 'turn-in-progress';/);
    expect(body).toMatch(/kind: 'account-turn-limit';/);
    expect(body).toMatch(/kind: 'logged-manual';/);
    expect(body).toMatch(
      /\/\/ Arc 2 sub-slice 8\.6 \(v2-#8\) — manual mode pass-through\.\s*\n?\s*\/\/ The user_message was recorded as an actor='operator' transcript\s*\n?\s*\/\/ entry; no decompose \/ executor ran\./,
    );
  });

  it('per-account AI turn fairness is positive, defaults to three, and manual mode bypasses only the account slot', () => {
    expect(body).toMatch(/maxConcurrentTurnsPerAccount\?: number;/);
    expect(body).toMatch(/const limit = deps\.maxConcurrentTurnsPerAccount \?\? 3;/);
    expect(body).toMatch(/const consumesAccountSlot = admission\.kind === 'ai-control';/);
    expect(body).toMatch(/currentForAccount >= this\.maxConcurrentTurnsPerAccount/);
    expect(body).toMatch(/this\.activeTurnAccountCounts\.delete\(session\.accountId\)/);
    expect(body).toMatch(/return await this\.runExclusiveTurn\(args, session, admission\);/);
  });

  it("v2-#4 Q.1.e AgentDecomposerUsageRecorder framing pinned: 'per-turn usage recorder. AgentRuntime calls this after every decomposer.decompose() that returns a usage block. Bootstrap wires this to a usage_records writer when the Drizzle dependency direction is permitted. When unwired, AgentRuntime silently skips recording — the dashboard usage page only reflects what we successfully persisted, so a missing wire shows as missing cost data rather than a synthesized zero.' — pinned so the optional-recorder + silent-skip-when-unwired + no-synthesized-zero contract all stay documented", () => {
    expect(body).toMatch(
      /\* v2-#4 Q\.1\.e — per-turn usage recorder\. AgentRuntime calls this\s*\n?\s*\*\s+after every decomposer\.decompose\(\) that returns a `usage` block\.\s*\n?\s*\*\s+Bootstrap wires this to a usage_records writer when the Drizzle\s*\n?\s*\*\s+dependency direction is permitted\. When unwired, AgentRuntime\s*\n?\s*\*\s+silently skips recording — the dashboard usage page only reflects\s*\n?\s*\*\s+what we successfully persisted, so a missing wire shows as missing\s*\n?\s*\*\s+cost data rather than a synthesized zero\./,
    );
  });

  it("AgentDecomposerUsageRecorder.record 7-arg shape pinned: accountId + driftstackSessionId (nullable) + agentSessionId + decomposeResultKind ('plan' | 'clarify' | 'refuse') + usage + tokensConsumed + now + keySource?. + Arc 1 6.4 record_type framing: 'drives the record_type column on the usage_records insert: bundled → agent_decomposer_bundled, else → agent_decomposer. Bundled rows post a flat $0.10/turn cost (Q5=A hide actual upstream); non-bundled rows keep the v2-#4 metadata.cost_usd_cents Anthropic-derived value.' — pinned so the per-keySource record_type split + bundled-$0.10/turn-Q5=A + Anthropic-derived-cost for non-bundled contract all stay documented", () => {
    expect(body).toMatch(/export interface AgentDecomposerUsageRecorder \{/);
    expect(body).toMatch(/decomposeResultKind: 'plan' \| 'clarify' \| 'refuse';/);
    expect(body).toMatch(/usage: DecomposeUsage;/);
    expect(body).toMatch(
      /\* Arc 1 sub-slice 6\.4 \(v2-#6\) — drives the record_type column\s*\n?\s*\*\s+on the usage_records insert: 'bundled' → 'agent_decomposer_bundled',\s*\n?\s*\*\s+else → 'agent_decomposer'\. Bundled rows post a flat \$0\.10\/turn\s*\n?\s*\*\s+cost \(Q5=A hide actual upstream\); non-bundled rows keep the\s*\n?\s*\*\s+v2-#4 metadata\.cost_usd_cents Anthropic-derived value\./,
    );
  });

  it("AgentRuntimeDeps 6-field shape pinned: decomposer + executor + sessions + archetype + usageRecorder? (optional) + eventBus? (optional) + metrics? (optional). + Arc 2 8.3 event bus framing 'Omitting the bus is a silent no-op (the runtime still writes to the repo).' + Arc 7 obs.3 metrics framing 'Best-effort: a registry inc never throws under normal operation (counters validated at registration) but the call site wraps in try/swallow so a stray bug can't break the turn.' — pinned so the 3-optional-collaborator + silent-no-op + try-swallow-stray-bug contract all stay documented", () => {
    expect(body).toMatch(/export interface AgentRuntimeDeps \{/);
    expect(body).toMatch(/decomposer: AgentDecomposer;/);
    expect(body).toMatch(/executor: AgentExecutor;/);
    expect(body).toMatch(/sessions: AgentSessionsRepo;/);
    expect(body).toMatch(/archetype: string;/);
    expect(body).toMatch(/usageRecorder\?: AgentDecomposerUsageRecorder;/);
    expect(body).toMatch(/eventBus\?: AgentSessionEventBus;/);
    // W589 — task-refusal start-gate: optional pattern list (founder/AUP data)
    // + optional audit logger. Both optional ⇒ inert until activated.
    expect(body).toMatch(/refusalPatterns\?: readonly RefusalPattern\[\];/);
    // Billing-integrity hardening — logger now also exposes `error?` for the
    // bundled-LLM spend-meter loud-log (the cost row is the only soft-cap input).
    expect(body).toMatch(/logger\?: \{\s*\n?\s*warn\?: /);
    expect(body).toMatch(/error\?: \(obj: Record<string, unknown>, msg: string\) => void;/);
    expect(body).toMatch(
      /\*\s+Arc 2 sub-slice 8\.3 \(v2-#8\) — optional transcript event bus\.\s*\n?\s*\*\s+When wired, AgentRuntime publishes every transcript-append to\s*\n?\s*\*\s+the bus so the SSE endpoint can stream live turns to dashboard\s*\n?\s*\*\s+subscribers\. Omitting the bus is a silent no-op \(the runtime\s*\n?\s*\*\s+still writes to the repo\)\./,
    );
    expect(body).toMatch(
      /\*\s+Arc 7 obs\.3 — optional metrics registry\. When wired, the\s*\n?\s*\*\s+runtime increments `driftstack_agent_decompose_total\{kind\}` on\s*\n?\s*\*\s+every decompose\(\) call \(kind = plan \/ clarify \/ refuse\) so the\s*\n?\s*\*\s+Grafana dashboard can ratio useful turns against no-op kinds\./,
    );
  });

  it('Session-closed short-circuit preserves the paused-versus-closed lifecycle distinction', () => {
    expect(body).toMatch(
      /if \(session\.status !== 'active'\) \{\s*\n?\s*\/\/ Closed\/paused sessions return a short-circuit result\. The\s*\n?\s*\/\/ caller \(route handler\) maps this to a 409 Conflict — the\s*\n?\s*\/\/ chat UI distinguishes resuming a pause from replacing a closed row\./,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*kind: 'session-closed',\s*\n?\s*reason: session\.closedReason \?\? `session \$\{session\.status\}`,\s*\n?\s*session,\s*\n?\s*\};/,
    );
  });

  it("Arc 2 8.6 manual-mode framing pinned: 'manual mode pass-through. Record the customer's user_message as actor=operator on the transcript (no decompose / executor / token debit; the gui-client drives intents directly via the gui_control plane). Returns a distinct result kind so the route maps to a 200 logged response.' — pinned so the operator-not-user role + no-decompose/executor/token-debit + V-174 gui_control plane + 200-logged-response contract stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 2 sub-slice 8\.6 \(v2-#8\) — manual mode pass-through\. Record\s*\n?\s*\/\/ the customer's user_message as actor='operator' on the transcript\s*\n?\s*\/\/ \(no decompose \/ executor \/ token debit; the gui-client drives\s*\n?\s*\/\/ intents directly via the gui_control plane\)\. Returns a distinct\s*\n?\s*\/\/ result kind so the route maps to a 200 'logged' response\./,
    );
    expect(body).toMatch(
      /if \(admission\.kind === 'manual-transcript'\) \{[\s\S]*const operatorEntry = \{\s*\n?\s*at,\s*\n?\s*role: 'operator' as const,\s*\n?\s*body: args\.userMessage,\s*\n?\s*\};/,
    );
    expect(body).toMatch(/return \{ kind: 'logged-manual', session: updated \};/);
  });

  it("Append-user-FIRST ordering framing pinned: 'Append the user turn FIRST so the decomposer sees its own prior plans + the new user task in the history.' — pinned so the decomposer-sees-current-turn-as-history rationale stays documented (drift to append-user-after-decompose would force the decomposer to receive the new task TWICE: once in args.task + once in history → potential double-handling)", () => {
    expect(body).toMatch(
      /\/\/ Append the user turn FIRST so the decomposer sees its own\s*\n?\s*\/\/ prior plans \+ the new user task in the history\./,
    );
  });

  it("Q.1.b hybrid-error-classification framing pinned: 'hybrid error classification per founder verdict 2026-05-17. Transient operational failures (5xx after the decomposer's internal retry, network errors) return a synthesized refuse so the customer's session stays active and they can retry the same turn after upstream recovery. Fatal failures (credential errors / malformed responses / missing-key configuration) re-throw — the route layer maps them to 502 + Sentry alert.' — pinned so the Q.1.b verdict + 2026-05-17 lock-date + transient-as-refuse + fatal-as-throw-502 + Sentry-alert contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Q\.1\.b — hybrid error classification per founder verdict\s*\n?\s*\/\/ 2026-05-17\. Transient operational failures \(5xx after the\s*\n?\s*\/\/ decomposer's internal retry, network errors\) return a\s*\n?\s*\/\/ synthesized refuse so the customer's session stays active\s*\n?\s*\/\/ and they can retry the same turn after upstream recovery\./,
    );
    expect(body).toMatch(
      /\/\/ Fatal failures \(credential errors \/ malformed responses \/\s*\n?\s*\/\/ missing-key configuration\) re-throw — the route layer maps\s*\n?\s*\/\/ them to 502 \+ Sentry alert\./,
    );
    expect(body).toMatch(
      /decomposed = \{\s*\n?\s*kind: 'refuse',\s*\n?\s*refuseReason: 'agent layer temporarily unavailable; please retry',\s*\n?\s*tokensConsumed: 0,\s*\n?\s*\};/,
    );
  });

  it('completed upstream usage is recorded before the durable active fence; every later mutation and executor suffix is lifecycle-gated', () => {
    const usageRecorder = body.indexOf('if (this.deps.usageRecorder !== undefined');
    const activeFence = body.indexOf(
      'if (!(await this.authorityStillCurrent(session.id, admission)))',
      usageRecorder,
    );
    const activeDebit = body.indexOf('const debited = await this.debitTokensIfActive', activeFence);
    expect(usageRecorder).toBeGreaterThan(-1);
    expect(activeFence).toBeGreaterThan(usageRecorder);
    expect(activeDebit).toBeGreaterThan(activeFence);
    expect(body).toMatch(/appendTranscriptIfAuthorityRevision\(/);
    expect(body).toMatch(/shouldContinue: authorityMayContinue/);
    expect(body).toMatch(/closeWithReasonIfAuthorityRevision\(/);
  });

  it('control authority is revision-bound, non-decrypting, fail-closed, and re-elects the local owner after its awaited admission read', () => {
    expect(body).toMatch(/export interface AgentControlAuthoritySnapshot \{/);
    expect(body).toMatch(/revision: number;/);
    expect(body).toMatch(/getAuthoritySnapshot\(sessionId\)/);
    expect(body).toMatch(/catch \{[\s\S]*return false;[\s\S]*\}/);
    expect(body).toMatch(/admission\.authority\.revision/);
    expect(body).toMatch(/kind: 'ai-control-unavailable';/);
    expect(body).toMatch(/AgentDecomposerContinuationDeniedError/);
    expect(
      (body.match(/this\.activeTurnSessionIds\.has\(args\.agentSessionId\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('settled provider work is accounted before codec errors or optional read-back publication', () => {
    expect(body).toMatch(/err instanceof AgentDecomposerSettledError/);
    expect(body).toMatch(/error instanceof AgentDecomposerSettledError/);
    expect(body).toMatch(/latestReadbackEvidence/);
    expect(body).toMatch(/The provider has settled\. Account that work exactly once/);
    expect(body).toMatch(/settled spend is already recorded above/);
  });
});
