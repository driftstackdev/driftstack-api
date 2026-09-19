// A program must be able to run an AI task from start to finish with this SDK:
// create a session (with its own Anthropic key if it has one), send a task,
// watch it progress, read the answer and why it stopped, approve an action the
// agent paused on, and tell the AI-specific refusals apart. Each arm drives the
// real HttpClient through a fake fetch, so the wire shape and the typed error
// mapping are both exercised.

import { describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { HttpClient } from '../../src/http.js';
import {
  AgentSessionsResource,
  type AgentIntentResult,
  type AgentMessageResponse,
} from '../../src/resources/agent-sessions.js';
import { ConflictError, errorFromProblem, ForbiddenError } from '../../src/errors.js';

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function resourceWith(respond: () => Response): {
  sessions: AgentSessionsResource;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init });
    return Promise.resolve(respond());
  });
  const http = new HttpClient({
    apiKey: 'ds_live_test',
    baseUrl: 'http://api.test',
    fetch: fetchImpl,
    retry: { maxAttempts: 0 },
  });
  return { sessions: new AgentSessionsResource(http), calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const terminal = (status: number, body: unknown): string => frame('response', { status, body });

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

function bodyOf(c: Captured | undefined): unknown {
  const body = c?.init?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body) as unknown;
}

function headersOf(c: Captured | undefined): Record<string, string> {
  return (c?.init?.headers ?? {}) as Record<string, string>;
}

