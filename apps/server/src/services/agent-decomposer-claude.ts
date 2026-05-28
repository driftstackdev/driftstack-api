// AI-B1.b — real Claude-wired AgentDecomposer implementation.
//
// Calls the Anthropic Messages API via raw fetch (no SDK install) and
// parses a JSON-shaped response into the same DecomposeResult union the
// DeterministicAgentDecomposer returns. Drop-in behind the AgentDecomposer
// interface; the AgentRuntime + executor + sessions repo do not change.
//
// Cost-tolerant path: customer pays via BYOK Anthropic key per
// orchestrator verdict 2026-05-16. The deployment fallback (founder key)
// covers demos + integration tests only — bootstrap resolves the key
// before calling decompose() and never embeds a fallback at this layer.
//
// Contract guarantees (mirroring DeterministicAgentDecomposer):
//   - Token-budget exhaustion → refuse with the standard message, 0
//     tokens charged. Never throws.
//   - AUP-prefilter hit → refuse with the canned reason. Pre-filter
//     short-circuits BEFORE the API call so we don't bill the customer
//     for an obviously-bad task. Never throws.
//   - Anthropic 4xx (auth / quota / validation) → throws. Caller maps
//     to a 502 problem-type so the dashboard surfaces "agent layer
//     misconfigured" rather than charging the customer for nothing.
//   - Anthropic 5xx → single retry with backoff; post-retry 5xx
//     throws. Network errors retried identically.
//   - Malformed JSON content → throws (the wire is broken; surfacing
//     a refuse would silently mask the bug).

import type {
  AgentDecomposer,
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
  DecomposeUsage,
} from './agent-decomposer.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION_HEADER = '2023-06-01';
const MODEL = 'claude-opus-4-7';
const MAX_OUTPUT_TOKENS = 2048;
const MAX_RETRIES_5XX = 1;
const DEFAULT_RETRY_BACKOFF_MS = 1000;

// v2-#4 Q.1.e — Anthropic public list pricing per million tokens for
// claude-opus-4-7. Used to compute the per-call USD cents recorded in
// usage_records.metadata.cost_usd_cents. Sourced from
// https://www.anthropic.com/pricing — verify quarterly + on model
// version bumps. If the rate is wrong, historical rows keep their
// recorded cost (we don't recompute), so the audit trail stays
// internally consistent even when the rate-table drifts.
const CLAUDE_OPUS_4_7_INPUT_USD_PER_MTOK = 5;
const CLAUDE_OPUS_4_7_OUTPUT_USD_PER_MTOK = 25;

// AUP pre-filter — identical to the deterministic decomposer's corpus
// so the same obvious-abuse short-circuit applies before any LLM call.
// The model itself acts as a second filter via the system prompt; this
// layer exists so a known-abusive task can never bill the API or appear
// in Anthropic logs.
const AUP_REFUSAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
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
      'See https://driftstack.dev/legal/aup/',
  },
  {
    pattern: /\b(brute.?force|credential.?stuff|password spray)\b/i,
    reason: 'Credential-attack tasks are prohibited by our AUP.',
  },
];

// System prompt is a locked constant — drift here = silent product
// behavior change. Any edit MUST come with a prompt-template parity
// test that the model still emits the discriminated union shape on a
// fixed eval corpus.
const SYSTEM_PROMPT = [
  'You are the Driftstack agent layer. You decompose a customer natural-',
  'language task into a short ordered plan of intent calls against a',
  'driftstack browser session. The customer cannot see your reasoning;',
  'they only see the structured plan + the executor results.',
  '',
  'CONSTRAINT: you can only emit four intent verbs. You CANNOT invent',
  'new verbs.',
  '',
  '  - navigate { url: string }',
  '  - interact { action: "tap"|"type"|"scroll"|"swipe", selector?: string, value?: string }',
  '  - wait { condition: "idle"|"selector_visible", selector?: string, timeoutMs?: number }',
  '  - capture { capture: "screenshot"|"dom_snapshot"|"pdf" }',
  '',
  'OUTPUT FORMAT: respond with EXACTLY ONE JSON object, no prose, no',
  'markdown fences. The object MUST be one of these three shapes:',
  '',
  '  { "kind": "plan", "intents": [ ... ] }',
  '  { "kind": "clarify", "clarifyingQuestion": "..." }',
  '  { "kind": "refuse", "refuseReason": "..." }',
  '',
  'WHEN TO CLARIFY: the task is too vague to plan against (no clear',
  'action verb, no clear target URL, multiple possible interpretations).',
  '',
  'WHEN TO REFUSE: the task asks you to bypass captchas, brute-force',
  'credentials, stalk a specific person, generate CSAM, create',
  'non-consensual deepfakes, swat / make false emergency calls, or do',
  'anything else categorically prohibited by the AUP at',
  'https://driftstack.dev/legal/aup/. Refuse politely; cite the AUP.',
  '',
  'OTHERWISE: emit a plan. Keep plans short (1-8 intents). Always end',
  'a plan with a capture intent so the customer gets something back.',
].join('\n');

