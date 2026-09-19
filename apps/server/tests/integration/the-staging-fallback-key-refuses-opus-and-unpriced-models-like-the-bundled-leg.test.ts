// The staging fallback is Driftstack's key too, so it refuses what the bundled
// leg refuses: Opus-class models (own key only) and any model with no price.
//
// The fallback (`allowFallbackForUnconfiguredCustomers`, DRIFTSTACK_AGENT_DECOMPOSER_
// USE_FALLBACK) serves an account that has no key of its own and no bundled
// consent. Production refuses to boot with it; staging runs with it. Before this
// file, the per-turn model check sat only inside the consented, plan-entitled
// bundled branch and the create-time check returned early when consent was off —
// so on staging an account with no key and no consent ran Opus, or a model
// nobody can meter, on the deployment's key with nothing counting it.
//
// Both places are tested: CREATE (the early, honest answer before a browser
// launches) and EVERY TURN (the enforcement — an own key can vanish mid-session).
// A customer's own key keeps every model on both.
//
// A model with no price cannot be CREATED over HTTP — the request schema only
// admits registry ids, and the registry prices every one of them (pinned by
// tests/unit/every-model-a-customer-can-pick-on-our-key-has-a-price.test.ts). It
// reaches a turn the way it does in real life: a stored id read back by a cast.
//
// `agentDecomposerKind: 'claude'` changes only what the ROUTE believes is wired;
// the runtime still runs the deterministic decomposer, which is faithful here
// because every refusal happens before any decomposer call.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import type { SentryClient, SentryMessage } from '../../src/lib/sentry.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWN_KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** The stub deployment key tests/integration/_helpers/build-test-app.ts wires. */
const DEPLOYMENT_KEY = 'sk-ant-test-deployment-fallback';
const ERRORS = 'driftstack_bundled_llm_error_total';

interface Problem {
  type: string;
  status: number;
  detail: string;
  requires_own_key?: boolean;
  model?: string;
}

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

