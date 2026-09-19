// A program can run an AI task end to end through the public API.
//
// This is the flow a customer's own code follows to have the AI do something on
// a website, driven the way that code drives it: through the published
// TypeScript SDK, over real HTTP, against the real routes and the real turn
// runtime. The SDK is imported by package name, so these are the built bytes a
// customer installs, and every request below is one the SDK assembled itself.
// That is the point of driving it this way: a test that hand-builds requests
// proves the server agrees with the test, not with the SDK.
//
// Two things are stood in for, because they would cost money or need a phone:
//
//   - the PLANNER (the model call) is the scripted planner below, so no model is
//     ever called and every turn is deterministic;
//   - the DEVICE is the stub executor every agent-session integration test
//     already uses, given the one ability the production device has and the
//     stub lacks: reading the page back. Without it the answer read-back cannot
//     run through the route at all, so no route-level test had ever seen an
//     `answer` come back.
//
// The stages run IN ORDER ON ONE SESSION, because that is what a program does
// and because two of the contracts only exist in sequence: an approval is only
// good as the very next message after the halt, and a clarifying answer is read
// against the question before it. Each stage depends on the ones above it.
//
// What each stage pins is something a program branches on:
//   1. a key with broad `read` + `write` (and no `account_owner`) can start an
//      AI session on a saved profile, and that profile then holds one live
//      session;
//   2. a task comes back `plan-executed` with a result per step and the
//      `answer` to the question it asked, and the stream reports the plan and
//      each step before the result arrives;
//   3. sending the same turn again with the same Idempotency-Key replays the
//      result without running the task a second time;
//   4. a purchase step halts as `confirmation_required` with `ok: false`, and
//      nothing after it runs;
//   5. re-sending the same message with `approve_consequential_actions` (the
//      result's `matchedText` sent as `matched_text`) runs the halted step and
//      the rest, without planning again;
//   6. a vague task comes back `clarify`, and the reply, sent as the next
//      message, continues the same task;
//   7. stop answers `stop_requested` while a turn runs, the turn ends as
//      `stopped`, and stop then answers `no_turn_running`;
//   8. close ends the session: it reads `closed`, a later message is refused
//      with a 409, and the profile is free for the next run.
//
// Two arms after the flow pin the edges of the same contracts: an approval that
// does NOT come straight after the halt is not used, and a key with only the
// per-resource session scopes cannot start an AI session.

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  ConflictError,
  Driftstack,
  ForbiddenError,
  ProfileInUseError,
  type AgentIntentResult,
  type AgentMessageResponse,
  type AgentSession,
} from '@driftstack/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentDecomposer,
  AgentIntent,
  AnswerArgs,
  AnswerResult,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type * as AgentExecutorModule from '../../src/services/agent-executor.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

// ── The device: the test app's stub executor, able to read the page back ─────

const device = vi.hoisted(() => ({
  /** What the page says after the invoice task has run. */
  pageText: 'Invoices · INV-0926 · September 2026 · Total due: $1,284.50',
  /** The session id of every page read, in order. */
  reads: [] as string[],
}));

vi.mock('../../src/services/agent-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentExecutorModule>();
  class StubAgentExecutorThatReadsThePage extends actual.StubAgentExecutor {
    observe(sessionId: string): Promise<string | null> {
      device.reads.push(sessionId);
      return Promise.resolve(device.pageText);
    }
  }
  return { ...actual, StubAgentExecutor: StubAgentExecutorThatReadsThePage };
});

// ── The planner: scripted, one plan per task, no model call ───────────────────

const TASK = {
  readInvoice:
    'Open https://portal.example.test/invoices and tell me the total of the latest invoice.',
  buyMug: 'Open https://shop.example.test/cart and buy the blue mug.',
  vague: 'Download my invoice.',
  reply: 'The one from September 2026.',
  longRunning: 'Open https://portal.example.test/reports and export every report as a PDF.',
} as const;

const QUESTION = 'Which invoice do you want: August 2026 or September 2026?';
const INVOICES_URL = 'https://portal.example.test/invoices';
const SEPTEMBER_URL = 'https://portal.example.test/invoices/2026-09';
const BUY_TAP: AgentIntent = {
  kind: 'interact',
  action: 'tap',
  selector: '#buy-now',
  value: 'Buy now',
};
const SCREENSHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

