// The deployment's key (bundled billing) runs only priced, non-Opus models.
//
// The owner's decision of 2026-09-19: Opus-class models are OWN KEY ONLY — never
// on included credits — and a model the registry cannot price must never run on
// the deployment's key, because nothing could meter it. A customer's own key
// keeps every model: the provider bills them directly.
//
// Two places enforce it, and both are tested here:
//  · CREATE, for an account that could only ever run the session on the
//    deployment's key — so the customer is told before a browser launches and
//    their first message fails;
//  · EVERY TURN, because an account can lose its key mid-session (cleared,
//    expired), and the next turn then falls through to the bundled leg.
//
// `agentDecomposerKind: 'claude'` changes only what the ROUTE believes is wired;
// the runtime still runs the deterministic decomposer, which is faithful here
// because every refusal happens before any decomposer call.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWN_KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface Problem {
  type: string;
  status: number;
  detail: string;
  requires_own_key?: boolean;
  model?: string;
}

describe('Opus and unpriced models never run on the deployment key', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fx) await fx.cleanup();
  });

  const bundledOnly = () =>
    buildTestApp({
      enableAgentRuntime: true,
      agentDecomposerKind: 'claude',
      enableByokAnthropic: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 1_000 },
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

  describe('at create', () => {
    it('CRITICAL an Opus session on an account with no key of its own is refused with a 403 that says what works, and no session is created', async () => {
      fx = await bundledOnly();
      const res = await create({ model: 'claude-opus-5' });

      expect(res.statusCode).toBe(403);
      const body = res.json<Problem>();
      expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
      expect(body.requires_own_key).toBe(true);
      expect(body.model).toBe('claude-opus-5');
      expect(body.detail).toMatch(/Claude Opus 5 is available with your own Anthropic key/);
      expect(body.detail).toMatch(/Claude Sonnet 5/);
      // Customer-visible: no internal vocabulary.
      expect(body.detail).not.toMatch(/bundled|deployment|meter|price|registry/i);

      const list = await fx.app.inject({
        method: 'GET',
        url: '/v1/agent-sessions',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(list.json<{ data: unknown[] }>().data).toHaveLength(0);
    });

    it.each(['claude-opus-4-8', 'claude-opus-4-7'])(
      'every Opus-class model is refused the same way (%s)',
      async (model) => {
        fx = await bundledOnly();
        const res = await create({ model });
        expect(res.statusCode).toBe(403);
        expect(res.json<Problem>().requires_own_key).toBe(true);
      },
    );

    it('CRITICAL the default model and the other non-Opus models create as before', async () => {
      fx = await bundledOnly();
      expect((await create({})).statusCode).toBe(201);
      expect((await create({ model: 'claude-sonnet-5' })).statusCode).toBe(201);
      expect((await create({ model: 'claude-haiku-4-5' })).statusCode).toBe(201);
    });

    it('CRITICAL an account that sends its own key on the request keeps Opus', async () => {
      fx = await bundledOnly();
      const res = await create({ model: 'claude-opus-5' }, { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(res.statusCode).toBe(201);
    });

    it('CRITICAL an account with a STORED key keeps Opus', async () => {
      fx = await bundledOnly();
      const put = await fx.app.inject({
        method: 'PUT',
        url: '/v1/account/me/byok-anthropic-key',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { api_key: OWN_KEY },
      });
      expect(put.statusCode).toBe(200);
      expect((await create({ model: 'claude-opus-5' })).statusCode).toBe(201);
    });

    it('an account that has not opted into bundled billing is not refused at create — its turns are refused for THAT, with a message that says so', async () => {
      fx = await buildTestApp({
        enableAgentRuntime: true,
        agentDecomposerKind: 'claude',
        enableBundledLlm: { consent: false, monthlyCapUsdCents: 1_000 },
      });
      expect((await create({ model: 'claude-opus-5' })).statusCode).toBe(201);
    });

    it('a manual session never calls a model, so its model is not checked', async () => {
      fx = await bundledOnly();
      expect((await create({ mode: 'manual', model: 'claude-opus-5' })).statusCode).toBe(201);
    });

    it('a deterministic deployment calls no model, so it has nothing to refuse', async () => {
      fx = await buildTestApp({
        enableAgentRuntime: true,
        enableBundledLlm: { consent: true, monthlyCapUsdCents: 1_000 },
      });
      expect((await create({ model: 'claude-opus-5' })).statusCode).toBe(201);
    });
  });

  describe('on every turn', () => {
    it('CRITICAL a session created with the customer key is refused on the first turn WITHOUT it, before the cap is read or a concurrency slot is taken', async () => {
      fx = await bundledOnly();
      const created = await create(
        { model: 'claude-opus-5' },
        { 'x-byok-anthropic-api-key': OWN_KEY },
      );
      expect(created.statusCode).toBe(201);
      const id = created.json<{ id: string }>().id;
      const capRead = vi.spyOn(fx.bundledLlmRepo, 'sumMonthlySpendCents');

      const res = await message(id);

      expect(res.statusCode).toBe(403);
      expect(res.json<Problem>()).toMatchObject({ requires_own_key: true, model: 'claude-opus-5' });
      expect(capRead).not.toHaveBeenCalled();
      expect(fx.bundledTurnConcurrency.current(fx.accountId)).toBe(0);
    });

    it('CRITICAL the same session runs when the customer key IS sent — own-key Opus is untouched', async () => {
      fx = await bundledOnly();
      const id = (
        await create({ model: 'claude-opus-5' }, { 'x-byok-anthropic-api-key': OWN_KEY })
      ).json<{ id: string }>().id;
      const res = await message(id, { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(res.statusCode).toBe(200);
    });

    it('CRITICAL a Sonnet session on the deployment key still runs (the check is about the model, not the leg)', async () => {
      fx = await bundledOnly();
      const id = (await create({})).json<{ id: string }>().id;
      const res = await message(id);
      expect(res.statusCode).toBe(200);
    });

    it('CRITICAL a model the registry cannot price is refused on the deployment key and runs on the customer key', async () => {
      fx = await bundledOnly();
      const id = (await create({})).json<{ id: string }>().id;
      // A stored id is read back by a cast, so the type does not prove the value
      // is priced. Simulate a row carrying an id with no price.
      const repo = fx.agentSessionsRepo!;
      const realGet = repo.get.bind(repo);
      vi.spyOn(repo, 'get').mockImplementation(async (sessionId) => {
        const session = await realGet(sessionId);
        return session === null ? null : { ...session, model: 'claude-mystery-9' as never };
      });

      const refused = await message(id);
      expect(refused.statusCode).toBe(403);
      expect(refused.json<Problem>()).toMatchObject({
        requires_own_key: true,
        model: 'claude-mystery-9',
      });
      // An unpriced id need not be an Anthropic model, so the message must not
      // promise that an Anthropic key would run it, nor name internals.
      const detail = refused.json<Problem>().detail;
      expect(detail).toMatch(/^This model is available with your own key\./);
      expect(detail).not.toMatch(/Anthropic key\./);
      expect(detail).toMatch(/Claude Sonnet 5/);
      expect(detail).not.toMatch(/bundled|deployment|meter|price|registry/i);

      const own = await message(id, { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(own.statusCode).toBe(200);
    });
  });
});