describe('the staging fallback key refuses Opus and unpriced models, like the bundled leg', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fx) await fx.cleanup();
  });

  /** No bundled consent, no key of its own: only the fallback can serve it. */
  const fallbackOnly = (extra: Parameters<typeof buildTestApp>[0] = {}) =>
    buildTestApp({
      enableAgentRuntime: true,
      agentDecomposerKind: 'claude',
      allowDeploymentKeyFallback: true,
      ...extra,
    });

  const create = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { token_budget: 10_000, ...payload },
    });

  const message = (id: string, headers: Record<string, string> = {}) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: 'open https://example.com and capture' },
    });

  /** Make every read of the session return `model` — a stored id read back by a
   *  cast, which the type does not prove is priced. */
  const storeModel = (model: string) => {
    const repo = fx.agentSessionsRepo!;
    const realGet = repo.get.bind(repo);
    vi.spyOn(repo, 'get').mockImplementation(async (sessionId) => {
      const session = await realGet(sessionId);
      return session === null ? null : { ...session, model: model as never };
    });
  };

  describe('at create', () => {
    it('CRITICAL an Opus session on an account the fallback would serve is refused with the same 403, counted as model_requires_own_key, and no session is created', async () => {
      fx = await fallbackOnly();
      const res = await create({ model: 'claude-opus-5' });

      expect(res.statusCode).toBe(403);
      const body = res.json<Problem>();
      expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
      expect(body).toMatchObject({ requires_own_key: true, model: 'claude-opus-5' });
      expect(body.detail).toMatch(/Claude Opus 5 is available with your own Anthropic key/);
      expect(body.detail).not.toMatch(/bundled|deployment|fallback|meter|price|registry/i);
      expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_requires_own_key' })).toBe(1);

      const list = await fx.app.inject({
        method: 'GET',
        url: '/v1/agent-sessions',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(list.json<{ data: unknown[] }>().data).toHaveLength(0);
    });

    it.each(['claude-opus-4-8', 'claude-opus-4-7'])(
      'every Opus-class model is refused the same way on the fallback (%s)',
      async (model) => {
        fx = await fallbackOnly();
        const res = await create({ model });
        expect(res.statusCode).toBe(403);
        expect(res.json<Problem>()).toMatchObject({ requires_own_key: true, model });
      },
    );

    it('CRITICAL declining bundled billing does not open the fallback to Opus — the fallback serves that account, so it is refused', async () => {
      fx = await fallbackOnly({ enableBundledLlm: { consent: false, monthlyCapUsdCents: 1_000 } });
      expect((await create({ model: 'claude-opus-5' })).statusCode).toBe(403);
    });

    it('CRITICAL the default model and the other non-Opus models create as before on the fallback', async () => {
      fx = await fallbackOnly();
      expect((await create({})).statusCode).toBe(201);
      expect((await create({ model: 'claude-sonnet-5' })).statusCode).toBe(201);
      expect((await create({ model: 'claude-haiku-4-5' })).statusCode).toBe(201);
      expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_requires_own_key' })).toBe(0);
    });

    it('CRITICAL an account that sends its own key keeps Opus', async () => {
      fx = await fallbackOnly();
      const res = await create({ model: 'claude-opus-5' }, { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(res.statusCode).toBe(201);
    });

    it('CRITICAL an account with a STORED key keeps Opus', async () => {
      fx = await fallbackOnly({ enableByokAnthropic: true });
      const put = await fx.app.inject({
        method: 'PUT',
        url: '/v1/account/me/byok-anthropic-key',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { api_key: OWN_KEY },
      });
      expect(put.statusCode).toBe(200);
      expect((await create({ model: 'claude-opus-5' })).statusCode).toBe(201);
    });

    it('without the fallback, an account with no key and no consent is still not refused at create (its turns are refused for that)', async () => {
      fx = await buildTestApp({
        enableAgentRuntime: true,
        agentDecomposerKind: 'claude',
        enableBundledLlm: { consent: false, monthlyCapUsdCents: 1_000 },
      });
      expect((await create({ model: 'claude-opus-5' })).statusCode).toBe(201);
    });

    it('a deterministic deployment calls no model, so the fallback has nothing to refuse', async () => {
      fx = await buildTestApp({ enableAgentRuntime: true, allowDeploymentKeyFallback: true });
      expect((await create({ model: 'claude-opus-5' })).statusCode).toBe(201);
    });
  });

  describe('on every turn', () => {
    it('CRITICAL a session created with the customer key is refused on the fallback on the first turn WITHOUT it, and counted', async () => {
      fx = await fallbackOnly();
      const created = await create(
        { model: 'claude-opus-5' },
        { 'x-byok-anthropic-api-key': OWN_KEY },
      );
      expect(created.statusCode).toBe(201);
      const id = created.json<{ id: string }>().id;

      const res = await message(id);

      expect(res.statusCode).toBe(403);
      expect(res.json<Problem>()).toMatchObject({ requires_own_key: true, model: 'claude-opus-5' });
      expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_requires_own_key' })).toBe(1);
      expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_unpriced' })).toBe(0);
    });

    it('CRITICAL the same Opus session runs when the customer key IS sent', async () => {
      fx = await fallbackOnly();
      const id = (
        await create({ model: 'claude-opus-5' }, { 'x-byok-anthropic-api-key': OWN_KEY })
      ).json<{ id: string }>().id;
      const res = await message(id, { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(res.statusCode).toBe(200);
    });

    it('CRITICAL a Sonnet session still runs on the fallback (the check is about the model, not the leg)', async () => {
      fx = await fallbackOnly();
      const id = (await create({})).json<{ id: string }>().id;
      const res = await message(id);
      expect(res.statusCode).toBe(200);
    });

    it('CRITICAL a model with no price is refused on the fallback, counted as model_unpriced, reported to Sentry once with the model and route only — and runs on the customer key', async () => {
      const sentry = recordingSentry();
      fx = await fallbackOnly({ sentry: sentry.client });
      const id = (await create({})).json<{ id: string }>().id;
      storeModel('claude-mystery-fallback-1');

      const refused = await message(id);
      expect(refused.statusCode).toBe(403);
      expect(refused.json<Problem>()).toMatchObject({
        requires_own_key: true,
        model: 'claude-mystery-fallback-1',
      });
      const detail = refused.json<Problem>().detail;
      expect(detail).toMatch(/^This model is available with your own key\./);
      expect(detail).not.toMatch(/bundled|deployment|fallback|meter|price|registry/i);

      // Our fault, not the customer's choice: counted apart from Opus.
      expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_unpriced' })).toBe(1);
      expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_requires_own_key' })).toBe(0);

      const reports = sentry.messages.filter((m) => m.tags?.['kind'] === 'model_unpriced');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.extra).toEqual({
        model: 'claude-mystery-fallback-1',
        route: '/v1/agent-sessions/:id/message',
      });
      expect(reports[0]!.tags).toEqual({
        kind: 'model_unpriced',
        route: '/v1/agent-sessions/:id/message',
      });
      // No customer data rides along: no account, session, key or message text.
      const wire = JSON.stringify(reports[0]);
      expect(wire).not.toContain(fx.accountId);
      expect(wire).not.toContain(id);
      expect(wire).not.toContain('example.com');
      // Nor the key this turn resolved to: on this leg, the deployment's own (the
      // stub build-test-app wires for `allowDeploymentKeyFallback`). The whole
      // key, not its public `sk-ant` prefix.
      expect(wire).not.toContain(DEPLOYMENT_KEY);

      // At most once per model per process: the next refusal is counted, not re-sent.
      expect((await message(id)).statusCode).toBe(403);
      expect(fx.metricsRegistry.getValue(ERRORS, { kind: 'model_unpriced' })).toBe(2);
      expect(sentry.messages.filter((m) => m.tags?.['kind'] === 'model_unpriced')).toHaveLength(1);

      const own = await message(id, { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(own.statusCode).toBe(200);
    });

    it('a deterministic deployment calls no model, so a fallback turn has nothing to refuse', async () => {
      fx = await buildTestApp({ enableAgentRuntime: true, allowDeploymentKeyFallback: true });
      const id = (await create({ model: 'claude-opus-5' })).json<{ id: string }>().id;
      expect((await message(id)).statusCode).toBe(200);
    });
  });
});
