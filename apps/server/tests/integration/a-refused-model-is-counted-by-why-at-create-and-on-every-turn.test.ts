// A model the deployment's key refuses is counted, and counted by WHY — at create
// as well as on every turn.
//
// `driftstack_bundled_llm_error_total{kind}` used to carry one kind for both
// refusals, `model_requires_own_key`, and only on the turn path. That lumped a
// customer choosing Opus (expected: Opus runs on their own key only) with a model
// we have no price for (our configuration fault), so the fault was invisible
// inside the expected traffic; and a refusal at create was not counted at all.
//
// Now: `model_requires_own_key` is the customer's choice, `model_unpriced` is our
// fault (also reported to Sentry, once per model per process), and both are
// counted wherever the refusal happens.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SentryClient, SentryMessage } from '../../src/lib/sentry.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWN_KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ERRORS = 'driftstack_bundled_llm_error_total';

function recordingSentry(): { client: SentryClient; messages: SentryMessage[] } {
  const messages: SentryMessage[] = [];
  return {
    messages,
    client: {
      isInitialized: true,
      captureException: () => {},
      captureMessage: (m) => {
        messages.push(m);
      },
      addBreadcrumb: () => {},
      flush: () => Promise.resolve(true),
      close: () => Promise.resolve(true),
    },
  };
}

describe('a refused model is counted by why, at create and on every turn', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fx) await fx.cleanup();
  });

  const bundledOnly = (sentry?: SentryClient) =>
    buildTestApp({
      enableAgentRuntime: true,
      agentDecomposerKind: 'claude',
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 1_000 },
      ...(sentry !== undefined ? { sentry } : {}),
    });

  const create = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { token_budget: 10_000, ...payload },
    });

  const message = (id: string) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });

  it('CRITICAL an Opus refusal at CREATE is counted as model_requires_own_key', async () => {
    fx = await bundledOnly();
    expect((await create({ model: 'claude-opus-5' })).statusCode).toBe(403);
    expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_requires_own_key' })).toBe(1);
    expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_unpriced' })).toBe(0);
  });

  it('CRITICAL an Opus refusal on a TURN is counted as model_requires_own_key, and is not reported as a fault', async () => {
    const sentry = recordingSentry();
    fx = await bundledOnly(sentry.client);
    const id = (
      await create({ model: 'claude-opus-5' }, { 'x-byok-anthropic-api-key': OWN_KEY })
    ).json<{ id: string }>().id;

    expect((await message(id)).statusCode).toBe(403);
    expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_requires_own_key' })).toBe(1);
    expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_unpriced' })).toBe(0);
    // The customer's choice is not our bug: nothing is sent.
    expect(sentry.messages.filter((m) => m.tags?.['kind'] === 'model_unpriced')).toEqual([]);
  });

  it('CRITICAL an unpriced model on a TURN is counted as model_unpriced — apart from Opus — and reported once to Sentry with the model and route', async () => {
    const sentry = recordingSentry();
    fx = await bundledOnly(sentry.client);
    const id = (await create({})).json<{ id: string }>().id;
    const repo = fx.agentSessionsRepo!;
    const realGet = repo.get.bind(repo);
    vi.spyOn(repo, 'get').mockImplementation(async (sessionId) => {
      const session = await realGet(sessionId);
      return session === null ? null : { ...session, model: 'claude-mystery-bundled-1' as never };
    });

    expect((await message(id)).statusCode).toBe(403);
    expect((await message(id)).statusCode).toBe(403);

    expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_unpriced' })).toBe(2);
    expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_requires_own_key' })).toBe(0);
    const reports = sentry.messages.filter((m) => m.tags?.['kind'] === 'model_unpriced');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.extra).toEqual({
      model: 'claude-mystery-bundled-1',
      route: '/v1/agent-sessions/:id/message',
    });
    // Refused before a concurrency slot is taken.
    expect(fx.bundledTurnConcurrency.current(fx.accountId)).toBe(0);
  });

  it('the /metrics scrape exposes both kinds as separate series', async () => {
    fx = await bundledOnly();
    await create({ model: 'claude-opus-5' });
    const id = (await create({})).json<{ id: string }>().id;
    const repo = fx.agentSessionsRepo!;
    const realGet = repo.get.bind(repo);
    vi.spyOn(repo, 'get').mockImplementation(async (sessionId) => {
      const session = await realGet(sessionId);
      return session === null ? null : { ...session, model: 'claude-mystery-bundled-2' as never };
    });
    await message(id);

    const scrape = await fx.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer test-scrape-token' },
    });
    expect(scrape.statusCode).toBe(200);
    expect(scrape.body).toContain(`${ERRORS}{kind="model_requires_own_key"} 1`);
    expect(scrape.body).toContain(`${ERRORS}{kind="model_unpriced"} 1`);
  });
});
