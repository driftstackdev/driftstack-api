// An AI refusal carries what a program needs to react to it, as typed fields.
//
// The API says which refusal this is in fields beside the sentence: why a closed
// session ended, that a stop could not be confirmed, that the customer's own key
// was the problem and how, how long to wait when too many AI turns are running.
// A program should branch on those fields, never on the wording. Each arm sends
// the answer the API gives through the real HttpClient, streamed the way
// message() receives it, and reads the field off the error class a program
// catches.

import { describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { HttpClient } from '../../src/http.js';
import {
  AgentSessionsResource,
  type AgentMessageResponse,
} from '../../src/resources/agent-sessions.js';
import {
  ByokAnthropicRequiredError,
  ConcurrencyLimitError,
  ConflictError,
  FeatureUnavailableError,
  isRetryable,
  RateLimitError,
} from '../../src/errors.js';

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };

function resourceWith(respond: () => Response): {
  sessions: AgentSessionsResource;
  requests: () => number;
} {
  const fetchImpl = vi.fn(() => Promise.resolve(respond()));
  const http = new HttpClient({
    apiKey: 'ds_live_test',
    baseUrl: 'http://api.test',
    fetch: fetchImpl,
    // Retries ON, so "message() made one request" below is a fact about
    // message(), not about this fixture.
    retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
  });
  return { sessions: new AgentSessionsResource(http), requests: () => fetchImpl.mock.calls.length };
}

