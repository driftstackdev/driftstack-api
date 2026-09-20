// An AI answer that changed type is one the SDK already reads correctly.
//
// Three refusals a message can get changed their problem TYPE, because the old
// type told a program the wrong thing to do:
//
//   too many turns running on the included AI   429 concurrency-limit            → 429 rate-limited
//   the customer's own AI key was rejected      500 internal                     → 502 byok-anthropic-required
//   no key, on a plan that can only use its own 402 bundled-llm-consent-required → 502 byok-anthropic-required
//
// A type is what a program branches on, so changing one is only safe when the
// NEW type is one the SDK already turns into the right class with the right
// retry answer. The tests beside this one pin what the server puts on the wire.
// This one pins what a program SEES: it sends each message through the SDK,
// imported by package name (the built package, not its source), over real HTTP,
// and asserts the error class, `isRetryable`, and the typed fields.
//
// It also pins the two additive fields a program reads through an error class
// (`session_status` on a 409, `stop_unconfirmed` on a 503), and that `message()`
// makes exactly one request even for a refusal the SDK calls retryable.
//
// TypeScript stands for all three SDKs here because two other tests hold them
// together: cross-sdk-problem-type-mapping-agrees (a type maps to the same class
// in TypeScript, Python and Go) and what-the-sdks-say-they-retry-is-what-they-retry.
//
// What the desktop app keys on is the same set of facts: it starts a fresh send
// after a `byok-anthropic-required` and keeps replaying after a 5xx, it names a
// 429 by status, and it reads `session_status` to tell "ended" from "busy".

import type { AddressInfo } from 'node:net';
import {
  BundledLlmConsentRequiredError,
  ByokAnthropicRequiredError,
  ConcurrencyLimitError,
  ConflictError,
  Driftstack,
  DriftstackError,
  FeatureUnavailableError,
  InternalError,
  RateLimitError,
  isRetryable,
} from '@driftstack/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import { AI_TURNS_RUNNING_RETRY_AFTER_SECONDS } from '../../src/routes/agent-sessions.js';
import {
  buildTestApp,
  type TestAppFixture,
  type TestAppOptions,
} from './_helpers/build-test-app.js';

const OWN_KEY = 'sk-ant-api03-compat-own-key-aaaaaaaaaaaaaaaaaaaaaaaa';
const TASK = 'open https://example.com and capture it';

/** A planner that fails the way the production one does when the provider refuses the key. */
function plannerTheProviderRefuses(status: 401 | 402 | 403): AgentDecomposer {
  return {
    decompose: (_args: DecomposeArgs): Promise<DecomposeResult> =>
      Promise.reject(
        new Error(`Anthropic API ${status.toString()}: {"type":"error","error":{"type":"x"}}`),
      ),
  };
}

