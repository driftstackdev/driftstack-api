// Whether the LIVE tier may run, and with what — decided in one place.
//
// ⛔ IT IS OPT-IN THREE TIMES OVER, AND REFUSES UNDER CI OUTRIGHT. A live run
// calls a real model: it costs money, it is not deterministic, and its result
// must never gate anything. So it needs an explicit `EVAL_LIVE=1`, AND a key in
// the environment variable the product itself reads for its deployment key, AND
// to have been started through its own vitest config — and with `CI` set it
// stays skipped whatever else is present, because a key that happens to be in a
// pipeline's environment is not someone choosing to spend it.
//
// ⛔ WHY THE THIRD CONDITION. The first two are both ENVIRONMENT STATE, and a
// developer shell routinely already exports the key — which left `EVAL_LIVE=1`
// as the whole opt-in, and one stale `export` away from every `npm test` and
// push gate spending money. Naming `--config …/vitest.live.config.ts` is an act
// performed per run; it cannot be left lying around in a shell.
//
// ⛔ THE KEY IS READ HERE AND HANDED ON AS A VALUE. It is never logged, never put
// in a message, and never part of the returned `why`. Everything that prints is
// built from names.

import { CLAUDE_MODELS, DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import {
  CHAT_PLANNER_MODELS,
  UnknownPlannerModelError,
  resolvePlannerModel,
  type PlannerModelSelection,
} from '../../../src/services/agent-planner-providers.js';
import type { LiveSpendCaps } from './live-meter.js';

/**
 * Set by `vitest.live.config.ts` (its `test.env`) and by nothing else. The
 * entry file is already outside every default include glob; this makes "the
 * default suite cannot start a live run" true even of a config that one day
 * collected the file by accident.
 */
export const LIVE_ENTRY_ENV_NAME = 'EVAL_LIVE_ENTRY';
export const LIVE_ENTRY_MARKER = 'vitest.live.config';
export const LIVE_CONFIG_PATH = 'apps/server/tests/eval/vitest.live.config.ts';

/**
 * The environment variables the PRODUCT reads its deployment key from, in the
 * product's own order of preference (`apps/server/src/lib/config.ts`).
 * `agent-eval-live-plumbing.test.ts` pins both names against that file, so a
 * rename there fails a test here instead of silently skipping every live run.
 */
export const LIVE_KEY_ENV_NAMES = [
  'BYOK_ANTHROPIC_FALLBACK_KEY',
  'DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY',
] as const;

/**
 * EVERY variable a live run could read a provider key from: the product's two
 * Anthropic names and each chat provider's own (from the provider table).
 *
 * ⛔ ALL OF THEM ARE SECRETS IN EVERY RUN, NOT ONLY THE ONE IN USE. A developer
 * shell that has exported three providers' keys to run three bake-off arms holds
 * all three while each arm runs, and an error body or a stray log line does not
 * know which arm it belongs to. So every value present in any of these is
 * scrubbed from, and asserted absent from, everything a run writes.
 */
export const ALL_PROVIDER_KEY_ENV_NAMES: ReadonlyArray<string> = [
  ...LIVE_KEY_ENV_NAMES,
  ...new Set(CHAT_PLANNER_MODELS.map((m) => m.provider.keyEnvVar)),
];

/**
 * Default caps, sized for roughly three US dollars at the default model's list
 * price ($5 per million input tokens, $25 per million output).
 *
 * ⛔ THE DOLLAR CAP IS THE ONE THAT IS ACTUALLY ABOUT DOLLARS. It is computed by
 * the meter from what each call reported, at the registry's rates, with output
 * priced as output and cache reads and writes at their own multipliers — so it
 * holds whatever the mix turns out to be. The other two are backstops read the
 * other way, and a token count on its own is NOT a dollar bound: this cap was
 * first 450,000 tokens on an assumed 9:1 input-to-output split, which the one
 * real run contradicted (17.6k output against 15.1k uncached input). All-output,
 * 450k tokens is about $11, not $3.
 *
 * The backstops are sized from that one measured mix (43 calls, 122,947 tokens,
 * $0.61 when priced properly — about $0.014 a call and $5 per million tokens):
 * $3 is roughly 200 calls or 600k tokens. Whichever of the three is reached
 * first stops the run, and the run can overshoot by at most the one call that
 * crossed it (a planning call is capped at 8,192 output tokens, about $0.20).
 */
export const DEFAULT_LIVE_CAPS: LiveSpendCaps = {
  maxCalls: 200,
  maxTotalTokens: 600_000,
  maxUsd: 3,
};
export const DEFAULT_LIVE_REPS = 1;
/** The customer's message, plus one "please continue". A turn plans blind on a
 *  fresh chat, so the second message is where the agent first sees the page
 *  before it plans — leaving it out would measure half the product. */
export const DEFAULT_LIVE_MAX_TURNS = 2;

export interface LiveConfig {
  enabled: true;
  apiKey: string;
  /** NAME of the variable the key came from. Safe to print. */
  apiKeySource: string;
  /** The planner model as EVAL_LIVE_MODEL named it: a Claude id, or a
   *  provider-qualified one (`openai:gpt-5.6-luna`). */
  model: string;
  /** Which adapter family and provider row that id resolved to. */
  selection: PlannerModelSelection;
  /** name → value of every provider key present in the environment — the one
   *  in use and every other — for scrubbing. See ALL_PROVIDER_KEY_ENV_NAMES. */
  providerKeys: ReadonlyMap<string, string>;
  reps: number;
  maxTurns: number;
  caps: LiveSpendCaps;
  /** Task ids to run, or null for the whole corpus. */
  onlyTasks: ReadonlyArray<string> | null;
  /**
   * The thinking policy to MEASURE, or null for the one the product ships. This
   * is how one policy is compared with another through the product's own request
   * assembly — the same knob the product exposes as a constructor dependency.
   */
  thinkingPolicy: LiveThinkingPolicy | null;
  /** False to send requests WITHOUT the schema constraint on the reply, so the
   *  defensive parser can be measured on its own. Null is the product default. */
  structuredOutput: boolean | null;
}

export const LIVE_THINKING_POLICIES = ['disabled', 'adaptive-low'] as const;
export type LiveThinkingPolicy = (typeof LIVE_THINKING_POLICIES)[number];

export interface LiveDisabled {
  enabled: false;
  /** Exactly how to run it. Carries no value from the environment. */
  why: string;
}

/**
 * ⛔ THE KEY IS NEVER SHOWN ON A COMMAND LINE. An inline `NAME=<key> npx …` puts
 * the secret in shell history and in the process list for as long as the run
 * lasts. The instruction is to have it exported already, by name.
 */
export const LIVE_HOW_TO_RUN =
  'The LIVE tier calls a real model, costs money and is nondeterministic, so it never runs by default and no default suite collects it. ' +
  `To run it, with the key ALREADY EXPORTED in ${LIVE_KEY_ENV_NAMES.join(' or ')} (never typed on the command line, where it would land in shell history):\n` +
  `  EVAL_LIVE=1 TMPDIR=/private/tmp/ds-gate npx vitest run --config ${LIVE_CONFIG_PATH}\n` +
  `Optional: EVAL_LIVE_MODEL (default ${DEFAULT_AGENT_MODEL}; one of ${Object.keys(CLAUDE_MODELS).join(', ')}; ` +
  `or, for the provider bake-off, one of ${CHAT_PLANNER_MODELS.map((m) => `${m.qualifiedId} (key in ${m.provider.keyEnvVar})`).join(', ')}), ` +
  `EVAL_LIVE_REPS (default ${String(DEFAULT_LIVE_REPS)}), EVAL_LIVE_MAX_TURNS (default ${String(DEFAULT_LIVE_MAX_TURNS)}), ` +
  `EVAL_LIVE_MAX_USD (default ${String(DEFAULT_LIVE_CAPS.maxUsd)}), EVAL_LIVE_MAX_CALLS (default ${String(DEFAULT_LIVE_CAPS.maxCalls)}), EVAL_LIVE_MAX_TOKENS (default ${String(DEFAULT_LIVE_CAPS.maxTotalTokens)}), ` +
  `EVAL_LIVE_THINKING (${LIVE_THINKING_POLICIES.join(' | ')}; Claude models only; default the product's own policy), EVAL_LIVE_STRUCTURED (0 sends requests without the reply schema; default the product's own), ` +
  'EVAL_LIVE_TASKS (comma-separated task ids), EVAL_REPORT_DIR (where the reports go; default the OS temp directory, and never inside the repository). ' +
  'It writes no baseline and pins no outcome.';

export class LiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveConfigError';
  }
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    // ⛔ NEVER FALL BACK SILENTLY ON A BAD CAP. Someone who typed
    // EVAL_LIVE_MAX_CALLS=1o meant a small number; quietly running with the
    // default 100 would spend ten times what they asked for.
    throw new LiveConfigError(`${name} must be a positive whole number`);
  }
  return value;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  // Same rule as above, and for the same reason: `$3` or `3,50` must not
  // quietly become the default.
  if (!Number.isFinite(value) || value <= 0) {
    throw new LiveConfigError(`${name} must be a positive number of US dollars`);
  }
  return value;
}

