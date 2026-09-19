// A plan that can only use its own AI key is told to add one.
//
// Some plans may run AI on Driftstack's included AI once the account opts in
// (API Builder, API Scale, Enterprise). Others may only ever run it on the
// customer's own key (Team, Agency, API Starter). An account with no key and no
// opt-in used to get the SAME answer on both: 402 `bundled-llm-consent-required`,
// which tells it to switch the opt-in on. On an own-key-only plan that switch is
// refused with a 403, so the error sent the customer to a fix they cannot apply.
//
// Those plans now get the own-key-required answer. Plans that may use
// Driftstack's AI keep exactly what they had.
//
// `agentDecomposerKind: 'claude'` changes only what the ROUTE believes is wired
// (on a deterministic deployment a missing key is not a problem at all); every
// branch here refuses before any planning call, so the planner is never reached.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES, type AccountTier } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const CONSENT_MISSING = 'driftstack_bundled_llm_error_total';

interface Problem {
  type: string;
  status: number;
  detail: string;
}

describe('a plan that can only use its own AI key is told to add one', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  const noKeyNoOptIn = (tier: AccountTier) =>
    buildTestApp({
      tier,
      enableAgentRuntime: true,
      agentDecomposerKind: 'claude',
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
    });

  const sendTurn = async (headers: Record<string, string> = {}) => {
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 10_000 },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<{ id: string }>().id;
    return fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: 'open https://example.com and capture' },
    });
  };

  it.each(['team_manual', 'agency_manual', 'api_starter'] as const)(
    'CRITICAL on %s, with no key and no opt-in, the turn is refused 502 byok-anthropic-required, not 402 consent-required: it names adding a key and never the opt-in this plan is refused',
    async (tier) => {
      fx = await noKeyNoOptIn(tier);

      // The premise: this plan really is refused the opt-in the old error named.
      const optIn = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { consent: true },
      });
      expect(optIn.statusCode, 'the opt-in is refused on this plan').toBe(403);

      const res = await sendTurn();
      expect(res.statusCode).toBe(502);
      const body = res.json<Problem>();
      expect(body.type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);
      expect(body.detail).toContain('PUT /v1/account/me/byok-anthropic-key');
      expect(body.detail).toContain('x-byok-anthropic-api-key');
      expect(body.detail).not.toMatch(/consent/i);
      expect(body.detail).not.toContain('bundled-llm-settings');
      // It is not counted as a missing opt-in either: there is no opt-in to miss.
      expect(fx.metricsRegistry.getValue(CONSENT_MISSING, { kind: 'consent_missing' })).toBe(0);
    },
  );

  it.each(['api_builder', 'api_scale', 'enterprise'] as const)(
    'on %s, which may use Driftstack’s AI, the same account still gets exactly the 402 consent-required it always did, and is still counted as a missing opt-in',
    async (tier) => {
      fx = await noKeyNoOptIn(tier);
      const res = await sendTurn();
      expect(res.statusCode).toBe(402);
      const body = res.json<Problem & { title: string }>();
      expect(body.type).toBe(PROBLEM_TYPES.BundledLlmConsentRequired);
      expect(body.title).toBe('Bundled-LLM consent required');
      expect(body.detail).toBe(
        'This deployment offers bundled-LLM but your account has not opted in. ' +
          'PATCH /v1/account/me/bundled-llm-settings with { "consent": true } to enable, ' +
          'or PUT /v1/account/me/byok-anthropic-key to bring your own Anthropic key (BYOK always wins).',
      );
      expect(fx.metricsRegistry.getValue(CONSENT_MISSING, { kind: 'consent_missing' })).toBe(1);
    },
  );

  it('an own-key-only plan that SENDS its key is not refused at all', async () => {
    fx = await noKeyNoOptIn('api_starter');
    const res = await sendTurn({
      'x-byok-anthropic-api-key': 'sk-ant-api03-own-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(res.statusCode).toBe(200);
  });

  it('the plan that decides is the one the account is on NOW: the same account, moved to a plan that may use Driftstack’s AI, is told about the opt-in again', async () => {
    fx = await noKeyNoOptIn('api_starter');
    expect((await sendTurn()).statusCode).toBe(502);

    const live = await fx.authRepo.getAccount(fx.accountId);
    if (live === null) throw new Error('fixture account missing');
    fx.authRepo.upsertAccount({ ...live, tier: 'api_builder' });
    expect((await sendTurn()).statusCode).toBe(402);
  });
});