function plan(intents: AgentIntent[]): Promise<DecomposeResult> {
  return Promise.resolve({ kind: 'plan', intents, tokensConsumed: 50 });
}

class ScriptedPlanner implements AgentDecomposer {
  /** Every planning call, in order. A turn that plans nothing adds nothing here. */
  readonly calls: DecomposeArgs[] = [];
  /** Every answer read-back, in order. */
  readonly answerCalls: AnswerArgs[] = [];
  /** True while the long-running task is planning and waiting to be stopped. */
  waitingToBeStopped = false;

  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    this.calls.push(args);
    switch (args.task) {
      case TASK.readInvoice:
        return plan([{ kind: 'navigate', url: INVOICES_URL }, SCREENSHOT]);
      case TASK.buyMug:
        return plan([
          { kind: 'navigate', url: 'https://shop.example.test/cart' },
          BUY_TAP,
          SCREENSHOT,
        ]);
      case TASK.vague:
        return Promise.resolve({
          kind: 'clarify',
          clarifyingQuestion: QUESTION,
          tokensConsumed: 50,
        });
      case TASK.reply:
        // A reply only means something next to the question it answers. Planned
        // from the conversation, exactly as a model would read it; without the
        // question in the history it is refused, so a turn that lost the thread
        // cannot pass for one that kept it.
        return args.history.some((entry) => entry.body.includes(QUESTION))
          ? plan([
              { kind: 'navigate', url: SEPTEMBER_URL },
              { kind: 'capture', capture: 'pdf' },
            ])
          : Promise.resolve({
              kind: 'refuse',
              refuseReason: 'There is no earlier question this could be the answer to.',
              tokensConsumed: 50,
            });
      case TASK.longRunning:
        return this.planUntilStopped(args.signal);
      default:
        return Promise.resolve({
          kind: 'refuse',
          refuseReason: `This test has no plan scripted for: ${args.task}`,
          tokensConsumed: 0,
        });
    }
  }

  answerFromObservation(args: AnswerArgs): Promise<AnswerResult> {
    this.answerCalls.push(args);
    const total = /Total due: (\$[\d,.]+)/.exec(args.observation)?.[1];
    return Promise.resolve({
      answer:
        total !== undefined ? `The latest invoice totals ${total}.` : 'The page shows no total.',
      tokensConsumed: 0,
    });
  }

  /** Plans until the turn is stopped, then ends the way a cancelled model call does. */
  private planUntilStopped(signal: AbortSignal | undefined): Promise<DecomposeResult> {
    return new Promise<DecomposeResult>((_resolve, reject) => {
      if (signal === undefined) {
        reject(new Error('this task only ends when it is stopped, and the turn carried no signal'));
        return;
      }
      this.waitingToBeStopped = true;
      const end = (): void => {
        this.waitingToBeStopped = false;
        reject(new Error('aborted'));
      };
      if (signal.aborted) end();
      else signal.addEventListener('abort', end, { once: true });
    });
  }
}

// ── The wire: what the SDK sent and what came back, recorded as it happened ───

interface WireCall {
  method: string;
  path: string;
  status: number;
  contentType: string;
  idempotencyKey: string | null;
  /** Whether the own-key header was sent. The value itself is never recorded. */
  sentOwnKey: boolean;
  body: unknown;
}

function recordingFetch(log: WireCall[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    log.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      idempotencyKey: headers.get('idempotency-key'),
      sentOwnKey: headers.has('x-byok-anthropic-api-key'),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return response;
  };
}

// ── Fixture ───────────────────────────────────────────────────────────────────

/** The program's own Anthropic key, sent on every turn. A stand-in value. */
const OWN_KEY = `sk-ant-api03-e2e-${randomUUID()}`;

const planner = new ScriptedPlanner();
const wire: WireCall[] = [];
let fx: TestAppFixture | undefined;
let baseUrl = '';