describe('a program can run an AI task end to end', () => {
  it('create sends your own Anthropic key as the x-byok-anthropic-api-key header beside the Idempotency-Key, so an Opus session can be created without a stored key', async () => {
    const { sessions, calls } = resourceWith(() => jsonResponse(201, SESSION));
    await sessions.create(
      { mode: 'ai', model: 'claude-opus-5', token_budget: 50_000 },
      { idempotencyKey: 'create-1', byokApiKey: 'sk-ant-test' },
    );
    const h = headersOf(calls[0]);
    expect(h['x-byok-anthropic-api-key']).toBe('sk-ant-test');
    expect(h['Idempotency-Key']).toBe('create-1');
    expect(bodyOf(calls[0])).toEqual({
      mode: 'ai',
      model: 'claude-opus-5',
      token_budget: 50_000,
    });
  });

  it('create sends no key header for an empty byokApiKey, and none when only the idempotency key is given', async () => {
    const { sessions, calls } = resourceWith(() => jsonResponse(201, SESSION));
    await sessions.create({}, { byokApiKey: '' });
    await sessions.create({}, { idempotencyKey: 'create-2' });
    expect(headersOf(calls[0])['x-byok-anthropic-api-key']).toBeUndefined();
    expect(headersOf(calls[1])['x-byok-anthropic-api-key']).toBeUndefined();
    expect(headersOf(calls[1])['Idempotency-Key']).toBe('create-2');
  });

  it('create forwards skip_proxy_probe, continue_from_agent_session_id and stop_on_exit_ip_change as sent', async () => {
    const { sessions, calls } = resourceWith(() => jsonResponse(201, SESSION));
    await sessions.create({
      proxy_id: '00000000-0000-4000-8000-000000000001',
      skip_proxy_probe: true,
      continue_from_agent_session_id: 'agt_0',
      stop_on_exit_ip_change: true,
    });
    expect(bodyOf(calls[0])).toEqual({
      proxy_id: '00000000-0000-4000-8000-000000000001',
      skip_proxy_probe: true,
      continue_from_agent_session_id: 'agt_0',
      stop_on_exit_ip_change: true,
    });
  });

  it('message reports every progress event in stream order — steps to onStep, every other name (known or not) to onEvent — and resolves with the answer and the notice', async () => {
    const result: AgentIntentResult = {
      kind: 'success',
      intent: { kind: 'navigate', url: 'https://example.com' },
      summary: 'Opened example.com',
    };
    const body = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [result.intent],
      results: [result],
      ok: true,
      answer: 'Example Domain',
      notice: 'I did the steps above, but this was taking too long for one message.',
    };
    const { sessions } = resourceWith(() =>
      streamResponse([
        ': stream open\n\n',
        frame('phase', { phase: 'planning' }),
        frame('plan', { total: 1, intents: [result.intent], labels: ['Open example.com'] }),
        frame('step_start', { index: 0, total: 1, label: 'Open example.com' }),
        frame('step', { index: 0, result }),
        frame('a_future_event', { anything: true }),
        frame('answer', { answer: 'Example Domain' }),
        frame('notice', { notice: body.notice }),
        terminal(200, body),
      ]),
    );
    const seen: string[] = [];
    const out = await sessions.message('agt_1', 'Open example.com and tell me the heading', {
      onStep: (step) => seen.push(`step:${String(step.index)}:${step.result.kind}`),
      onEvent: (event) => seen.push(event.type),
    });
    expect(seen).toEqual([
      'phase',
      'plan',
      'step_start',
      'step:0:success',
      'a_future_event',
      'answer',
      'notice',
    ]);
    expect(out.kind).toBe('plan-executed');
    if (out.kind !== 'plan-executed') return;
    expect(out.answer).toBe('Example Domain');
    expect(out.notice).toBe(body.notice);
  });

  it('a confirmation_required result can be passed straight back as the approval: the SDK sends its category and matchedText as the wire snake_case matched_text', async () => {
    const paused = {
      kind: 'confirmation_required',
      intent: { kind: 'interact', action: 'tap', selector: '#pay' },
      category: 'payment',
      matchedText: 'Pay now',
    } as const;
    const { sessions, calls } = resourceWith(() =>
      streamResponse([terminal(200, { kind: 'plan-executed', ok: true })]),
    );
    await sessions.message('agt_1', 'Pay the invoice', {
      idempotencyKey: 'turn-2',
      approveConsequentialActions: [paused],
    });
    expect(bodyOf(calls[0])).toEqual({
      user_message: 'Pay the invoice',
      approve_consequential_actions: [{ category: 'payment', matched_text: 'Pay now' }],
    });
    expect(headersOf(calls[0])['Idempotency-Key']).toBe('turn-2');
  });

  it('a category newer than this SDK still type-checks as an approval, because ConsequentialActionCategory is open', () => {
    const fromANewerServer: Extract<AgentIntentResult, { kind: 'confirmation_required' }> = {
      kind: 'confirmation_required',
      intent: { kind: 'interact', action: 'tap' },
      category: 'subscription_cancellation',
      matchedText: 'Cancel plan',
    };
    expect(fromANewerServer.category).toBe('subscription_cancellation');
  });

  it('a turn refused because another message is still running arrives inside the stream as a ConflictError with turnInProgress', async () => {
    const { sessions } = resourceWith(() =>
      streamResponse([
        ': stream open\n\n',
        terminal(409, {
          type: PROBLEM_TYPES.Conflict,
          title: 'Conflict',
          status: 409,
          detail: 'This agent session is still working on a previous request.',
          turn_in_progress: true,
        }),
      ]),
    );
    const err = await sessions.message('agt_1', 'hi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).turnInProgress).toBe(true);
    expect((err as ConflictError).sessionStatus).toBeUndefined();
  });

  it('a turn that ended the session (its budget ran out) arrives as a ConflictError carrying sessionStatus, the tokens spent, usage and the steps that ran', async () => {
    const ran: AgentIntentResult = {
      kind: 'success',
      intent: { kind: 'navigate', url: 'https://example.com' },
      summary: 'Opened example.com',
    };
    const { sessions } = resourceWith(() =>
      streamResponse([
        terminal(409, {
          type: PROBLEM_TYPES.Conflict,
          title: 'Conflict',
          status: 409,
          session_status: 'closed',
          tokens_consumed: 1234,
          usage: { decomposer_kind: 'claude', cost_usd_cents: 3, model: 'claude-sonnet-5' },
          partial_results: [ran],
        }),
      ]),
    );
    const err = (await sessions.message('agt_1', 'go').catch((e: unknown) => e)) as ConflictError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.sessionStatus).toBe('closed');
    expect(err.turnInProgress).toBe(false);
    expect(err.tokensConsumed).toBe(1234);
    expect(err.usage?.cost_usd_cents).toBe(3);
    expect(err.partialResults).toEqual([ran]);
  });

  it('an Opus model on the included AI arrives as a ForbiddenError with requiresOwnKey and the refused model', async () => {
    const { sessions } = resourceWith(() =>
      jsonResponse(403, {
        type: PROBLEM_TYPES.Forbidden,
        title: 'Forbidden',
        status: 403,
        requires_own_key: true,
        model: 'claude-opus-5',
      }),
    );
    const err = (await sessions
      .create({ model: 'claude-opus-5' })
      .catch((e: unknown) => e)) as ForbiddenError;
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.requiresOwnKey).toBe(true);
    expect(err.model).toBe('claude-opus-5');
  });

  it('CONTROL an ordinary 403 (a missing scope) is not mistaken for the own-key refusal', () => {
    const err = errorFromProblem(
      { type: PROBLEM_TYPES.Forbidden, title: 'Forbidden', status: 403, detail: 'scope' },
      null,
    ) as ForbiddenError;
    expect(err.requiresOwnKey).toBe(false);
    expect(err.model).toBeUndefined();
  });

  it('the Idempotency-Key and AI-control conflicts are told apart by idempotencyStatus, aiControlUnavailable and phase; a malformed field reads as absent instead of throwing', () => {
    const inProgress = errorFromProblem(
      {
        type: PROBLEM_TYPES.Conflict,
        title: 'Conflict',
        status: 409,
        idempotency_status: 'in_progress',
      },
      null,
    ) as ConflictError;
    expect(inProgress.idempotencyStatus).toBe('in_progress');
    expect(inProgress.aiControlUnavailable).toBe(false);

    const control = errorFromProblem(
      {
        type: PROBLEM_TYPES.Conflict,
        title: 'Conflict',
        status: 409,
        ai_control_unavailable: true,
        phase: 'executing',
        tokens_consumed: '12',
        usage: 'not an object',
        partial_results: {},
      },
      null,
    ) as ConflictError;
    expect(control.aiControlUnavailable).toBe(true);
    expect(control.phase).toBe('executing');
    expect(control.tokensConsumed).toBeUndefined();
    expect(control.usage).toBeUndefined();
    expect(control.partialResults).toBeUndefined();
  });

  it('every result kind a program branches on is in the response type, including notice on plan-executed', () => {
    const kinds: Array<AgentMessageResponse['kind']> = [
      'plan-executed',
      'clarify',
      'refuse',
      'stopped',
      'logged-manual',
    ];
    const withNotice: Extract<AgentMessageResponse, { kind: 'plan-executed' }> = {
      kind: 'plan-executed',
      session: SESSION as never,
      intents: [],
      results: [],
      ok: true,
      notice: 'Send “continue” and I will carry on from this page.',
    };
    expect(kinds).toHaveLength(5);
    expect(withNotice.notice).toContain('continue');
  });
});
