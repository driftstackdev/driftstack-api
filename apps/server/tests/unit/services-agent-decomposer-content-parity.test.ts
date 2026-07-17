// Drift guard for apps/server/src/services/agent-decomposer.ts. Pins
// the V-361 NL→intent decomposer interface — AgentDecomposer
// interface, TranscriptEntry/DecomposeResult/AgentIntent type system,
// BYOK Anthropic API key threading, founder verdict 2026-05-16
// v1.1→v1.0 scope reversal.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-decomposer.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-decomposer content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-361 module-level framing pinned: 'AI agent layer NL→intent decomposer interface. AI-1 slice = interface + types scaffold; concrete impl lands in follow-up slices (B1 Anthropic client wire + prompt template, B2 intent executor against existing session API, B3 per-session token budget enforcer, B4 recipe-library writer).' — pinned so the V-361 anchor + AI-1-scaffold-only + 4-follow-up-slice catalog (B1/B2/B3/B4) all stay documented", () => {
    expect(body).toMatch(
      /\/\/ V-361 — AI agent layer NL→intent decomposer interface\. AI-1\s*\n?\s*\/\/ slice = interface \+ types scaffold; concrete impl lands in\s*\n?\s*\/\/ follow-up slices \(B1 Anthropic client wire \+ prompt template,\s*\n?\s*\/\/ B2 intent executor against existing session API, B3 per-session\s*\n?\s*\/\/ token budget enforcer, B4 recipe-library writer\)\./,
    );
  });

  it("v1.1 → v1.0 scope-reversal framing pinned: 'founder verdict 2026-05-16 moved this from v1.1 → v1.0 launch arc (close to finishing all tasks earlier on, and can work on these things just fine, so we should just do it before launch — a great feature that can attract many customers).' — pinned so the 2026-05-16 verdict + the founder-quote rationale stay documented as the trail for AI-chat being v1.0 instead of v1.1", () => {
    expect(body).toMatch(
      /\/\/ Design doc: docs\/internal\/ai-chat-agent-layer-design\.md\s*\n?\s*\/\/ Scope reversal: founder verdict 2026-05-16 moved this from v1\.1\s*\n?\s*\/\/ → v1\.0 launch arc \("close to finishing all tasks earlier on, and\s*\n?\s*\/\/ can work on these things just fine, so we should just do it\s*\n?\s*\/\/ before launch — a great feature that can attract many customers"\)\./,
    );
  });

  it("Activation-pattern framing pinned: 'follows the same all-or-nothing posture as Postmark / LiveKit / OAuth-client / session-egress — bootstrap wires agentDecomposer into AppDeps only when the Anthropic key path is configured (BYOK or bundled). Until then the /agent dashboard surface stays unregistered (404), matching the pre-Stripe-wire posture of /v1/billing.' — pinned so the 4-feature-precedent (Postmark/LiveKit/OAuth/session-egress) + Anthropic-key-gates-wire + /agent-stays-404 + pre-Stripe-wire-/v1/billing analogy all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Activation pattern follows the same all-or-nothing posture as\s*\n?\s*\/\/ Postmark \/ LiveKit \/ OAuth-client \/ session-egress — bootstrap\s*\n?\s*\/\/ wires `agentDecomposer` into AppDeps only when the Anthropic key\s*\n?\s*\/\/ path is configured \(BYOK or bundled\)\. Until then the \/agent\s*\n?\s*\/\/ dashboard surface stays unregistered \(404\), matching the\s*\n?\s*\/\/ pre-Stripe-wire posture of \/v1\/billing\./,
    );
  });

  it("TranscriptEntry shape pinned: at (ISO timestamp) + role ('user' | 'agent' | 'operator') + body + optional intents. + 'operator (Arc 2 sub-slice 8.6) is the manual-mode actor — the human driving intents directly without a decomposer call. Recipes assembly + dashboard UI both branch on this so manual-driven turns render distinctly.' framing — pinned so the 3-role enum + 8.6-operator-manual-mode + Q.5.c-recipes-flatMap-uses-intents-field all stay documented", () => {
    expect(body).toMatch(/export interface TranscriptEntry \{/);
    expect(body).toMatch(/\/\*\* ISO timestamp the entry was created\. \*\/\s*\n?\s*at: string;/);
    expect(body).toMatch(/role: 'user' \| 'agent' \| 'operator';/);
    expect(body).toMatch(
      /\*\s+Whose turn this is\. 'operator' \(Arc 2 sub-slice 8\.6\) is the\s*\n?\s*\*\s+manual-mode actor — the human driving intents directly without a\s*\n?\s*\*\s+decomposer call\./,
    );
    expect(body).toMatch(/intents\?: ReadonlyArray<AgentIntent>;/);
  });

  it('CredentialBag encrypted-at-rest + redacted-rendering framing pinned with its three-field shape', () => {
    expect(body).toMatch(
      /\*\s+Customer-supplied credentials for log-in flows the agent might\s*\n?\s*\*\s+need to drive\. Held in-memory for the agent-session lifetime and never\s*\n?\s*\*\s+persisted in plaintext; transcript copies are protected by the encrypted\s*\n?\s*\*\s+transcript envelope and rendered as `\[redacted\]` where applicable\./,
    );
    expect(body).toMatch(
      /export interface CredentialBag \{\s*\n?\s*username\?: string;\s*\n?\s*password\?: string;\s*\n?\s*\/\*\* Free-form per-credential metadata \(e\.g\. 2FA seed, recovery\s*\n?\s*\*\s+email\)\. Each key is treated as sensitive\. \*\/\s*\n?\s*extras\?: Readonly<Record<string, string>>;\s*\n?\s*\}/,
    );
  });

  it("v2-#4 Q.1.e DecomposeUsage telemetry framing pinned: 'ClaudeAgentDecomposer fills this in; DeterministicAgentDecomposer leaves it undefined. The AgentRuntime records a usage row when this is present so we can cost-track every decompose() call even before the bundled-LLM tier launches (founder Q.1.e verdict: cost-tracked, unbilled at v1.0).' + 5-field shape (decomposerKind + anthropicInputTokens + anthropicOutputTokens + costUsdCents + model) — pinned so the cost-tracked-unbilled-at-v1.0 + decomposerKind-discriminator + per-model-rate-table rationale all stay documented", () => {
    expect(body).toMatch(
      /\*\s+v2-#4 Q\.1\.e — per-call usage telemetry\. ClaudeAgentDecomposer fills\s*\n?\s*\*\s+this in; DeterministicAgentDecomposer leaves it `undefined`\. The\s*\n?\s*\*\s+AgentRuntime records a usage row when this is present so we can\s*\n?\s*\*\s+cost-track every decompose\(\) call even before the bundled-LLM tier\s*\n?\s*\*\s+launches \(founder Q\.1\.e verdict: cost-tracked, unbilled at v1\.0\)\./,
    );
    expect(body).toMatch(/decomposerKind: 'claude' \| 'deterministic';/);
    expect(body).toMatch(/anthropicInputTokens\?: number;/);
    expect(body).toMatch(/anthropicOutputTokens\?: number;/);
    expect(body).toMatch(/costUsdCents\?: number;/);
    expect(body).toMatch(/model\?: string;/);
  });

  it("costUsdCents rounded-up framing pinned: 'integer; rounded up to the nearest cent so short rows don't undercount'. Drift to rounding down would let bundled-LLM cost-tracking systematically undercount Anthropic spend", () => {
    expect(body).toMatch(
      /\/\*\* Cost in USD cents \(integer; rounded up to the nearest cent so\s*\n?\s*\*\s+short rows don't undercount\)\./,
    );
  });

  it('DecomposeResult 3-variant discriminated union pinned: plan + clarify + refuse. + ≥95% AUP refusal-corpus coverage launch checklist anchor. Drift to dropping refuse would force the runtime to throw on AUP violations (would surface as 500s instead of clean 200 + refuse discriminator)', () => {
    expect(body).toMatch(/export type DecomposeResult =/);
    expect(body).toMatch(/kind: 'plan';/);
    expect(body).toMatch(/kind: 'clarify';/);
    expect(body).toMatch(/kind: 'refuse';/);
    expect(body).toMatch(
      /\/\*\* Customer-facing reason\. Matches the AUP-refusal corpus\s*\n?\s*\*\s+the launch-checklist requires ≥95% coverage on\. \*\//,
    );
  });

  it('AgentIntent 6-kind locked vocabulary pinned: navigate + interact (5-action: tap/type/scroll/swipe/press, W540 press added per A3-W677) + wait (2-condition) + capture (3-kind) + scroll (W140: direction up|down, amount_px?) + behavioral_pause (W140: duration_ms?, reading_word_count?). The agent cannot invent new verbs (the prompt template includes the vocabulary as a constraint); the two W140 behavioural verbs map server-side onto the harness scroll/behavioral_pause control-plane intents — pinned so the api-types↔server lockstep + the closed vocabulary stay documented', () => {
    expect(body).toMatch(/export type AgentIntent =/);
    expect(body).toMatch(/\{ kind: 'navigate'; url: string \}/);
    expect(body).toMatch(
      /kind: 'interact';[\s\S]*?action: 'tap' \| 'type' \| 'scroll' \| 'swipe' \| 'press';/,
    );
    expect(body).toMatch(/sensitive\?: boolean;/);
    expect(body).toMatch(
      /\{ kind: 'wait'; condition: 'idle' \| 'selector_visible'; selector\?: string; timeoutMs\?: number \}/,
    );
    expect(body).toMatch(/\{ kind: 'capture'; capture: 'screenshot' \| 'dom_snapshot' \| 'pdf' \}/);
    // W140 behavioural intents (api-types ↔ server lockstep).
    expect(body).toMatch(/\{ kind: 'scroll'; direction: 'up' \| 'down'; amount_px\?: number \}/);
    expect(body).toMatch(
      /\{ kind: 'behavioral_pause'; duration_ms\?: number; reading_word_count\?: number \}/,
    );
    expect(body).toMatch(
      /agent cannot invent new verbs \(the prompt template includes the\s*\n?\s*\*\s+vocabulary as a constraint\)\. Schema-locked so the executor\s*\n?\s*\*\s+\(B2 follow-up\) is a trivial switch\./,
    );
  });

  it('DecomposeArgs carries the stateless turn inputs plus a fail-closed continuation fence', () => {
    expect(body).toMatch(/export interface DecomposeArgs \{/);
    expect(body).toMatch(/task: string;/);
    expect(body).toMatch(/archetype: string;/);
    expect(body).toMatch(/history: ReadonlyArray<TranscriptEntry>;/);
    expect(body).toMatch(/credentials\?: CredentialBag;/);
    expect(body).toMatch(/budgetTokensRemaining: number;/);
    expect(body).toMatch(/byokAnthropicApiKey\?: string;/);
    expect(body).toMatch(/shouldContinue\?: \(\) => boolean \| Promise<boolean>;/);
    expect(body).toMatch(
      /\*\s+Per-call decomposer input\. The service is stateless across calls;\s*\n?\s*\*\s+callers thread the transcript explicitly so the agent has full\s*\n?\s*\*\s+multi-turn context without the service holding session state\./,
    );
  });

  it("BYOK Anthropic resolution-priority framing pinned: '1. Customer-supplied key (stored encrypted per-account; passed through here per request — never persisted in transcript). 2. Deployment fallback (config.byokAnthropic.fallbackApiKey, env DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY) — for the founder's own demos + integration tests.' + 'NEVER logged, NEVER echoed into transcript or error responses.' — pinned so the 2-step resolution priority + Tier-3-LOCKED-2026-05-16 BYOK-v1.0 + bundled-LLM-deferred-v1.1 + NEVER-logged-NEVER-echoed contract all stay documented", () => {
    expect(body).toMatch(
      /\*\s+BYOK Anthropic API key \(Tier-3 verdict LOCKED 2026-05-16:\s*\n?\s*\*\s+BYOK for v1\.0; bundled-LLM billing deferred to v1\.1\)\./,
    );
    expect(body).toMatch(
      /\*\s+The runtime resolves this in priority order:\s*\n?\s*\*\s+1\. Customer-supplied key \(stored encrypted per-account; passed\s*\n?\s*\*\s+through here per request — never persisted in transcript\)\.\s*\n?\s*\*\s+2\. Deployment fallback \(`config\.byokAnthropic\.fallbackApiKey`,\s*\n?\s*\*\s+env `DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY`\) — for the\s*\n?\s*\*\s+founder's own demos \+ integration tests\./,
    );
    expect(body).toMatch(
      /\*\s+header `x-api-key` value when calling Anthropic\. NEVER logged,\s*\n?\s*\*\s+NEVER echoed into transcript or error responses\./,
    );
  });

  it("AgentDecomposer interface contract pinned: 'NL → intent decomposition for a single turn. Caller threads the full transcript; the service is stateless. Returns one of plan / clarify / refuse per the prompt-template branching. MUST never throw on AUP violations or token-budget exhaustion — those surface as DecomposeResult discriminants instead. Only non-recoverable errors (Anthropic upstream 5xx after retries, credential decryption failure) escape as exceptions.' — pinned so the never-throw-on-AUP-or-budget contract + the only-non-recoverable-throws boundary stay documented", () => {
    expect(body).toMatch(/export interface AgentDecomposer \{/);
    expect(body).toMatch(/decompose\(args: DecomposeArgs\): Promise<DecomposeResult>;/);
    expect(body).toMatch(
      /\*\s+MUST never throw on AUP violations or token-budget exhaustion\s*\n?\s*\*\s+— those surface as DecomposeResult discriminants instead\. Only\s*\n?\s*\*\s+non-recoverable errors \(Anthropic upstream 5xx after retries,\s*\n?\s*\*\s+credential decryption failure\) escape as exceptions\./,
    );
  });

  it('continuation denial has one typed sentinel shared by decompose and read-back calls', () => {
    expect(body).toMatch(/export class AgentDecomposerContinuationDeniedError extends Error/);
    expect(body).toMatch(/export async function requireAgentDecomposerContinuation\(/);
    expect(body).toMatch(/if \(check === undefined\) return;/);
    expect(body).toMatch(/throw new AgentDecomposerContinuationDeniedError\(\);/);
    expect(body).toMatch(/export interface AnswerArgs \{[\s\S]*shouldContinue\?:/);
  });

  it('strict-codec failures retain only validated provider accounting evidence', () => {
    expect(body).toMatch(/export class AgentDecomposerSettledError extends Error/);
    expect(body).toMatch(/readonly tokensConsumed: number;/);
    expect(body).toMatch(/readonly usage: DecomposeUsage;/);
    expect(body).toMatch(/this\.name = 'AgentDecomposerSettledError';/);
    expect(body).not.toMatch(
      /AgentDecomposerSettledError[\s\S]{0,500}(apiKey|credential|responseBody)/,
    );
  });
});