beforeAll(async () => {
  fx = await buildTestApp({
    enableAgentRuntime: true,
    agentDecomposer: planner,
    // The account owner's key. It mints the program's key and does nothing else.
    scopes: ['read', 'write', 'account_owner'],
  });
  // A real listener, not app.inject(): the SDK's own fetch, URL building and
  // header assembly are part of what is under test.
  await fx.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(fx.app.server.address() as AddressInfo).port.toString()}`;
});

afterAll(async () => {
  if (fx !== undefined) await fx.cleanup();
});

function owner(): Driftstack {
  if (fx === undefined) throw new Error('the test app did not start');
  return new Driftstack({ apiKey: fx.plaintext, baseUrl });
}

/** A key minted through the public API, the way a program's key is made. */
async function programSdk(scopes: Array<'read' | 'write' | 'read:sessions' | 'write:sessions'>) {
  const minted = await owner().apiKeys.create({ name: `ai-job-${randomUUID()}`, scopes });
  // Exactly what was asked for: in particular, never `account_owner`.
  expect([...minted.scopes].sort()).toEqual([...scopes].sort());
  return new Driftstack({ apiKey: minted.plaintext, baseUrl, fetch: recordingFetch(wire) });
}

/** What a program does after create: read the session until it is ready. */
async function waitUntilReady(sdk: Driftstack, id: string): Promise<AgentSession> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const session = await sdk.agentSessions.get(id);
    if (session.status !== 'provisioning') return session;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`agent session ${id} was still provisioning after 50 reads`);
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function lastCall(method: string, path: string): WireCall {
  const call = wire.filter((c) => c.method === method && c.path === path).at(-1);
  if (call === undefined) throw new Error(`the SDK never called ${method} ${path}`);
  return call;
}

type PlanExecuted = Extract<AgentMessageResponse, { kind: 'plan-executed' }>;
type ConfirmationRequired = Extract<AgentIntentResult, { kind: 'confirmation_required' }>;

function expectKind<K extends AgentMessageResponse['kind']>(
  response: AgentMessageResponse,
  kind: K,
): Extract<AgentMessageResponse, { kind: K }> {
  if (response.kind !== kind) {
    throw new Error(`expected a ${kind} turn, got ${JSON.stringify(response)}`);
  }
  return response as Extract<AgentMessageResponse, { kind: K }>;
}

// ── The flow ──────────────────────────────────────────────────────────────────

const flow: {
  sdk?: Driftstack;
  profileId?: string;
  sessionId?: string;
  firstTurn?: PlanExecuted;
  firstTurnKey?: string;
  halted?: ConfirmationRequired;
} = {};

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`this stage needs ${what} from the stage above it`);
  return value;
}

describe('a program can run an AI task end to end through the public API', () => {
  it('a key with broad read and write, and no account_owner, starts an AI session on a saved profile, and the profile then holds that one live session', async () => {
    const sdk = await programSdk(['read', 'write']);
    const profile = await sdk.profiles.create({ name: 'supplier-portal' });

    const created = await sdk.agentSessions.create(
      { mode: 'ai', profile_id: profile.id, token_budget: 50_000 },
      { idempotencyKey: randomUUID() },
    );
    expect(lastCall('POST', '/v1/agent-sessions').status).toBe(201);
    expect(created.mode).toBe('ai');
    expect(created.model, 'leaving `model` unset runs the default model').toBe('claude-sonnet-5');
    expect(created.token_budget_total).toBe(50_000);
    const ready = await waitUntilReady(sdk, created.id);
    expect(ready.status).toBe('active');

    // The session really is on that profile: a second one is refused, and the
    // refusal names the live session so a program can close it and retry.
    const second = await sdk.agentSessions
      .create({ mode: 'ai', profile_id: profile.id }, { idempotencyKey: randomUUID() })
      .catch((err: unknown) => err);
    expect(second).toBeInstanceOf(ProfileInUseError);
    expect((second as ProfileInUseError).extensions).toMatchObject({
      active_session_id: created.id,
    });

    flow.sdk = sdk;
    flow.profileId = profile.id;
    flow.sessionId = created.id;
  });

  it('a task comes back plan-executed with a result for each step and the answer to the question it asked, and the stream reports the plan and each step before the result arrives', async () => {
    const sdk = need(flow.sdk, 'the SDK');
    const id = need(flow.sessionId, 'the session');
    const order: string[] = [];
    const steps: Array<{ index: number; result: AgentIntentResult }> = [];
    const answerEvents: unknown[] = [];
    const key = randomUUID();

    const turn = expectKind(
      await sdk.agentSessions.message(id, TASK.readInvoice, {
        idempotencyKey: key,
        byokApiKey: OWN_KEY,
        onStep: (step) => {
          order.push('step');
          steps.push(step);
        },
        onEvent: (event) => {
          order.push(event.type);
          if (event.type === 'answer') answerEvents.push(event.data);
        },
      }),
      'plan-executed',
    );

    expect(turn.ok).toBe(true);
    expect(turn.results.map((r) => r.kind)).toEqual(['success', 'success']);
    expect(turn.results[0]?.intent).toEqual({ kind: 'navigate', url: INVOICES_URL });
    const capture = turn.results[1];
    expect(capture?.intent).toEqual(SCREENSHOT);
    expect(capture?.kind === 'success' ? capture.captureId : undefined).toEqual(expect.any(String));
    expect(turn.answer).toBe('The latest invoice totals $1,284.50.');
    expect(turn, 'a task that finished carries no notice').not.toHaveProperty('notice');

    // The answer was read off this session's own page, and drawn from it.
    expect(device.reads.at(-1)).toBe(id);
    expect(planner.answerCalls.at(-1)).toMatchObject({
      task: TASK.readInvoice,
      observation: device.pageText,
    });

    // Progress arrived before the result: the plan first, then each step as it
    // landed (the same shape the final `results` carry), then the answer.
    // (Presence first: an absent event's index is -1, which is "before" everything.)
    expect(order).toEqual(expect.arrayContaining(['plan', 'step_start', 'step', 'answer']));
    expect(order.indexOf('plan')).toBeLessThan(order.indexOf('step'));
    expect(order.indexOf('step_start')).toBeLessThan(order.indexOf('step'));
    expect(order.lastIndexOf('step')).toBeLessThan(order.indexOf('answer'));
    expect(steps).toEqual(turn.results.map((result, index) => ({ index, result })));
    expect(answerEvents).toEqual([{ answer: turn.answer }]);

    const call = lastCall('POST', `/v1/agent-sessions/${id}/message`);
    expect(call).toMatchObject({ status: 200, idempotencyKey: key, sentOwnKey: true });
    expect(call.contentType).toContain('text/event-stream');
    expect(JSON.stringify(turn), 'the own key is never echoed').not.toContain(OWN_KEY);

    flow.firstTurn = turn;
    flow.firstTurnKey = key;
  });

  it('sending the same turn again with the same Idempotency-Key replays its result and does not run the task a second time', async () => {
    const sdk = need(flow.sdk, 'the SDK');
    const id = need(flow.sessionId, 'the session');
    const first = need(flow.firstTurn, 'the first turn');
    const plannedBefore = planner.calls.length;
    const readsBefore = device.reads.length;

    const replay = await sdk.agentSessions.message(id, TASK.readInvoice, {
      idempotencyKey: need(flow.firstTurnKey, 'the first turn’s key'),
      byokApiKey: OWN_KEY,
    });

    expect(replay).toEqual(first);
    expect(planner.calls.length, 'nothing was planned again').toBe(plannedBefore);
    expect(device.reads.length, 'the page was not read again').toBe(readsBefore);
  });

  it('a purchase step halts as confirmation_required with ok false, and nothing after it runs', async () => {
    const sdk = need(flow.sdk, 'the SDK');
    const id = need(flow.sessionId, 'the session');

    const turn = expectKind(
      await sdk.agentSessions.message(id, TASK.buyMug, {
        idempotencyKey: randomUUID(),
        byokApiKey: OWN_KEY,
      }),
      'plan-executed',
    );

    expect(turn.ok).toBe(false);
    expect(turn.intents, 'the plan had three steps').toHaveLength(3);
    expect(turn.results.map((r) => r.kind)).toEqual(['success', 'confirmation_required']);
    const halt = turn.results[1];
    if (halt?.kind !== 'confirmation_required') throw new Error('the purchase step did not halt');
    expect(halt.category).toBe('purchase');
    expect(halt.intent).toEqual(BUY_TAP);
    expect(halt.matchedText.length).toBeGreaterThan(0);
    expect(turn).not.toHaveProperty('answer');

    flow.halted = halt;
  });

  it('re-sending the same message with approve_consequential_actions runs the halted step and the rest of the plan, without planning again', async () => {
    const sdk = need(flow.sdk, 'the SDK');
    const id = need(flow.sessionId, 'the session');
    const halt = need(flow.halted, 'the halted purchase step');
    const plannedBefore = planner.calls.length;

    const turn = expectKind(
      await sdk.agentSessions.message(id, TASK.buyMug, {
        // A new logical turn, so a new key: the approval is part of the request.
        idempotencyKey: randomUUID(),
        byokApiKey: OWN_KEY,
        approveConsequentialActions: [{ category: halt.category, matchedText: halt.matchedText }],
      }),
      'plan-executed',
    );

    // On the wire the approval is spelled the request's way — `matched_text` —
    // though the result it came from spells it `matchedText`.
    expect(lastCall('POST', `/v1/agent-sessions/${id}/message`).body).toEqual({
      user_message: TASK.buyMug,
      approve_consequential_actions: [{ category: 'purchase', matched_text: halt.matchedText }],
    });
    expect(turn.ok).toBe(true);
    expect(turn.results.map((r) => [r.kind, r.intent])).toEqual([
      ['success', BUY_TAP],
      ['success', SCREENSHOT],
    ]);
    expect(planner.calls.length, 'the reviewed plan ran as it was; nothing was planned again').toBe(
      plannedBefore,
    );
  });

  it('a vague task comes back as clarify, and the reply sent as the next message continues the same task', async () => {
    const sdk = need(flow.sdk, 'the SDK');
    const id = need(flow.sessionId, 'the session');

    const asked = expectKind(
      await sdk.agentSessions.message(id, TASK.vague, {
        idempotencyKey: randomUUID(),
        byokApiKey: OWN_KEY,
      }),
      'clarify',
    );
    expect(asked.clarifying_question).toBe(QUESTION);

    const answered = expectKind(
      await sdk.agentSessions.message(id, TASK.reply, {
        idempotencyKey: randomUUID(),
        byokApiKey: OWN_KEY,
      }),
      'plan-executed',
    );
    expect(answered.ok).toBe(true);
    expect(answered.results.map((r) => r.intent)).toEqual([
      { kind: 'navigate', url: SEPTEMBER_URL },
      { kind: 'capture', capture: 'pdf' },
    ]);
    // The reply was planned with the question it answers in front of it.
    const planned = planner.calls.at(-1);
    expect(planned?.task).toBe(TASK.reply);
    expect(planned?.history.map((e) => [e.role, e.body])).toEqual(
      expect.arrayContaining([
        ['user', TASK.vague],
        ['agent', expect.stringContaining(QUESTION)],
      ]),
    );
  });

  it('stop answers stop_requested while a turn runs, the turn ends as stopped, and stop then answers no_turn_running', async () => {
    const sdk = need(flow.sdk, 'the SDK');
    const id = need(flow.sessionId, 'the session');

    const running = sdk.agentSessions.message(id, TASK.longRunning, {
      idempotencyKey: randomUUID(),
      byokApiKey: OWN_KEY,
    });
    await waitFor(() => planner.waitingToBeStopped, 'the turn to be running');

    expect(await sdk.agentSessions.stop(id)).toEqual({ status: 'stop_requested', session_id: id });
    expect(lastCall('POST', `/v1/agent-sessions/${id}/stop`).status).toBe(202);

    const ended = expectKind(await running, 'stopped');
    expect(ended).toMatchObject({
      ok: false,
      stopped_during: 'planning',
      intents: [],
      results: [],
    });
    expect(ended.notice.length).toBeGreaterThan(0);

    expect(await sdk.agentSessions.stop(id)).toEqual({ status: 'no_turn_running', session_id: id });
    expect(lastCall('POST', `/v1/agent-sessions/${id}/stop`).status).toBe(200);
  });

  it('close ends the session: it reads closed, a later message is refused with a 409, and the profile is free for the next run', async () => {
    const sdk = need(flow.sdk, 'the SDK');
    const id = need(flow.sessionId, 'the session');
    const profileId = need(flow.profileId, 'the profile');

    await expect(sdk.agentSessions.close(id)).resolves.toBeUndefined();
    expect(lastCall('DELETE', `/v1/agent-sessions/${id}`).status).toBe(204);

    const closed = await sdk.agentSessions.get(id);
    expect(closed).toMatchObject({ status: 'closed', closed_reason: 'customer-closed' });
    expect(closed.closed_at).toEqual(expect.any(String));

    const refused = await sdk.agentSessions
      .message(id, TASK.readInvoice, { idempotencyKey: randomUUID(), byokApiKey: OWN_KEY })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).status).toBe(409);
    // The stream had already opened, so the refusal travelled in its one
    // terminal frame rather than as the HTTP status; the SDK raises it the same.
    const refusal = lastCall('POST', `/v1/agent-sessions/${id}/message`);
    expect(refusal.status).toBe(200);
    expect(refusal.contentType).toContain('text/event-stream');
    // The refusal says which conflict it is in fields, not only in its sentence:
    // a program tells "this session is over" from "this session is busy" by
    // `session_status`, and reads why it ended without a second call.
    expect((refused as ConflictError).extensions).toMatchObject({
      session_status: 'closed',
      closed_reason: 'customer-closed',
    });

    // Closing twice is safe, so a program can close in `finally` unconditionally.
    await expect(sdk.agentSessions.close(id)).resolves.toBeUndefined();

    const nextRun = await sdk.agentSessions.create(
      { mode: 'ai', profile_id: profileId },
      { idempotencyKey: randomUUID() },
    );
    expect((await waitUntilReady(sdk, nextRun.id)).status).toBe('active');
    await sdk.agentSessions.close(nextRun.id);
  });
});

describe('the edges of the same contracts', () => {
  it('an approval that does not come straight after the halt is not used: the task is planned again and the purchase step halts again', async () => {
    const sdk = await programSdk(['read', 'write']);
    const session = await sdk.agentSessions.create(
      { mode: 'ai' },
      { idempotencyKey: randomUUID() },
    );
    const send = (message: string, approvals?: ConfirmationRequired) =>
      sdk.agentSessions.message(session.id, message, {
        idempotencyKey: randomUUID(),
        byokApiKey: OWN_KEY,
        ...(approvals !== undefined
          ? {
              approveConsequentialActions: [
                { category: approvals.category, matchedText: approvals.matchedText },
              ],
            }
          : {}),
      });

    try {
      const halted = expectKind(await send(TASK.buyMug), 'plan-executed');
      const halt = halted.results.at(-1);
      if (halt?.kind !== 'confirmation_required') throw new Error('the purchase step did not halt');

      // Another message comes in between…
      expectKind(await send(TASK.readInvoice), 'plan-executed');

      // …so the approval no longer answers the halt it was given for.
      const plannedBefore = planner.calls.length;
      const late = expectKind(await send(TASK.buyMug, halt), 'plan-executed');
      expect(planner.calls.length, 'the task was planned afresh').toBe(plannedBefore + 1);
      expect(late.ok).toBe(false);
      expect(late.results.at(-1)).toMatchObject({
        kind: 'confirmation_required',
        category: 'purchase',
        intent: BUY_TAP,
      });
    } finally {
      await sdk.agentSessions.close(session.id);
    }
  });

  it('a key with only the per-resource session scopes cannot start an AI session, because agent sessions need broad write', async () => {
    const sdk = await programSdk(['read:sessions', 'write:sessions']);
    const refused = await sdk.agentSessions
      .create({ mode: 'ai' }, { idempotencyKey: randomUUID() })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(lastCall('POST', '/v1/agent-sessions').status).toBe(403);
  });
});
