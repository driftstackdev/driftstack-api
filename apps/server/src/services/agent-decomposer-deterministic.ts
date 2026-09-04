// AI-B1 — deterministic AgentDecomposer implementation.
//
// Why deterministic before the Anthropic Claude wire (AI-B1.b):
//   1. The AgentDecomposer interface contract has subtle invariants
//      (token-budget exhaustion = refuse, NOT throw; AUP violations =
//      refuse, NOT throw; only upstream 5xx / credential decryption
//      errors escape as exceptions). Locking the contract via a fully
//      tested deterministic impl prevents the LLM-wired version from
//      drifting on these edge cases.
//   2. Dashboard chat-UI work can wire against this immediately —
//      consumers don't have to wait on Anthropic key path decisions
//      (BYOK vs bundled is itself a Tier-3 founder question still
//      pending).
//   3. Tests of the executor (B2 follow-up slice) need a decomposer
//      that returns predictable intents; a deterministic impl gives
//      that without mocking the entire Anthropic SDK.
//
// This impl uses simple keyword heuristics — NOT meant to be the
// product. AI-B1.b replaces the heuristic guts with a real Claude
// Opus 4.7 call against the documented prompt template; the interface
// surface stays identical.

import type {
  AgentDecomposer,
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
} from './agent-decomposer.js';
import { normalizeTaskForScreening } from './task-refusal.js';

// AUP-refusal keyword corpus (subset for the deterministic impl;
// AI-B1.b will use the Anthropic content-policy + a fuller corpus).
// Cases here are the most common abuse patterns that v1.0 launch
// must reject — full corpus per the design doc lives outside this
// repo (legal handles the AUP wording per CLAUDE.md "Business and
// legal/compliance content lives outside any repo").
//
// Exported (audit fix 2026-07-01) — ClaudeAgentDecomposer imports this SAME
// array as its own pre-filter rather than keeping a hand-copied duplicate.
// Two independently-maintained-but-supposed-to-be-identical arrays is exactly
// the shape of bug this session found elsewhere (packages/webhook-delivery's
// reference impl vs apps/server's real forward-path service had the same
// race independently, because nobody was forced to touch both when fixing
// one) — a single shared source can't silently drift. When AI-B1.b's fuller
// corpus work lands, give ClaudeAgentDecomposer its OWN local array at that
// point (a deliberate fork, not a silent one) rather than continuing to
// import this reduced subset.
export const AUP_REFUSAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(child sexual abuse material|csam|child pornography)\b/i,
    reason: 'This task involves content categorically prohibited by our AUP.',
  },
  {
    pattern: /\b(create|generate|make).{0,30}(deepfake|synthetic media of a real person)\b/i,
    reason: 'Creating non-consensual synthetic media of real people is prohibited.',
  },
  {
    pattern: /\b(swat|swatting|fake .{0,15}emergency call)\b/i,
    reason: 'Tasks that endanger people in the physical world are prohibited.',
  },
  {
    pattern: /\b(bypass|circumvent|evade).{0,30}(captcha|rate limit|account ban|moderation)\b/i,
    reason:
      'Driftstack does not orchestrate captcha bypass or evasion of platform safety controls. ' +
      'See https://driftstack.io/legal/aup/',
  },
  {
    pattern: /\b(brute.?force|credential.?stuff|password spray)\b/i,
    reason: 'Credential-attack tasks are prohibited by our AUP.',
  },
];

// Ambiguity heuristics — task too vague to plan against without
// clarification. The AI-B1.b LLM wire will replace this with a
// confidence-thresholded LLM check.
function detectAmbiguity(task: string): string | null {
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    return 'I need a task description to plan. What would you like me to do?';
  }
  if (trimmed.length < 12) {
    return `"${trimmed}" is very short — can you describe what you want me to do in a sentence?`;
  }
  // "do something on X" without a verb -> ambiguous
  if (
    /^(do|something|stuff|try)\b/i.test(trimmed) &&
    !/(open|visit|go to|click|tap|type|fill|search|extract|capture)/i.test(trimmed)
  ) {
    return 'Can you tell me what action you want me to take? For example: "open example.com and search for X".';
  }
  return null;
}