export interface ClaudeAgentDecomposerDeps {
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Retry backoff in ms (test override). Defaults to 1000. */
  retryBackoffMs?: number;
}

export class ClaudeAgentDecomposer implements AgentDecomposer {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly retryBackoffMs: number;

  constructor(deps: ClaudeAgentDecomposerDeps = {}) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  async decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    // 1. Pre-API AUP filter — short-circuit obvious abuse cases so the
    //    Anthropic API never sees them (don't put abusive prompts into
    //    third-party logs, don't bill the customer for an inevitable
    //    refusal). Charges tokens — the input was processed by us.
    const aupRefusal = checkAupRefusal(args.task);
    if (aupRefusal !== null) {
      // No API call → no Anthropic tokens, no cost. Still record a
      // usage row at the AgentRuntime level with decomposerKind=claude
      // (zero tokens) so the audit trail covers the refused turn.
      return {
        kind: 'refuse',
        refuseReason: aupRefusal,
        tokensConsumed: estimateTokens(args.task, args.history),
        usage: makeClaudeUsage(0, 0),
      };
    }

    // 2. Budget pre-check. Refuse with 0 tokens charged so the customer
    //    isn't billed for the exhaustion refusal itself.
    const estimatedTokens = estimateTokens(args.task, args.history);
    if (args.budgetTokensRemaining < estimatedTokens) {
      return {
        kind: 'refuse',
        refuseReason: 'token budget exhausted; start a new session',
        tokensConsumed: 0,
        usage: makeClaudeUsage(0, 0),
      };
    }

    // 3. Credential check. Bootstrap is responsible for resolving the
    //    BYOK customer key OR the deployment fallback into this arg;
    //    if neither resolved, that's a configuration error that should
    //    surface — not a customer refusal.
    if (args.byokAnthropicApiKey === undefined || args.byokAnthropicApiKey === '') {
      throw new Error('ClaudeAgentDecomposer: no Anthropic API key provided');
    }

    // 4. Build the request body. System prompt is constant; messages
    //    interleave the prior transcript so the model sees its own
    //    plans + executor results.
    const messages = buildMessages(args);
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    });

    // 5. Call Anthropic with single retry on 5xx.
    const response = await this.callWithRetry(body, args.byokAnthropicApiKey);

    // 6. Parse the response. Token accounting comes from the API's
    //    usage block — input + output combined, since the customer
    //    pays for both halves of the trip.
    return parseAnthropicResponse(response);
  }

  private async callWithRetry(body: string, apiKey: string): Promise<AnthropicResponseJson> {
    let attempt = 0;
    // Single retry on 5xx; let 4xx + post-retry 5xx escape as exceptions.
    while (true) {
      let res: Response;
      try {
        res = await this.fetchImpl(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION_HEADER,
          },
          body,
        });
      } catch (networkErr) {
        if (attempt < MAX_RETRIES_5XX) {
          attempt++;
          await sleep(this.retryBackoffMs);
          continue;
        }
        throw networkErr;
      }

      if (res.ok) {
        return (await res.json()) as AnthropicResponseJson;
      }

      if (res.status >= 500 && attempt < MAX_RETRIES_5XX) {
        attempt++;
        await sleep(this.retryBackoffMs);
        continue;
      }

      const errorText = await safeReadBody(res);
      throw new Error(`Anthropic API ${res.status}: ${errorText.slice(0, 300)}`);
    }
  }
}

interface AnthropicResponseJson {
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AgentRequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

function buildMessages(args: DecomposeArgs): AgentRequestMessage[] {
  const messages: AgentRequestMessage[] = [];
  for (const entry of args.history) {
    messages.push({
      role: entry.role === 'user' ? 'user' : 'assistant',
      content: entry.body,
    });
  }
  // The current user turn arrives as args.task — the AgentRuntime
  // appends it to the transcript BEFORE calling decompose(), so it's
  // also present in args.history as the last user entry. Skip
  // duplicating it: if the last history entry is from the user with the
  // same body, don't re-append.
  const last = args.history[args.history.length - 1];
  if (!last || last.role !== 'user' || last.body !== args.task) {
    messages.push({ role: 'user', content: args.task });
  }
  // Always include the archetype hint as a final system-style nudge on
  // the user turn. The model treats it as constraint context.
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1]!;
    if (lastMsg.role === 'user') {
      lastMsg.content = `[archetype: ${args.archetype}]\n\n${lastMsg.content}`;
    }
  }
  return messages;
}