/** The one terminal frame a turn's stream ends with: `{ status, body }`. */
function streamed(status: number, body: unknown): Response {
  return new Response(`event: response\ndata: ${JSON.stringify({ status, body })}\n\n`, {
    status: 200,
    headers: SSE_HEADERS,
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

const SESSION = {
  id: 'agt_1',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  token_budget_total: 100_000,
  token_budget_remaining: 99_000,
  transcript_length: 2,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-sonnet-5',
  stop_on_exit_ip_change: false,
  pair_mode_state: null,
  created_at: '2026-09-19T00:00:00Z',
  updated_at: '2026-09-19T00:00:00Z',
};

describe('an AI refusal carries what a program needs to react to it', () => {
  it('a question that could not be answered says why in answer_unavailable, a typed field of the finished turn, and carries no answer', async () => {
    const body: AgentMessageResponse = {
      kind: 'plan-executed',
      session: SESSION as AgentMessageResponse['session'],
      intents: [{ kind: 'navigate', url: 'https://example.test/' }],
      results: [
        {
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://example.test/' },
          summary: '',
        },
      ],
      ok: true,
      answer_unavailable: 'The page could not be read back, so there is no answer to give.',
    };
    const { sessions } = resourceWith(() => streamed(200, body));
    const turn = await sessions.message('agt_1', 'What is the total?');
    if (turn.kind !== 'plan-executed') throw new Error('expected a finished turn');
    // Read through the TYPE, with no cast: this line fails to compile if the
    // field leaves the plan-executed variant.
    const why: string | undefined = turn.answer_unavailable;
    expect(why).toBe('The page could not be read back, so there is no answer to give.');
    expect(turn.answer).toBeUndefined();
  });

  it('a message to a closed session is a ConflictError whose sessionStatus is closed and whose closedReason says why, so no second call is needed', async () => {
    const { sessions, requests } = resourceWith(() =>
      streamed(409, {
        type: PROBLEM_TYPES.Conflict,
        title: 'Conflict',
        status: 409,
        detail: 'Agent session is closed. Start a new agent session.',
        session_status: 'closed',
        closed_reason: 'budget-exhausted',
      }),
    );
    const err = await sessions.message('agt_1', 'hello').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    const conflict = err as ConflictError;
    expect(conflict.sessionStatus).toBe('closed');
    expect(conflict.closedReason).toBe('budget-exhausted');
    expect(conflict.turnInProgress).toBe(false);
    expect(isRetryable(conflict)).toBe(false);
    expect(requests()).toBe(1);
  });

  it('a paused session has a sessionStatus and no closedReason; a busy session has neither, and says turnInProgress instead', async () => {
    const paused = resourceWith(() =>
      streamed(409, {
        type: PROBLEM_TYPES.Conflict,
        title: 'Conflict',
        status: 409,
        session_status: 'paused',
      }),
    );
    const p = (await paused.sessions
      .message('agt_1', 'x')
      .catch((e: unknown) => e)) as ConflictError;
    expect(p.sessionStatus).toBe('paused');
    expect(p.closedReason).toBeUndefined();

    const busy = resourceWith(() =>
      streamed(409, {
        type: PROBLEM_TYPES.Conflict,
        title: 'Conflict',
        status: 409,
        turn_in_progress: true,
      }),
    );
    const b = (await busy.sessions.message('agt_1', 'x').catch((e: unknown) => e)) as ConflictError;
    expect(b.turnInProgress).toBe(true);
    expect(b.sessionStatus).toBeUndefined();
    expect(b.closedReason).toBeUndefined();
  });

  it('a closed_reason that is not a string is ignored rather than passed on as one', async () => {
    const { sessions } = resourceWith(() =>
      streamed(409, {
        type: PROBLEM_TYPES.Conflict,
        title: 'Conflict',
        status: 409,
        session_status: 'closed',
        closed_reason: { nested: true },
      }),
    );
    const err = (await sessions.message('agt_1', 'x').catch((e: unknown) => e)) as ConflictError;
    expect(err.closedReason).toBeUndefined();
  });

  it('too many AI turns running is a RateLimitError worth retrying, with the wait read from the streamed body because a stream has no Retry-After header left to carry it — and message() itself sends exactly one request', async () => {
    const { sessions, requests } = resourceWith(() =>
      streamed(429, {
        type: PROBLEM_TYPES.RateLimited,
        title: 'Too Many Requests',
        status: 429,
        detail:
          'Your account already has 3 AI turns running on Driftstack’s included AI (limit 3). Wait for one to finish, then try again.',
        retry_after_seconds: 1,
      }),
    );
    const err = await sessions
      .message('agt_1', 'hello', { idempotencyKey: 'turn-1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(ConcurrencyLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(1);
    expect(isRetryable(err)).toBe(true);
    // "Retryable" is advice to the caller's loop. The SDK never resends a turn.
    expect(requests()).toBe(1);
  });

  it('a stop that could not be confirmed says stopUnconfirmed, which is what tells it from AI not being enabled: the same class, the same status, and only one of them worth calling again', async () => {
    const unconfirmed = resourceWith(() =>
      json(503, {
        type: PROBLEM_TYPES.FeatureUnavailable,
        title: 'Feature unavailable',
        status: 503,
        detail: 'We could not confirm the stop just now. Try again in a moment.',
        stop_unconfirmed: true,
      }),
    );
    const u = await unconfirmed.sessions.stop('agt_1').catch((e: unknown) => e);
    expect(u).toBeInstanceOf(FeatureUnavailableError);
    expect((u as FeatureUnavailableError).stopUnconfirmed).toBe(true);
    // stop() is a POST without a key: the SDK does not retry it by itself.
    expect(unconfirmed.requests()).toBe(1);

    const notEnabled = resourceWith(() =>
      json(503, {
        type: PROBLEM_TYPES.FeatureUnavailable,
        title: 'Feature unavailable',
        status: 503,
        detail: 'AI chat is not enabled.',
      }),
    );
    const n = await notEnabled.sessions.stop('agt_1').catch((e: unknown) => e);
    expect(n).toBeInstanceOf(FeatureUnavailableError);
    expect((n as FeatureUnavailableError).stopUnconfirmed).toBe(false);
    expect(isRetryable(n)).toBe(false);
  });

  it('a rejected own key is a ByokAnthropicRequiredError that says which key and why, is not worth retrying although it is a 502, and never carries the key', async () => {
    const key = 'sk-ant-api03-this-must-never-come-back';
    const { sessions, requests } = resourceWith(() =>
      streamed(502, {
        type: PROBLEM_TYPES.ByokAnthropicRequired,
        title: 'BYOK Anthropic key required',
        status: 502,
        detail:
          'Anthropic rejected the API key sent with this request (the x-byok-anthropic-api-key header): it is invalid, revoked, or not permitted to run this model. No step was run.',
        key_rejected: true,
        key_source: 'header',
        key_rejected_reason: 'invalid_or_unauthorized',
      }),
    );
    const err = await sessions
      .message('agt_1', 'hello', { byokApiKey: key })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ByokAnthropicRequiredError);
    const rejected = err as ByokAnthropicRequiredError;
    expect(rejected.status).toBe(502);
    expect(rejected.keyRejected).toBe(true);
    expect(rejected.keySource).toBe('header');
    expect(rejected.keyRejectedReason).toBe('invalid_or_unauthorized');
    expect(isRetryable(rejected)).toBe(false);
    expect(requests()).toBe(1);
    expect(JSON.stringify({ ...rejected, message: rejected.message })).not.toContain(key);
  });

  it('a billing refusal reads billing, a reason newer than this SDK is kept as the string it is, and having no key at all is the same class with keyRejected false', async () => {
    const billing = resourceWith(() =>
      streamed(502, {
        type: PROBLEM_TYPES.ByokAnthropicRequired,
        title: 'BYOK Anthropic key required',
        status: 502,
        key_rejected: true,
        key_source: 'stored',
        key_rejected_reason: 'billing',
      }),
    );
    const b = (await billing.sessions
      .message('agt_1', 'x')
      .catch((e: unknown) => e)) as ByokAnthropicRequiredError;
    expect([b.keyRejected, b.keySource, b.keyRejectedReason]).toEqual([true, 'stored', 'billing']);

    const newer = resourceWith(() =>
      streamed(502, {
        type: PROBLEM_TYPES.ByokAnthropicRequired,
        title: 'BYOK Anthropic key required',
        status: 502,
        key_rejected: true,
        key_source: 'workspace',
        key_rejected_reason: 'a_reason_added_after_this_sdk_was_released',
      }),
    );
    const n = (await newer.sessions
      .message('agt_1', 'x')
      .catch((e: unknown) => e)) as ByokAnthropicRequiredError;
    expect([n.keySource, n.keyRejectedReason]).toEqual([
      'workspace',
      'a_reason_added_after_this_sdk_was_released',
    ]);

    const none = resourceWith(() =>
      streamed(502, {
        type: PROBLEM_TYPES.ByokAnthropicRequired,
        title: 'BYOK Anthropic key required',
        status: 502,
        detail: 'No Anthropic API key configured for this account.',
      }),
    );
    const k = (await none.sessions
      .message('agt_1', 'x')
      .catch((e: unknown) => e)) as ByokAnthropicRequiredError;
    expect(k).toBeInstanceOf(ByokAnthropicRequiredError);
    expect([k.keyRejected, k.keySource, k.keyRejectedReason]).toEqual([
      false,
      undefined,
      undefined,
    ]);
  });
});