describe('an AI answer that changed type is one the SDK already reads correctly', () => {
  let fx: TestAppFixture | undefined;
  /** Every request the SDK made, as `METHOD path`. */
  let requests: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fx !== undefined) await fx.cleanup();
    fx = undefined;
    requests = [];
  });

  const start = async (opts: TestAppOptions): Promise<{ sdk: Driftstack; fx: TestAppFixture }> => {
    const app = await buildTestApp(opts);
    fx = app;
    await app.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.app.server.address() as AddressInfo).port.toString();
    const countingFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return fetch(input, init);
    };
    const sdk = new Driftstack({
      apiKey: app.plaintext,
      baseUrl: `http://127.0.0.1:${port}`,
      fetch: countingFetch,
    });
    return { sdk, fx: app };
  };

  /** The error a call rejects with; fails the test if it resolves. */
  const refusalOf = async (call: Promise<unknown>): Promise<DriftstackError> => {
    const outcome = await call.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(outcome, 'the call was expected to be refused').toBeInstanceOf(DriftstackError);
    return outcome as DriftstackError;
  };

  /** How many times the SDK sent the message. Checks first that the counter sees traffic at all. */
  const messagesSent = (): number => {
    expect(requests, 'the counting fetch saw the create').toContain('POST /v1/agent-sessions');
    return requests.filter((r) => r.startsWith('POST ') && r.endsWith('/message')).length;
  };

  it('CRITICAL too many turns on the included AI reaches a program as RateLimitError: retryable, with the wait, and no longer the session-slot error that is never worth retrying', async () => {
    const { sdk, fx: app } = await start({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 },
      bundledTurnMaxConcurrency: 1,
    });
    const session = await sdk.agentSessions.create({});
    expect(app.bundledTurnConcurrency.tryAcquire(app.accountId)).toBe(true);

    const err = await refusalOf(sdk.agentSessions.message(session.id, TASK));

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(ConcurrencyLimitError);
    expect(err.status).toBe(429);
    expect(isRetryable(err)).toBe(true);
    expect((err as RateLimitError).retryAfterSeconds).toBe(AI_TURNS_RUNNING_RETRY_AFTER_SECONDS);
    // Retryable is advice to the PROGRAM. The SDK itself never sends a message
    // twice, so a stored refusal is never replayed at it in a loop of our making.
    expect(messagesSent()).toBe(1);
  });

  it.each([401, 403] as const)(
    'CRITICAL the customer’s own key answered %i by the provider reaches a program as ByokAnthropicRequiredError: NOT retryable, where the 500 it replaced was',
    async (providerStatus) => {
      const { sdk } = await start({
        enableAgentRuntime: true,
        agentDecomposer: plannerTheProviderRefuses(providerStatus),
      });
      const session = await sdk.agentSessions.create({ token_budget: 10_000 });

      const err = await refusalOf(
        sdk.agentSessions.message(session.id, TASK, { byokApiKey: OWN_KEY }),
      );

      expect(err).toBeInstanceOf(ByokAnthropicRequiredError);
      expect(err).not.toBeInstanceOf(InternalError);
      expect(err.status).toBe(502);
      // A 502 by status, and still not retryable: the SDK decides by type.
      expect(isRetryable(err)).toBe(false);
      expect(err.extensions).toMatchObject({
        key_rejected: true,
        key_source: 'header',
        key_rejected_reason: 'invalid_or_unauthorized',
      });
      expect(JSON.stringify(err.extensions) + err.message).not.toContain(OWN_KEY);
      expect(messagesSent()).toBe(1);
    },
  );

  it('a rejection of the included AI’s key stays InternalError: retryable, and with nothing that says the customer has a key to fix', async () => {
    const { sdk } = await start({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 },
      agentDecomposer: plannerTheProviderRefuses(401),
    });
    const session = await sdk.agentSessions.create({ token_budget: 10_000 });

    const err = await refusalOf(sdk.agentSessions.message(session.id, TASK));

    expect(err).toBeInstanceOf(InternalError);
    expect(err).not.toBeInstanceOf(ByokAnthropicRequiredError);
    expect(isRetryable(err)).toBe(true);
    expect(err.extensions).not.toHaveProperty('key_rejected');
  });

  it.each([
    'team_manual',
    'agency_manual',
    'api_starter',
  ] as const satisfies readonly AccountTier[])(
    'CRITICAL no key on the %s plan reaches a program as ByokAnthropicRequiredError, not as the opt-in error for a setting that plan is refused',
    async (tier) => {
      const { sdk } = await start({
        tier,
        enableAgentRuntime: true,
        agentDecomposerKind: 'claude',
        enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
      });
      const session = await sdk.agentSessions.create({ token_budget: 10_000 });

      const err = await refusalOf(sdk.agentSessions.message(session.id, TASK));

      expect(err).toBeInstanceOf(ByokAnthropicRequiredError);
      expect(err).not.toBeInstanceOf(BundledLlmConsentRequiredError);
      expect(isRetryable(err)).toBe(false);
      // The no-key case of the type: nothing was rejected, because nothing was sent.
      expect(err.extensions).not.toHaveProperty('key_rejected');
    },
  );

  it('a plan that MAY opt in still reaches a program as BundledLlmConsentRequiredError, exactly as before', async () => {
    const { sdk } = await start({
      tier: 'api_builder',
      enableAgentRuntime: true,
      agentDecomposerKind: 'claude',
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
    });
    const session = await sdk.agentSessions.create({ token_budget: 10_000 });

    const err = await refusalOf(sdk.agentSessions.message(session.id, TASK));

    expect(err).toBeInstanceOf(BundledLlmConsentRequiredError);
    expect(err.status).toBe(402);
    expect(isRetryable(err)).toBe(false);
  });

  it('a message to a session that has ended reaches a program as ConflictError with sessionStatus "closed", and the reason beside it', async () => {
    const { sdk } = await start({ enableAgentRuntime: true });
    const session = await sdk.agentSessions.create({ token_budget: 10_000 });
    await sdk.agentSessions.close(session.id);

    const err = await refusalOf(
      sdk.agentSessions.message(session.id, TASK, { byokApiKey: OWN_KEY }),
    );

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).sessionStatus).toBe('closed');
    expect((err as ConflictError).turnInProgress).toBe(false);
    expect(typeof err.extensions['closed_reason']).toBe('string');
    expect(isRetryable(err)).toBe(false);
  });

  it('a stop that could not be confirmed is still FeatureUnavailableError, and the flag that says "call stop again" is on its extensions', async () => {
    const { sdk } = await start({ enableAgentRuntime: true });
    const session = await sdk.agentSessions.create({});
    vi.spyOn(AgentRuntime.prototype, 'requestTurnStop').mockRejectedValue(
      new Error('could not be asked in time'),
    );

    const err = await refusalOf(sdk.agentSessions.stop(session.id));

    expect(err).toBeInstanceOf(FeatureUnavailableError);
    expect(err.status).toBe(503);
    expect(err.extensions['stop_unconfirmed']).toBe(true);
    // The class alone says "not retryable", which is why the flag exists.
    expect(isRetryable(err)).toBe(false);
  });
});
