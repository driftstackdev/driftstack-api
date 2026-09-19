// A provider that refuses the KEY is told apart from every other failure.
//
// When a planning call fails, the turn has three different things it can do:
//
//   the provider is briefly unavailable → a 200 refuse; send it again
//   the provider refused the KEY        → its own error; the route answers by
//                                         whose key it was
//   anything else                       → re-thrown; a generic 500
//
// The middle one used to be the third: a rejected key surfaced as a 500, which
// SDKs treat as worth retrying. This pins how the three are told apart, and that
// the error which carries a key rejection onward holds a status and a key SOURCE
// — never the key, and never the provider's words.

import { describe, expect, it } from 'vitest';
import { StubAgentExecutor } from '../../src/services/agent-executor.js';
import {
  AgentProviderKeyRejectedError,
  AgentRuntime,
  classifyDecomposerError,
  providerKeyRejection,
} from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';

const PROVIDER_WORDS =
  '{"type":"error","error":{"message":"invalid x-api-key PROVIDER-RAW-WORDS"}}';
const providerError = (status: number): Error =>
  new Error(`Anthropic API ${status.toString()}: ${PROVIDER_WORDS}`);

describe('a provider that refuses the key is told apart from every other failure', () => {
  it('401 and 403 are a key that is invalid, revoked or not permitted; 402 is an account that cannot pay', () => {
    expect(providerKeyRejection(providerError(401))).toEqual({
      providerStatus: 401,
      reason: 'invalid_or_unauthorized',
    });
    expect(providerKeyRejection(providerError(403))).toEqual({
      providerStatus: 403,
      reason: 'invalid_or_unauthorized',
    });
    expect(providerKeyRejection(providerError(402))).toEqual({
      providerStatus: 402,
      reason: 'billing',
    });
  });

  it('nothing else is a key rejection: a malformed request, a missing model, throttling, an outage, a dropped connection, or a throw that is not an Error', () => {
    for (const status of [400, 404, 408, 413, 429, 500, 503, 529]) {
      expect(providerKeyRejection(providerError(status)), status.toString()).toBeNull();
    }
    expect(providerKeyRejection(new Error('fetch failed'))).toBeNull();
    expect(providerKeyRejection(new Error('4010 things went wrong'))).toBeNull();
    expect(providerKeyRejection(new Error('Anthropic API 4011: not a status'))).toBeNull();
    expect(providerKeyRejection('Anthropic API 401')).toBeNull();
    expect(providerKeyRejection(undefined)).toBeNull();
  });

  it('only the status at the HEAD of the provider lane’s message counts: a different failure whose body merely quotes a 401 is not a rejected key, so a customer is never told to replace a key over somebody else’s words', () => {
    // The lane writes `Anthropic API <status>: <first 300 characters of the body>`.
    // The status is ours; the body is whatever the provider (or anything between
    // us and it) sent back. A 5xx page or a 400 that mentions another status must
    // keep its own reading: briefly unavailable, or a generic failure.
    const outageQuotingA401 = new Error(
      'Anthropic API 529: {"error":{"message":"overloaded; upstream said Anthropic API 401"}}',
    );
    expect(providerKeyRejection(outageQuotingA401)).toBeNull();
    expect(classifyDecomposerError(outageQuotingA401)).toBe('transient');
    const badRequestQuotingA403 = new Error(
      'Anthropic API 400: {"error":{"message":"see Anthropic API 403 in the reference"}}',
    );
    expect(providerKeyRejection(badRequestQuotingA403)).toBeNull();
    expect(
      providerKeyRejection(new Error('planner failed: Anthropic API 402: no credit')),
    ).toBeNull();
  });

  it('the two readings of a failed planning call agree: a key rejection is never also "briefly unavailable", so it can never be offered as "send it again"', () => {
    for (const status of [401, 402, 403]) {
      expect(classifyDecomposerError(providerError(status))).toBe('fatal');
    }
    for (const status of [429, 500, 529]) {
      expect(classifyDecomposerError(providerError(status))).toBe('transient');
      expect(providerKeyRejection(providerError(status))).toBeNull();
    }
  });

  it.each([
    ['header', 401],
    ['cached', 403],
    ['bundled', 402],
  ] as const)(
    'CRITICAL a turn whose planning call the provider refuses for the key (source %s, status %i) throws the key-rejection error, carrying the source and the status and none of the provider’s words or the key',
    async (keySource, status) => {
      const sessions = new InMemoryAgentSessionsRepo();
      const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
      const runtime = new AgentRuntime({
        decomposer: { decompose: () => Promise.reject(providerError(status)) },
        executor: new StubAgentExecutor(),
        sessions,
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      const KEY = 'sk-ant-api03-never-in-an-error-aaaaaaaaaaaaaaaa';

      const thrown: unknown = await runtime
        .runTurn({
          agentSessionId: seed.id,
          userMessage: 'open https://example.com/private-report',
          byokApiKey: KEY,
          keySource,
        })
        .catch((err: unknown) => err);

      expect(thrown).toBeInstanceOf(AgentProviderKeyRejectedError);
      const rejection = thrown as AgentProviderKeyRejectedError;
      expect(rejection.keySource).toBe(keySource);
      expect(rejection.providerStatus).toBe(status);
      const everything = `${rejection.message}\n${rejection.stack ?? ''}\n${JSON.stringify(
        rejection,
        Object.getOwnPropertyNames(rejection),
      )}`;
      expect(everything).not.toContain('PROVIDER-RAW-WORDS');
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain('private-report');
      expect(rejection.cause).toBeUndefined();
      // The session is untouched by it: still active, ready for the next message.
      expect((await sessions.get(seed.id))?.status).toBe('active');
    },
  );

  it('a failure that is not about the key is re-thrown as it was, so its handling is unchanged', async () => {
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const original = providerError(400);
    const runtime = new AgentRuntime({
      decomposer: { decompose: () => Promise.reject(original) },
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    await expect(
      runtime.runTurn({ agentSessionId: seed.id, userMessage: 'open https://example.com' }),
    ).rejects.toBe(original);
  });
});