export function readLiveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig | LiveDisabled {
  if (env.EVAL_LIVE !== '1') {
    return { enabled: false, why: `EVAL_LIVE is not set to 1. ${LIVE_HOW_TO_RUN}` };
  }
  if (env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false') {
    return {
      enabled: false,
      why: `CI is set, and the live tier never runs in a pipeline. ${LIVE_HOW_TO_RUN}`,
    };
  }
  if (env[LIVE_ENTRY_ENV_NAME] !== LIVE_ENTRY_MARKER) {
    return {
      enabled: false,
      why: `EVAL_LIVE=1, but this was not started through the live tier's own config (--config ${LIVE_CONFIG_PATH}). ${LIVE_HOW_TO_RUN}`,
    };
  }
  // The model decides WHICH key: resolved before the key is looked for.
  const modelRaw = env.EVAL_LIVE_MODEL?.trim();
  const model = modelRaw === undefined || modelRaw.length === 0 ? DEFAULT_AGENT_MODEL : modelRaw;
  let selection: PlannerModelSelection;
  try {
    selection = resolvePlannerModel(model);
  } catch (err) {
    if (!(err instanceof UnknownPlannerModelError)) throw err;
    throw new LiveConfigError(
      `EVAL_LIVE_MODEL is not a model the live tier can run. Use one of: ${Object.keys(CLAUDE_MODELS).join(', ')}, ${CHAT_PLANNER_MODELS.map((m) => m.qualifiedId).join(', ')}`,
    );
  }
  const keyNames: ReadonlyArray<string> =
    selection.kind === 'claude' ? LIVE_KEY_ENV_NAMES : [selection.row.provider.keyEnvVar];
  let apiKey: string | null = null;
  let apiKeySource: string | null = null;
  for (const name of keyNames) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      apiKey = value;
      apiKeySource = name;
      break;
    }
  }
  if (apiKey === null || apiKeySource === null) {
    return {
      enabled: false,
      why: `EVAL_LIVE=1 but no key is present in ${keyNames.join(' or ')}. ${LIVE_HOW_TO_RUN}`,
    };
  }
  const providerKeys = new Map<string, string>();
  for (const name of ALL_PROVIDER_KEY_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) providerKeys.set(name, value);
  }
  const onlyRaw = env.EVAL_LIVE_TASKS?.trim();
  const thinkingRaw = env.EVAL_LIVE_THINKING?.trim();
  const thinkingPolicy =
    thinkingRaw === undefined || thinkingRaw.length === 0
      ? null
      : (LIVE_THINKING_POLICIES.find((policy) => policy === thinkingRaw) ?? undefined);
  if (thinkingPolicy === undefined) {
    // A typo must not quietly measure the default and label it as something else.
    throw new LiveConfigError(
      `EVAL_LIVE_THINKING must be one of: ${LIVE_THINKING_POLICIES.join(', ')}`,
    );
  }
  if (thinkingPolicy !== null && selection.kind !== 'claude') {
    // Nor may a knob that does nothing for this provider be printed on its
    // report as if it had been applied: reasoning for a chat provider is the
    // row's `reasoningEffort`, fixed in the provider table.
    throw new LiveConfigError(
      `EVAL_LIVE_THINKING applies to Claude models only; ${selection.row.qualifiedId} sends reasoning_effort ${String(selection.row.reasoningEffort)} from the provider table`,
    );
  }
  const structuredRaw = env.EVAL_LIVE_STRUCTURED?.trim();
  if (
    structuredRaw !== undefined &&
    structuredRaw.length > 0 &&
    structuredRaw !== '0' &&
    structuredRaw !== '1'
  ) {
    throw new LiveConfigError('EVAL_LIVE_STRUCTURED must be 0 or 1');
  }
  return {
    thinkingPolicy,
    structuredOutput:
      structuredRaw === undefined || structuredRaw.length === 0 ? null : structuredRaw === '1',
    enabled: true,
    apiKey,
    apiKeySource,
    model: selection.kind === 'claude' ? selection.model : selection.row.qualifiedId,
    selection,
    providerKeys,
    reps: positiveInt(env, 'EVAL_LIVE_REPS', DEFAULT_LIVE_REPS),
    maxTurns: positiveInt(env, 'EVAL_LIVE_MAX_TURNS', DEFAULT_LIVE_MAX_TURNS),
    caps: {
      maxCalls: positiveInt(env, 'EVAL_LIVE_MAX_CALLS', DEFAULT_LIVE_CAPS.maxCalls),
      maxTotalTokens: positiveInt(env, 'EVAL_LIVE_MAX_TOKENS', DEFAULT_LIVE_CAPS.maxTotalTokens),
      maxUsd: positiveNumber(env, 'EVAL_LIVE_MAX_USD', DEFAULT_LIVE_CAPS.maxUsd),
    },
    onlyTasks:
      onlyRaw === undefined || onlyRaw.length === 0
        ? null
        : onlyRaw
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
  };
}