function checkAupRefusal(task: string): string | null {
  // Match the CANONICAL form too, so trivial unicode obfuscation (zero-width
  // joiners, fullwidth/homoglyph letters, soft hyphens) can't slip an abuse
  // task past the pre-filter — the sibling guards (task-refusal.ts,
  // agent-consequential-action.ts) already normalize; this one must match them.
  // Test BOTH raw and normalized so no pattern that matched before can regress.
  // Kept byte-identical to ClaudeAgentDecomposer.checkAupRefusal (cross-source
  // AUP invariant — a drift weakens the deterministic-path AUP enforcement).
  const normalized = normalizeTaskForScreening(task);
  for (const { pattern, reason } of AUP_REFUSAL_PATTERNS) {
    if (pattern.test(task) || pattern.test(normalized)) return reason;
  }
  return null;
}

// Token-count heuristic — char/4 is the standard rough estimator.
// AI-B1.b will use the Anthropic tokenizer for the real count.
function estimateTokens(task: string, history: readonly { body: string }[]): number {
  const taskTokens = Math.ceil(task.length / 4);
  const historyTokens = history.reduce((acc, h) => acc + Math.ceil(h.body.length / 4), 0);
  // System-prompt overhead (intent vocabulary, formatting rules) is
  // ~600 tokens against the AI-B1.b prompt template; charge it.
  return 600 + taskTokens + historyTokens;
}

// Intent-plan synthesis for tasks that pass AUP + ambiguity checks.
// Pulls URLs out of the task as `navigate` intents and adds a default
// dom_snapshot capture; the AI-B1.b LLM wire generates richer plans.
function synthesizePlan(task: string): AgentIntent[] {
  const intents: AgentIntent[] = [];
  // Match greedily then strip a SINGLE trailing punctuation char that's
  // almost always grammatical rather than part of the URL. We don't
  // strip all trailing punctuation because `.example` has a meaningful
  // dot — only the very last char is suspect.
  const rawMatches = task.match(/https?:\/\/[^\s)]+/g);
  const urlMatches = rawMatches?.map((u) => u.replace(/[,.;:!?]+$/, ''));
  if (urlMatches && urlMatches.length > 0) {
    for (const url of urlMatches.slice(0, 3)) {
      intents.push({ kind: 'navigate', url });
    }
  } else {
    // No URL — assume the user wants a generic web search via the
    // archetype's default search engine. AI-B1.b's LLM will pick a
    // real start URL based on task semantics.
    intents.push({ kind: 'navigate', url: 'https://duckduckgo.com/' });
  }
  intents.push({ kind: 'wait', condition: 'idle' });
  intents.push({ kind: 'capture', capture: 'dom_snapshot' });
  return intents;
}

// v2-#4 Q.1.e — uniform usage block so AgentRuntime records a row for
// deterministic turns too. Zero anthropic tokens + zero cost; the
// audit trail just shows "we ran a deterministic plan".
const DETERMINISTIC_USAGE = { decomposerKind: 'deterministic' as const };

export class DeterministicAgentDecomposer implements AgentDecomposer {
  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    const tokensConsumed = estimateTokens(args.task, args.history);

    if (args.budgetTokensRemaining < tokensConsumed) {
      return Promise.resolve({
        kind: 'refuse',
        refuseReason: 'token budget exhausted; start a new session',
        tokensConsumed: 0,
        usage: DETERMINISTIC_USAGE,
      });
    }

    const aupRefusal = checkAupRefusal(args.task);
    if (aupRefusal !== null) {
      return Promise.resolve({
        kind: 'refuse',
        refuseReason: aupRefusal,
        tokensConsumed,
        usage: DETERMINISTIC_USAGE,
      });
    }

    const ambiguity = detectAmbiguity(args.task);
    if (ambiguity !== null) {
      return Promise.resolve({
        kind: 'clarify',
        clarifyingQuestion: ambiguity,
        tokensConsumed,
        usage: DETERMINISTIC_USAGE,
      });
    }

    return Promise.resolve({
      kind: 'plan',
      intents: synthesizePlan(args.task),
      tokensConsumed,
      usage: DETERMINISTIC_USAGE,
    });
  }
}
