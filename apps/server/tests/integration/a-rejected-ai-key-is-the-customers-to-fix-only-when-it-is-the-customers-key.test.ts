// A rejected AI key is the customer's to fix only when it is the customer's key.
//
// A turn runs on one of two kinds of AI key: the customer's own (sent with the
// request, or stored on the account), or Driftstack's (the included AI). When
// the model provider refuses the key while the turn is planning, the two cases
// need opposite answers:
//
//   the customer's key  → a typed, NON-retryable problem every released SDK
//                         already knows (`byok-anthropic-required`), saying the
//                         key was rejected and how to check it. It used to be a
//                         500 `internal`, which every SDK treats as worth
//                         retrying, for a turn that can never succeed.
//   Driftstack's key    → our fault. It stays a 5xx, is reported to error
//                         tracking, and never tells the customer to fix a key
//                         they do not have.
//
// Neither answer may carry the key, or the provider's own words.
//
// The planner is scripted to fail the way the production one does: a plain
// Error whose message is `Anthropic API <status>: <the provider's body>`.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import type { SentryClient } from '../../src/lib/sentry.js';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWN_KEY = 'sk-ant-api03-rejected-key-aaaaaaaaaaaaaaaaaaaaaaaa';
/** Driftstack's key in this fixture: the stub tests/integration/_helpers/build-test-app.ts wires. */
const DEPLOYMENT_KEY = 'sk-ant-test-deployment-fallback';
const TASK = 'open https://example.com/private-report and capture it';
/** What the provider says. None of it may reach the customer. */
const PROVIDER_BODY =
  '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key PROVIDER-RAW-WORDS"}}';

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  key_rejected?: boolean;
  key_source?: string;
  key_rejected_reason?: string;
}

/** Fails the first `failures` planning calls with the provider's answer, then plans. */
function plannerTheProviderRefuses(status: number, failures = Infinity): AgentDecomposer {
  let calls = 0;
  return {
    decompose: (_args: DecomposeArgs): Promise<DecomposeResult> => {
      calls += 1;
      if (calls <= failures) {
        return Promise.reject(new Error(`Anthropic API ${status.toString()}: ${PROVIDER_BODY}`));
      }
      return Promise.resolve({
        kind: 'plan',
        intents: [{ kind: 'navigate', url: 'https://example.com/' }],
        tokensConsumed: 10,
      });
    },
  };
}

function recordingSentry(): {
  client: SentryClient;
  exceptions: Array<{ err: unknown; context: Record<string, unknown> | undefined }>;
} {
  const exceptions: Array<{ err: unknown; context: Record<string, unknown> | undefined }> = [];
  return {
    exceptions,
    client: {
      isInitialized: true,
      captureException: (err, context) => {
        exceptions.push({ err, context });
      },
      captureMessage: () => {},
      addBreadcrumb: () => {},
      flush: () => Promise.resolve(true),
      close: () => Promise.resolve(true),
    },
  };
}

/** Everything an error carries that a reader of error tracking would see. */
function everythingIn(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message, current.stack ?? '');
      parts.push(JSON.stringify(current, Object.getOwnPropertyNames(current)));
      current = current.cause;
    } else {
      parts.push(JSON.stringify(current));
      break;
    }
  }
  return parts.join('\n');
}

