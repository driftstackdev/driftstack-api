// THE PROVIDER BAKE-OFF, PROVED WITHOUT A KEY.
//
// The live tier runs any planner model the provider table names — a Claude id,
// or `openai:gpt-5.6-luna` and the other chat-completions rows — through the
// product's own factory, the real runtime and the real executor. This file
// drives the chat-completions path end to end against a stand-in that speaks
// that wire (strict-schema replies, a refusal, a malformed reply, a cached-token
// usage block, and a Stop), and holds every safety property the Claude path
// already has: opt-in only, caps enforced before each call and priced from the
// provider table, and no key — for ANY provider — in any output.
//
// ⛔ WHAT THIS CANNOT SAY. The "models" are functions we wrote. Green here means
// the instrument works for a second wire; it says nothing about how any real
// provider plans.

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import { createPlannerDecomposer } from '../../src/services/agent-planner-providers.js';
import { CHAT_PLANNER_MODELS } from '../../src/services/agent-planner-providers.js';
import { AgentDecomposerCancelledError } from '../../src/services/agent-planner-contract.js';
import {
  ALL_PROVIDER_KEY_ENV_NAMES,
  DEFAULT_LIVE_CAPS,
  LIVE_ENTRY_ENV_NAME,
  LIVE_ENTRY_MARKER,
  LIVE_HOW_TO_RUN,
  LIVE_KEY_ENV_NAMES,
  LiveConfigError,
  readLiveConfig,
} from './_lib/live-config.js';
import { LiveMeter, priceCallUsd } from './_lib/live-meter.js';
import { referenceModel } from './_lib/live-reference-models.js';
import {
  renderLiveReport,
  runLiveSuite,
  writeLiveReport,
  type LiveSuiteArgs,
} from './_lib/live-report.js';
import { LIVE_TASKS, type LiveTask } from './_lib/live-tasks.js';
import {
  chatStandInProvider,
  openRouterStandIn,
  standInChatUsage,
  type ChatStandInModel,
  type OpenRouterStandInHost,
} from './_lib/stand-in-chat-provider.js';

const OPTED_IN = { EVAL_LIVE: '1', [LIVE_ENTRY_ENV_NAME]: LIVE_ENTRY_MARKER };
const LUNA = 'openai:gpt-5.6-luna';
const LUNA_ROW = CHAT_PLANNER_MODELS.find((m) => m.qualifiedId === LUNA)!;

/** ⛔ NOT KEYS. One sentinel per provider variable, so a leak of ANY of them is
 *  findable by search, and a leak is attributable to the variable it came from. */
const SENTINELS: ReadonlyMap<string, string> = new Map(
  ALL_PROVIDER_KEY_ENV_NAMES.map((name, i) => [
    name,
    `sk-SENTINEL-${name.toLowerCase().replace(/_/g, '-')}-${String(1000 + i)}-not-real`,
  ]),
);
const SENTINEL_ENV = Object.fromEntries(SENTINELS);