function parseAnthropicResponse(json: AnthropicResponseJson): DecomposeResult {
  const textBlock = json.content.find((c) => c.type === 'text' && typeof c.text === 'string');
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('Anthropic response missing text content block');
  }
  // Strip code fences if the model emitted them despite the instruction.
  const raw = textBlock.text
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Anthropic response was not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Anthropic response was not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const kind = obj.kind;

  const inputTokens = json.usage?.input_tokens ?? 0;
  const outputTokens = json.usage?.output_tokens ?? 0;
  const tokensConsumed = inputTokens + outputTokens;
  const usage = makeClaudeUsage(inputTokens, outputTokens);

  if (kind === 'plan') {
    const intents = parseIntents(obj.intents);
    return { kind: 'plan', intents, tokensConsumed, usage };
  }
  if (kind === 'clarify') {
    if (typeof obj.clarifyingQuestion !== 'string') {
      throw new Error('Anthropic clarify response missing clarifyingQuestion');
    }
    return {
      kind: 'clarify',
      clarifyingQuestion: obj.clarifyingQuestion,
      tokensConsumed,
      usage,
    };
  }
  if (kind === 'refuse') {
    if (typeof obj.refuseReason !== 'string') {
      throw new Error('Anthropic refuse response missing refuseReason');
    }
    return { kind: 'refuse', refuseReason: obj.refuseReason, tokensConsumed, usage };
  }
  throw new Error(`Anthropic response has unknown kind: ${String(kind)}`);
}

/**
 * v2-#4 Q.1.e — assemble the per-call usage block from Anthropic's
 * reported input/output tokens. Cost is rounded UP to the nearest
 * cent so micro-rows don't undercount (treats partial cents as a
 * conservative upper bound on what we'd bill if/when bundled-LLM
 * billing turns on).
 */
function makeClaudeUsage(inputTokens: number, outputTokens: number): DecomposeUsage {
  const inputCostUsd = (inputTokens / 1_000_000) * CLAUDE_OPUS_4_7_INPUT_USD_PER_MTOK;
  const outputCostUsd = (outputTokens / 1_000_000) * CLAUDE_OPUS_4_7_OUTPUT_USD_PER_MTOK;
  const totalUsd = inputCostUsd + outputCostUsd;
  const costUsdCents = Math.ceil(totalUsd * 100);
  return {
    decomposerKind: 'claude',
    anthropicInputTokens: inputTokens,
    anthropicOutputTokens: outputTokens,
    costUsdCents,
    model: MODEL,
  };
}

function parseIntents(raw: unknown): ReadonlyArray<AgentIntent> {
  if (!Array.isArray(raw)) {
    throw new Error('Anthropic plan.intents was not an array');
  }
  const out: AgentIntent[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const i = item as Record<string, unknown>;
    switch (i.kind) {
      case 'navigate':
        if (typeof i.url === 'string') out.push({ kind: 'navigate', url: i.url });
        break;
      case 'interact': {
        const action = i.action;
        if (action === 'tap' || action === 'type' || action === 'scroll' || action === 'swipe') {
          out.push({
            kind: 'interact',
            action,
            ...(typeof i.selector === 'string' ? { selector: i.selector } : {}),
            ...(typeof i.value === 'string' ? { value: i.value } : {}),
          });
        }
        break;
      }
      case 'wait': {
        const cond = i.condition;
        if (cond === 'idle' || cond === 'selector_visible') {
          out.push({
            kind: 'wait',
            condition: cond,
            ...(typeof i.selector === 'string' ? { selector: i.selector } : {}),
            ...(typeof i.timeoutMs === 'number' ? { timeoutMs: i.timeoutMs } : {}),
          });
        }
        break;
      }
      case 'capture': {
        const cap = i.capture;
        if (cap === 'screenshot' || cap === 'dom_snapshot' || cap === 'pdf') {
          out.push({ kind: 'capture', capture: cap });
        }
        break;
      }
    }
  }
  return out;
}

function checkAupRefusal(task: string): string | null {
  for (const { pattern, reason } of AUP_REFUSAL_PATTERNS) {
    if (pattern.test(task)) return reason;
  }
  return null;
}

function estimateTokens(task: string, history: readonly { body: string }[]): number {
  const taskTokens = Math.ceil(task.length / 4);
  const historyTokens = history.reduce((acc, h) => acc + Math.ceil(h.body.length / 4), 0);
  // System-prompt overhead (intent vocabulary + format rules) — measured
  // against the locked SYSTEM_PROMPT constant above.
  return 600 + taskTokens + historyTokens;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// Exported for parity tests — the SYSTEM_PROMPT shape is itself a
// product surface (drift = silent behavior change).
export const __TEST_ONLY__ = {
  SYSTEM_PROMPT,
  AUP_REFUSAL_PATTERNS,
  MODEL,
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION_HEADER,
  CLAUDE_OPUS_4_7_INPUT_USD_PER_MTOK,
  CLAUDE_OPUS_4_7_OUTPUT_USD_PER_MTOK,
  makeClaudeUsage,
};