describe('a rejected AI key is the customer’s to fix only when it is the customer’s key', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  const create = async (): Promise<string> => {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 10_000 },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  };

  const message = (id: string, headers: Record<string, string> = {}) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: TASK },
    });

  const expectNothingLeaked = (raw: string): void => {
    expect(raw).not.toContain(OWN_KEY);
    expect(raw).not.toContain(DEPLOYMENT_KEY);
    expect(raw).not.toContain('PROVIDER-RAW-WORDS');
    expect(raw).not.toContain('authentication_error');
    expect(raw).not.toContain('x-api-key PROVIDER');
  };

  it.each([401, 403])(
    'a key sent with the request that the provider answers %i is a 502 byok-anthropic-required saying the key was rejected and how to check one, never a 500',
    async (providerStatus) => {
      fx = await buildTestApp({
        enableAgentRuntime: true,
        agentDecomposer: plannerTheProviderRefuses(providerStatus),
      });
      const id = await create();
      const res = await message(id, { 'x-byok-anthropic-api-key': OWN_KEY });

      expect(res.statusCode).toBe(502);
      const body = res.json<Problem>();
      expect(body.type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);
      expect(body.key_rejected).toBe(true);
      expect(body.key_source).toBe('header');
      expect(body.key_rejected_reason).toBe('invalid_or_unauthorized');
      expect(body.detail).toMatch(/rejected/i);
      expect(body.detail).toContain('x-byok-anthropic-api-key');
      expect(body.detail).toContain('POST /v1/account/me/byok-anthropic-key/test');
      expectNothingLeaked(res.body);
    },
  );

  it('a key whose provider account cannot pay (402) says so, and does not send the customer to a key test that would pass', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: plannerTheProviderRefuses(402),
    });
    const id = await create();
    const res = await message(id, { 'x-byok-anthropic-api-key': OWN_KEY });

    expect(res.statusCode).toBe(502);
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);
    expect(body.key_rejected).toBe(true);
    expect(body.key_rejected_reason).toBe('billing');
    expect(body.detail).toMatch(/billing|credit|pay/i);
    expect(body.detail).not.toContain('/byok-anthropic-key/test');
    expectNothingLeaked(res.body);
  });

  it('a STORED key the provider rejects gets the same typed answer, pointing at the key test and at replacing the key', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableByokAnthropic: true,
      agentDecomposer: plannerTheProviderRefuses(401),
    });
    const put = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: OWN_KEY },
    });
    expect(put.statusCode).toBe(200);
    const id = await create();
    const res = await message(id);

    expect(res.statusCode).toBe(502);
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);
    expect(body.key_rejected).toBe(true);
    expect(body.key_source).toBe('stored');
    expect(body.detail).toContain('POST /v1/account/me/byok-anthropic-key/test');
    expect(body.detail).toContain('PUT /v1/account/me/byok-anthropic-key');
    expectNothingLeaked(res.body);
  });

  it('the streamed turn carries the same typed problem in its one response frame', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: plannerTheProviderRefuses(401),
    });
    const id = await create();
    const res = await message(id, {
      'x-byok-anthropic-api-key': OWN_KEY,
      accept: 'text/event-stream',
    });
    expect(res.statusCode).toBe(200);
    const frame = /event: response\ndata: (.+)\n\n$/.exec(res.body)?.[1];
    expect(frame).toBeDefined();
    const terminal = JSON.parse(frame ?? '{}') as { status: number; body: Problem };
    expect(terminal.status).toBe(502);
    expect(terminal.body.type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);
    expect(terminal.body.key_rejected).toBe(true);
    expectNothingLeaked(res.body);
  });

  it('the session stays open after a rejected key, and the same session runs the next message once the key works', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: plannerTheProviderRefuses(401, 1),
    });
    const id = await create();
    const rejected = await message(id, { 'x-byok-anthropic-api-key': OWN_KEY });
    expect(rejected.statusCode).toBe(502);

    const session = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(session.json<{ status: string }>().status).toBe('active');

    const next = await message(id, { 'x-byok-anthropic-api-key': `${OWN_KEY}-replaced` });
    expect(next.statusCode).toBe(200);
    expect(next.json<{ kind: string }>().kind).toBe('plan-executed');
  });

  it('CRITICAL a rejection of DRIFTSTACK’S key (the included AI) stays a 5xx, never tells the customer to fix a key, and is reported to error tracking without the customer’s message or the provider’s words', async () => {
    const sentry = recordingSentry();
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 },
      agentDecomposer: plannerTheProviderRefuses(401),
      sentry: sentry.client,
    });
    const id = await create();
    const res = await message(id);

    expect(res.statusCode).toBe(500);
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.Internal);
    expect(body).not.toHaveProperty('key_rejected');
    expect(body.detail).not.toMatch(/\bkey\b/i);
    expect(body.detail).not.toMatch(/byok/i);
    expect(body.detail).toMatch(/our side/i);
    expectNothingLeaked(res.body);

    expect(sentry.exceptions).toHaveLength(1);
    const reported = everythingIn(sentry.exceptions[0]?.err);
    expect(reported).toMatch(/provider rejected/i);
    expect(reported).not.toContain(TASK);
    expect(reported).not.toContain('private-report');
    expect(reported).not.toContain('PROVIDER-RAW-WORDS');
    expect(reported).not.toContain(DEPLOYMENT_KEY);
    // The report names the request (its id, method and route) and nothing the
    // customer wrote or sent.
    const context = sentry.exceptions[0]?.context ?? {};
    for (const key of Object.keys(context)) {
      expect(['method', 'request_id', 'route', 'url']).toContain(key);
    }
    expect(JSON.stringify(context)).not.toContain('private-report');
    expect(JSON.stringify(context)).not.toContain(DEPLOYMENT_KEY);
  });

  it('a rejection of the staging fallback key is ours too: 5xx, and no word about the customer’s key', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposerKind: 'claude',
      allowDeploymentKeyFallback: true,
      agentDecomposer: plannerTheProviderRefuses(403),
    });
    const id = await create();
    const res = await message(id);
    expect(res.statusCode).toBe(500);
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.Internal);
    expect(body).not.toHaveProperty('key_rejected');
    expect(body.detail).not.toMatch(/\bkey\b/i);
  });

  it('a provider error that is NOT about the key is unchanged: a malformed-request 400 is still a 500 internal with the generic detail', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: plannerTheProviderRefuses(400),
    });
    const id = await create();
    const res = await message(id, { 'x-byok-anthropic-api-key': OWN_KEY });
    expect(res.statusCode).toBe(500);
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.Internal);
    expect(body.detail).toBe('An unexpected error occurred.');
    expect(body).not.toHaveProperty('key_rejected');
    expectNothingLeaked(res.body);
  });
});