function task(id: string): LiveTask {
  const found = LIVE_TASKS.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no live task ${id}`);
  return found;
}

/** The sighted reference model, speaking the chat wire: the same plans and the
 *  same read-back answers the Claude-wire stand-in gives, with a usage block
 *  that has a cached prefix and some reasoning. */
function chatReference(taskId: string): ChatStandInModel {
  const model = referenceModel(taskId);
  return (request, index) => ({
    kind: 'reply',
    text: model(request, index).text,
    usage: standInChatUsage({
      prompt_tokens: 3000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: index === 0 ? 0 : 2048 },
      completion_tokens_details: { reasoning_tokens: 30 },
    }),
  });
}

function chatSuiteArgs(
  tasks: ReadonlyArray<LiveTask>,
  model: ChatStandInModel,
  overrides: Partial<LiveSuiteArgs> = {},
) {
  const provider = chatStandInProvider({ model, expectedKey: SENTINELS.get('OPENAI_API_KEY')! });
  const args: LiveSuiteArgs = {
    tasks,
    apiKey: SENTINELS.get('OPENAI_API_KEY')!,
    keySource: 'OPENAI_API_KEY',
    model: LUNA,
    providerKeys: SENTINELS,
    reps: 1,
    maxTurns: 2,
    caps: DEFAULT_LIVE_CAPS,
    gitSha: 'test',
    providerFetch: provider.fetch,
    retryBackoffMs: 0,
    pageAgesWhileModelThinks: () => 0,
    runId: 'bake-off-plumbing',
    ...overrides,
  };
  return { args, provider };
}

describe('live tier — EVAL_LIVE_MODEL takes a provider-qualified id, and the key comes from THAT provider', () => {
  it('a chat row is enabled by its own provider variable, and every other provider key present is collected for scrubbing', () => {
    const config = readLiveConfig({ ...OPTED_IN, ...SENTINEL_ENV, EVAL_LIVE_MODEL: LUNA });
    expect(config).toMatchObject({
      enabled: true,
      model: LUNA,
      apiKey: SENTINELS.get('OPENAI_API_KEY'),
      apiKeySource: 'OPENAI_API_KEY',
      selection: { kind: 'chat' },
    });
    if (!config.enabled) throw new Error('narrow');
    expect([...config.providerKeys.keys()].sort()).toEqual([...SENTINELS.keys()].sort());
  });

  it('⛔ an Anthropic key is NOT a key for another provider: with only that exported, a chat row stays skipped and says which variable it needs', () => {
    const config = readLiveConfig({
      ...OPTED_IN,
      [LIVE_KEY_ENV_NAMES[0]]: SENTINELS.get(LIVE_KEY_ENV_NAMES[0])!,
      EVAL_LIVE_MODEL: LUNA,
    });
    expect(config.enabled).toBe(false);
    if (config.enabled) return;
    expect(config.why).toContain('OPENAI_API_KEY');
    expect(config.why).not.toContain(SENTINELS.get(LIVE_KEY_ENV_NAMES[0])!);
  });

  it('a Claude id, bare or qualified, still reads the product’s own variables', () => {
    for (const model of [DEFAULT_AGENT_MODEL, `anthropic:${DEFAULT_AGENT_MODEL}`]) {
      const config = readLiveConfig({
        ...OPTED_IN,
        [LIVE_KEY_ENV_NAMES[1]]: 'k',
        OPENAI_API_KEY: 'other',
        EVAL_LIVE_MODEL: model,
      });
      expect(config).toMatchObject({
        enabled: true,
        model: DEFAULT_AGENT_MODEL,
        apiKeySource: LIVE_KEY_ENV_NAMES[1],
        selection: { kind: 'claude' },
      });
    }
  });

  it('an unknown model, or a thinking policy on a model it does not apply to, is an ERROR — never a run labelled as something it was not', () => {
    expect(() =>
      readLiveConfig({ ...OPTED_IN, OPENAI_API_KEY: 'k', EVAL_LIVE_MODEL: 'openai:gpt-5' }),
    ).toThrow(LiveConfigError);
    expect(() =>
      readLiveConfig({
        ...OPTED_IN,
        OPENAI_API_KEY: 'k',
        EVAL_LIVE_MODEL: LUNA,
        EVAL_LIVE_THINKING: 'disabled',
      }),
    ).toThrow(/Claude models only/);
  });

  it('the instructions name every row and its key variable — and never put a key on a command line', () => {
    for (const row of CHAT_PLANNER_MODELS) {
      expect(LIVE_HOW_TO_RUN).toContain(row.qualifiedId);
      expect(LIVE_HOW_TO_RUN).toContain(row.provider.keyEnvVar);
    }
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    // ⛔ ONE assignment is allowed, and only in the README: the value read from
    // the macOS keychain INSIDE a command substitution. History records the
    // text `$(security …)`, never the key, and the value reaches only that one
    // process's environment. Anything else after `NAME=` is a key on a line.
    const fromKeychain = (name: string): string =>
      `${name}="$(security find-generic-password -s ${name} -w)"`;
    for (const name of ALL_PROVIDER_KEY_ENV_NAMES) {
      expect(LIVE_HOW_TO_RUN).not.toMatch(new RegExp(`${name}\\s*=`));
      expect(readme.split(fromKeychain(name)).join('')).not.toMatch(new RegExp(`${name}\\s*=`));
    }
    // Positive control on that exemption: the README does document the keychain
    // form for the one-key comparison, so the split above removed something real.
    expect(readme).toContain(fromKeychain('OPENROUTER_API_KEY'));
    // The README carries the bake-off command for every row.
    for (const row of CHAT_PLANNER_MODELS) {
      expect(readme).toContain(`EVAL_LIVE_MODEL=${row.qualifiedId}`);
    }
  });
});

describe('live tier — the chat-completions path runs end to end through the product’s own factory', () => {
  it('the sighted reference model, over the chat wire, drives a task to PASS; the report names the provider, the price list, and the cached and reasoning tokens', async () => {
    const { args, provider } = chatSuiteArgs([task('L-READ')], chatReference('L-READ'));
    const { report } = await runLiveSuite(args);
    const rep = report.tasks[0]?.reps[0];
    expect(rep).toMatchObject({ outcome: 'pass', passedOnTurn: 1 });
    expect(report).toMatchObject({
      model: LUNA,
      providerId: 'openai',
      keySource: 'OPENAI_API_KEY',
    });
    expect(report.pricedAt).toContain(LUNA_ROW.priceSource);
    // Both calls went to the chat endpoint, with the right key, strict schema on.
    expect(
      provider.log.urls.every((u) => u === `${LUNA_ROW.provider.baseUrl}/chat/completions`),
    ).toBe(true);
    expect(provider.log.bearerMatched.every(Boolean)).toBe(true);
    expect(report.requestControls.structuredOutputSent).toEqual(['answer:schema', 'plan:schema']);
    expect(report.requestControls.effortSent).toEqual([
      'answer:reasoning_effort none',
      'plan:reasoning_effort none',
    ]);
    // Cached and reasoning tokens, per model, as reported.
    expect(report.provider.cachedPromptTokens).toBe(2048);
    expect(report.provider.thinkingTokens).toBe(60);
    expect(report.spend).toMatchObject({
      callsStarted: 2,
      // prompt 3000 each, minus the cached 2048 on the second: 3000 + 952.
      inputTokens: 3952,
      cacheReadInputTokens: 2048,
      outputTokens: 400,
    });
    // Priced from the provider table, not the Claude registry.
    const expectedUsd = (3952 * 0.2 + 2048 * 0.02 + 400 * 1.2) / 1_000_000;
    expect(report.spend.estimatedUsd).toBe(Math.round(expectedUsd * 100) / 100);
    const text = renderLiveReport(report);
    expect(text).toContain(`provider openai   model ${LUNA}`);
    expect(text).toContain('cached prompt tokens 2048');
  });

  it('a strict-mode REFUSAL is a refuse turn, a MALFORMED reply is a recorded planner failure, and neither is a pass', async () => {
    const refusing = chatSuiteArgs([task('L-READ')], () => ({
      kind: 'reply',
      text: '',
      refusal: 'I will not.',
    }));
    const refused = await runLiveSuite({ ...refusing.args, maxTurns: 1 });
    expect(refused.report.tasks[0]?.reps[0]?.turns[0]?.plans[0]?.result).toBe('refuse');

    const garbled = chatSuiteArgs([task('L-READ')], () => ({
      kind: 'reply',
      text: 'Sure! Step one',
    }));
    const broken = await runLiveSuite({ ...garbled.args, maxTurns: 1 });
    const plan = broken.report.tasks[0]?.reps[0]?.turns[0]?.plans[0];
    expect(plan?.result).toBe('threw');
    expect(plan?.error).toContain('OpenAI response was not valid JSON');
    expect(broken.report.tasks[0]?.passed).toBe(0);
  });

  it('the dollar cap is enforced BEFORE each call, at the provider table price', async () => {
    // Each plan call costs (3000 × $0.20 + 200 × $1.20) / 1e6 = $0.00084.
    const { args } = chatSuiteArgs([task('L-READ'), task('L-FLOW')], chatReference('L-READ'), {
      caps: { ...DEFAULT_LIVE_CAPS, maxUsd: 0.001 },
    });
    const { report } = await runLiveSuite(args);
    expect(report.partial).toBe(true);
    expect(report.stoppedBecause).toContain('dollar cap');
    expect(report.spend.callsStarted).toBe(2);
    expect(report.spend.callsRefusedByCap).toBeGreaterThan(0);
  });

  it('⛔ an UNSTREAMED chat completion (an endpoint that ignored `stream: true`) is metered from its chat usage — not read with the Messages API field names as zero — and trips the dollar cap', async () => {
    const reference = referenceModel('L-READ');
    const buffered: ChatStandInModel = (request, index) => ({
      kind: 'buffered',
      text: reference(request, index).text,
      usage: { prompt_tokens: 3000, completion_tokens: 200 },
    });
    const { args } = chatSuiteArgs([task('L-READ'), task('L-FLOW')], buffered, {
      caps: { ...DEFAULT_LIVE_CAPS, maxUsd: 0.001 },
    });
    const { report } = await runLiveSuite(args);
    expect(report.spend.callsStarted).toBe(2);
    // Read, not guessed: the exact tokens the provider reported, no ceiling.
    expect(report.spend.inputTokens).toBe(6000);
    expect(report.spend.outputTokens).toBe(400);
    expect(report.spend.callsPricedAtCeiling).toBe(0);
    expect(report.stoppedBecause).toContain('dollar cap');
  });

  it('a Stop mid-stream, through the meter: the call ends promptly as a cancellation, and its spend is NOT REPORTED rather than zero — chat completions only state usage at the end', async () => {
    const provider = chatStandInProvider({
      model: () => ({ kind: 'hang-mid-stream', firstText: '{"kind":' }),
      expectedKey: 'k',
    });
    const meter = new LiveMeter(
      provider.fetch,
      DEFAULT_LIVE_CAPS,
      new Map([['k', 'k']]),
      undefined,
      LUNA_ROW.prices,
    );
    const { decomposer } = createPlannerDecomposer(LUNA, {
      chat: { apiKey: 'k', fetch: meter.fetch },
    });
    const controller = new AbortController();
    const pending = decomposer.decompose({
      task: 'open https://example.com',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      history: [],
      budgetTokensRemaining: 100_000,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    const at = performance.now();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AgentDecomposerCancelledError);
    expect(performance.now() - at).toBeLessThan(100);
    const call = meter.records()[0];
    // The RECORD says "not reported" — nobody reported anything…
    expect(call?.inputTokens).toBeNull();
    expect(call?.outputTokens).toBeNull();
    expect(priceCallUsd(call!, LUNA_ROW.prices)).toBe(0);
    // …but the CAPS count it at a ceiling, never as free: the whole request at
    // one token per character, plus the whole reply allowance it asked for.
    const totals = meter.totals();
    expect(totals.callsPricedAtCeiling).toBe(1);
    expect(call?.maxCompletionTokens).toBeGreaterThan(0);
    const ceilingIn = call!.requestBytes;
    const ceilingOut = call!.maxCompletionTokens!;
    expect(totals.totalTokens).toBe(ceilingIn + ceilingOut);
    expect(totals.estimatedUsd).toBeCloseTo(
      (ceilingIn * LUNA_ROW.prices.inputUsdPerMTok +
        ceilingOut * LUNA_ROW.prices.outputUsdPerMTok) /
        1_000_000,
      12,
    );
  });

  it('a chat call that ended with no usage stops the run at the dollar cap by its ceiling, and the report says the figure is a ceiling; an error-status call is not charged', async () => {
    // Every reply ends with no usage block at all (a provider that ignores
    // `stream_options.include_usage`), so the adapter throws each one — and
    // each is still counted against the cap.
    const { args } = chatSuiteArgs(
      [task('L-READ'), task('L-FLOW')],
      () => ({ kind: 'reply', text: '{"kind":"plan"}', usage: null }),
      { caps: { ...DEFAULT_LIVE_CAPS, maxUsd: 0.01 } },
    );
    const { report } = await runLiveSuite(args);
    expect(report.spend.callsPricedAtCeiling).toBeGreaterThan(0);
    expect(report.spend.callsPricedAtCeiling).toBe(report.spend.callsStarted);
    expect(report.stoppedBecause).toContain('dollar cap');
    expect(renderLiveReport(report)).toContain('counted at a CEILING');
    const refused = new LiveMeter(
      chatStandInProvider({
        model: () => ({ kind: 'status', status: 401, body: 'no' }),
        expectedKey: 'k',
      }).fetch,
      DEFAULT_LIVE_CAPS,
      new Map(),
      undefined,
      LUNA_ROW.prices,
    );
    await refused.fetch('https://x.test/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6-luna', messages: [], max_completion_tokens: 10 }),
    });
    await refused.settle();
    expect(refused.totals()).toMatchObject({ callsPricedAtCeiling: 0, estimatedUsd: 0 });
  });
});

describe('live tier — ⛔ no provider key, for ANY provider, reaches any output', () => {
  it('a run that holds every provider key writes none of them, even when the provider ECHOES them all in an error and a reply', async () => {
    const allKeys = [...SENTINELS.values()].join(' ');
    let n = 0;
    const echoing: ChatStandInModel = (request, index) => {
      n += 1;
      if (n === 1) {
        return {
          kind: 'status',
          status: 500,
          body: JSON.stringify({ error: { message: `bad keys ${allKeys}` } }),
        };
      }
      const reply = chatReference('L-READ')(request, index);
      return reply.kind === 'reply' ? { ...reply, text: reply.text } : reply;
    };
    const { args, provider } = chatSuiteArgs([task('L-READ')], echoing);
    const { report, secrets } = await runLiveSuite(args);
    // Every sentinel is a secret of this run, the unused providers' included.
    for (const name of SENTINELS.keys()) expect(secrets.has(name), name).toBe(true);
    // The Anthropic sentinels never went to the chat provider at all.
    for (const body of provider.log.bodies) {
      for (const name of LIVE_KEY_ENV_NAMES) expect(body).not.toContain(SENTINELS.get(name)!);
    }
    expect(JSON.stringify(report.provider.errors)).toContain('[REDACTED:');
    const dir = resolve(tmpdir(), `driftstack-agent-eval-bake-off-${String(process.pid)}`);
    try {
      const written = writeLiveReport(report, secrets, dir);
      for (const output of [
        readFileSync(written.jsonPath, 'utf8'),
        readFileSync(written.textPath, 'utf8'),
        JSON.stringify(report),
        renderLiveReport(report),
      ]) {
        for (const [name, value] of SENTINELS) expect(output.includes(value), name).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── ONE OPENROUTER KEY ────────────────────────────────────────────────────

const OR_LUNA = 'openrouter:openai/gpt-5.6-luna';
const OR_LUNA_ROW = CHAT_PLANNER_MODELS.find((m) => m.qualifiedId === OR_LUNA)!;
const OR_SONNET = 'openrouter:anthropic/claude-sonnet-5';
const OR_KEY = SENTINELS.get('OPENROUTER_API_KEY')!;

/** What OpenRouter's catalogue lists for the two models these tests route,
 *  CHEAPEST FIRST — so an unpinned request lands on a host the row never named. */
const HOSTS: Readonly<Record<string, ReadonlyArray<OpenRouterStandInHost>>> = {
  'openai/gpt-5.6-luna': [
    { slug: 'azure', name: 'Azure', structuredOutputs: true },
    { slug: 'openai', name: 'OpenAI', structuredOutputs: true },
  ],
  'anthropic/claude-sonnet-5': [
    { slug: 'amazon-bedrock', name: 'Amazon Bedrock', structuredOutputs: false },
    { slug: 'anthropic', name: 'Anthropic', structuredOutputs: true },
  ],
};

function openRouterSuite(
  model: string,
  tasks: ReadonlyArray<LiveTask>,
  standIn: ReturnType<typeof openRouterStandIn>,
  overrides: Partial<LiveSuiteArgs> = {},
) {
  const provider = chatStandInProvider({ model: standIn.model, expectedKey: OR_KEY });
  const args: LiveSuiteArgs = {
    tasks,
    apiKey: OR_KEY,
    keySource: 'OPENROUTER_API_KEY',
    model,
    providerKeys: SENTINELS,
    reps: 1,
    maxTurns: 2,
    caps: DEFAULT_LIVE_CAPS,
    gitSha: 'test',
    providerFetch: provider.fetch,
    retryBackoffMs: 0,
    pageAgesWhileModelThinks: () => 0,
    runId: 'openrouter-plumbing',
    ...overrides,
  };
  return { args, provider };
}

describe('live tier — ONE OpenRouter key runs the comparison, pinned, capped and scrubbed', () => {
  it('OPENROUTER_API_KEY enables every openrouter: row, and is the ONLY key that does — an OpenAI or Anthropic key never stands in for it', () => {
    expect(ALL_PROVIDER_KEY_ENV_NAMES).toContain('OPENROUTER_API_KEY');
    const rows = CHAT_PLANNER_MODELS.filter((m) => m.provider.id === 'openrouter');
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      const config = readLiveConfig({
        ...OPTED_IN,
        ...SENTINEL_ENV,
        EVAL_LIVE_MODEL: row.qualifiedId,
      });
      expect(config, row.qualifiedId).toMatchObject({
        enabled: true,
        model: row.qualifiedId,
        apiKey: OR_KEY,
        apiKeySource: 'OPENROUTER_API_KEY',
      });
    }
    const withoutIt = { ...SENTINEL_ENV };
    delete withoutIt.OPENROUTER_API_KEY;
    const config = readLiveConfig({ ...OPTED_IN, ...withoutIt, EVAL_LIVE_MODEL: OR_LUNA });
    expect(config.enabled).toBe(false);
    if (config.enabled) return;
    expect(config.why).toContain('OPENROUTER_API_KEY');
    for (const value of SENTINELS.values()) expect(config.why).not.toContain(value);
  });

  it('the README runs every openrouter: row with the key read from the keychain, and names the control and the caveats', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    for (const row of CHAT_PLANNER_MODELS.filter((m) => m.provider.id === 'openrouter')) {
      expect(readme).toMatch(
        new RegExp(
          `OPENROUTER_API_KEY="\\$\\(security find-generic-password -s OPENROUTER_API_KEY -w\\)" \\\\\\n\\s*EVAL_LIVE=1 EVAL_LIVE_MODEL=${row.qualifiedId.replace(/[./]/g, (c) => `\\${c}`)} `,
        ),
      );
    }
    for (const phrase of [
      'like-for-like CONTROL',
      'extra hop',
      'Caching differs',
      'Synthetic fixture',
      'zero data retention',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it('the sighted reference passes through the stand-in router; EVERY call is pinned, served by the named host, and priced at list + the 5.5% fee — with OpenRouter’s own cost beside it', async () => {
    const standIn = openRouterStandIn({
      hosts: HOSTS,
      creditUsd: 10,
      costPerCallUsd: 0.0005,
      inner: chatReference('L-READ'),
    });
    const { args, provider } = openRouterSuite(OR_LUNA, [task('L-READ')], standIn);
    const { report } = await runLiveSuite(args);
    expect(report.tasks[0]?.reps[0]).toMatchObject({ outcome: 'pass', passedOnTurn: 1 });
    expect(report).toMatchObject({ providerId: 'openrouter', keySource: 'OPENROUTER_API_KEY' });
    expect(
      provider.log.urls.every((u) => u === 'https://openrouter.ai/api/v1/chat/completions'),
    ).toBe(true);
    expect(provider.log.bearerMatched.every(Boolean)).toBe(true);
    // The pin, on every request, and where each one landed.
    expect(standIn.log.routing).toEqual(
      standIn.log.routing.map(() => ({
        only: ['openai'],
        allow_fallbacks: false,
        require_parameters: true,
      })),
    );
    expect(standIn.log.servedBy.every((s) => s === 'openai')).toBe(true);
    expect(report.provider.servedBy).toEqual(['OpenAI']);
    expect(report.routing).toContain(
      'provider.only ["openai"], allow_fallbacks false, require_parameters true',
    );
    expect(report.requestControls.effortSent).toEqual([
      'answer:reasoning.effort none',
      'plan:reasoning.effort none',
    ]);
    // Priced at the fee-inclusive table price, not the upstream's bare list.
    expect(OR_LUNA_ROW.prices.inputUsdPerMTok).toBeCloseTo(0.2 * 1.055, 9);
    const expectedUsd =
      (3952 * OR_LUNA_ROW.prices.inputUsdPerMTok +
        2048 * OR_LUNA_ROW.prices.cachedInputUsdPerMTok +
        400 * OR_LUNA_ROW.prices.outputUsdPerMTok) /
      1_000_000;
    expect(report.spend.estimatedUsd).toBe(Math.round(expectedUsd * 100) / 100);
    expect(report.spend.providerReportedUsd).toBeCloseTo(0.001, 12);
    // …and per TASK, which is where a non-Latin page's cost is read.
    expect(report.tasks[0]?.spend).toMatchObject({
      inputTokens: 3952,
      outputTokens: 400,
      cacheReadTokens: 2048,
    });
    expect(report.tasks[0]?.spend.estimatedUsd).toBeCloseTo(expectedUsd, 12);
    expect(report.tasks[0]?.spend.providerReportedUsd).toBeCloseTo(0.001, 12);
    const text = renderLiveReport(report);
    expect(text).toContain('served by [OpenAI]');
    expect(text).toContain('provider-reported cost — $0.0010');
    expect(text).toContain('spend by task');
  });

  it('positive control on the router: a request WITHOUT the pin is served by whatever host is cheapest — which is what the pin exists to stop', () => {
    const standIn = openRouterStandIn({
      hosts: HOSTS,
      creditUsd: 10,
      costPerCallUsd: 0.0005,
      inner: () => ({ kind: 'reply', text: '{}' }),
    });
    standIn.model(
      {
        model: 'openai/gpt-5.6-luna',
        system: null,
        stream: true,
        purpose: 'plan',
        messages: [],
        body: { model: 'openai/gpt-5.6-luna', response_format: { type: 'json_schema' } },
      },
      0,
    );
    expect(standIn.log.servedBy).toEqual(['azure']);
  });

  it('⛔ a pinned host that cannot serve the request is REFUSED, never substituted: no call lands elsewhere, and the report says the pin held and no other host was tried', async () => {
    // The pinned host lacks structured outputs here; Bedrock is available and
    // cheaper — and must not be used.
    const hosts = {
      'anthropic/claude-sonnet-5': [
        { slug: 'amazon-bedrock', name: 'Amazon Bedrock', structuredOutputs: true },
        { slug: 'anthropic', name: 'Anthropic', structuredOutputs: false },
      ],
    };
    const standIn = openRouterStandIn({
      hosts,
      creditUsd: 10,
      costPerCallUsd: 0.0005,
      inner: chatReference('L-READ'),
    });
    const { args } = openRouterSuite(OR_SONNET, [task('L-READ')], standIn, { maxTurns: 1 });
    const { report } = await runLiveSuite(args);
    expect(standIn.log.servedBy.every((s) => s === null)).toBe(true);
    expect(report.tasks[0]?.passed).toBe(0);
    expect(report.provider.servedBy).toEqual([]);
    const plan = report.tasks[0]?.reps[0]?.turns[0]?.plans[0];
    expect(plan?.result).toBe('threw');
    expect(plan?.error).toContain('the pinned upstream "anthropic" could not serve this request');
    expect(plan?.error).toContain('no other host was tried');
    expect(report.provider.errors.join(' ')).toContain('No available model provider');
    // A refused call was not charged.
    expect(report.spend.estimatedUsd).toBe(0);
  });

  it('⛔ an account out of credit (402) is worded as a top-up, not a model failure; it is not retried; and no key reaches any output', async () => {
    const standIn = openRouterStandIn({
      hosts: HOSTS,
      creditUsd: 0.0005,
      costPerCallUsd: 0.0005,
      inner: chatReference('L-READ'),
    });
    const { args } = openRouterSuite(OR_LUNA, [task('L-READ'), task('L-FLOW')], standIn);
    const { report, secrets } = await runLiveSuite(args);
    const errors = report.tasks.flatMap((t) =>
      t.reps.flatMap((r) =>
        r.turns.flatMap((turn) => [
          ...turn.plans.flatMap((p) => (p.error === undefined ? [] : [p.error])),
          ...turn.answerErrors,
        ]),
      ),
    );
    const outOfCredit = errors.filter((e) =>
      e.includes('the OpenRouter account is out of credits'),
    );
    expect(outOfCredit.length).toBeGreaterThan(0);
    // Each CALL that met the 402 made exactly ONE request: a top-up is not a
    // transient, and retrying it would only spend another round trip.
    const refusedRequests = standIn.log.servedBy.filter((s) => s === null).length;
    expect(refusedRequests).toBe(outOfCredit.length);
    expect(report.tasks[0]?.passed).toBe(0);
    const dir = resolve(tmpdir(), `driftstack-agent-eval-openrouter-${String(process.pid)}`);
    try {
      const written = writeLiveReport(report, secrets, dir);
      for (const output of [written.json, written.text, JSON.stringify(report)]) {
        for (const [name, value] of SENTINELS) expect(output.includes(value), name).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
