// A program written only from the guide runs unchanged against the server.
//
// The other end-to-end flow test
// (`a-program-can-run-an-ai-task-end-to-end-through-the-public-api.test.ts`)
// drives the API the way this repository knows it works. This one asks a
// different question: does the API work the way the DOCUMENTATION says it does?
//
// So the program under test — `_helpers/a-program-written-only-from-the-guide.ts`
// — was written from `guides/run-ai-tasks-from-code.md` and the pages it links,
// with the server and the SDK source closed, and it is run here UNCHANGED. This
// file may know how the server is built; that file may not. Every branch the
// program takes, every field it reads and every retry rule it follows was taken
// from a sentence a customer can read, and the comments there name the page.
//
// ⛔ When this test fails, the first question is whether the DOCS are wrong, not
// whether the program is. Editing the program to match the server — teaching it
// something no page says — makes this test pass and destroys the only thing it
// measures. Fix the documentation (or, if the docs were right and the code
// wrong, fix the code), and leave the program written from the docs.
//
// What is stood in for, exactly as in the flow test: the PLANNER is scripted, so
// no model is ever called and every turn is deterministic; the DEVICE is the stub
// executor every agent-session integration test uses, given the ability to read
// the page back so an `answer` can exist at all. Everything else — the routes,
// the turn runtime, the SSE lane, the idempotency receipts, the capture store, the
// transcript stream — is the real thing, over real HTTP, through the built SDK a
// customer installs.
//
// The outcomes the guide tells a program to handle, one test each:
//   · done, with the answer to the question it asked
//   · a clarifying question, answered as the next message
//   · a step held for approval — refused by an unattended job, approved when a
//     person has said it may be
//   · a refusal
//   · `answer_unavailable` — asked for information, none could be produced
//   · not finished: a `notice` with a `notice_reason` the job may answer itself
//     (`step_limit` → "continue"), and one it must not (`no_progress`)
//   · not finished: a `notice` that asks for "continue", and "continue"
//     carrying the task on — and one that asks for something else, which the
//     job shows rather than answers
//   · stopped, because the job's own timer asked it to stop
//   · a refusal that did no work, whose Idempotency-Key the program may reuse:
//     once where the key was never reserved (the message rate) and once where
//     the server had to give a reserved key back (the AI-turns ceiling)
//   · the session ending underneath a running message
//   · the session closed in a `finally`, even when the message throws

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Driftstack } from '@driftstack/sdk';
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
import type * as AppModule from '../../src/lib/app.js';
import type { SessionCaptureStore } from '../../src/services/session-capture-store.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import {
  runInvoiceTask,
  type JobConfig,
  type JobReport,
} from './_helpers/a-program-written-only-from-the-guide.js';

// ── The device: the stub executor, able to read the page back ────────────────

const device = vi.hoisted((): { pageText: string | null; screenshotB64: string } => ({
  /** What the page says when it is read back. `null` = it could not be read. */
  pageText: 'Invoices · INV-0926 · September 2026 · Total due: $1,284.50',
  /** The smallest valid PNG, as base64 — what a screenshot step "took". */
  screenshotB64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
}));

const capture = vi.hoisted(() => ({ store: undefined as SessionCaptureStore | undefined }));

vi.mock('../../src/lib/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AppModule>();
  const { SessionCaptureStore } = await import('../../src/services/session-capture-store.js');
  return {
    ...actual,
    buildApp: (deps: Parameters<typeof actual.buildApp>[0]) => {
      capture.store ??= new SessionCaptureStore();
      return actual.buildApp({ ...deps, sessionCaptureStore: capture.store });
    },
  };
});

vi.mock('../../src/services/agent-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentExecutorModule>();
  class StubAgentExecutorThatReadsThePage extends actual.StubAgentExecutor {
    observe(): Promise<string | null> {
      return Promise.resolve(device.pageText);
    }

    /** A screenshot step stores real bytes under the id the capture route serves. */
    override execute(
      args: Parameters<AgentExecutorModule.StubAgentExecutor['execute']>[0],
    ): ReturnType<AgentExecutorModule.StubAgentExecutor['execute']> {
      const announce = args.onStep;
      return super.execute({
        ...args,
        onStep: (result, index) => {
          if (
            result.kind === 'success' &&
            result.intent.kind === 'capture' &&
            result.intent.capture === 'screenshot' &&
            capture.store !== undefined
          ) {
            const id = capture.store.put(
              args.agentSessionId ?? args.sessionId,
              device.screenshotB64,
              'png',
            );
            (result as { captureId?: string }).captureId = id;
          }
          announce?.(result, index);
        },
      });
    }
  }
  return { ...actual, StubAgentExecutor: StubAgentExecutorThatReadsThePage };
});

// ── The planner: scripted, one plan per task, no model call ──────────────────

/**
 * The tasks the program is given. Each one is written the way the guide tells a
 * customer to write one — the start URL in the message, and words that ask for
 * information where an answer is wanted.
 */
const TASK = {
  readInvoice:
    'Open https://portal.example.test/invoices, take a screenshot and tell me the total of the September 2026 invoice.',
  vague: 'Find my invoice and tell me the total.',
  reply: 'Use the invoice dated September 2026 and tell me its total. Do not pay anything.',
  payInvoice:
    'Open https://portal.example.test/invoices and pay the September 2026 invoice, then tell me the total.',
  offLimits: 'Open https://portal.example.test/invoices and tell me every other customer’s total.',
  unreadable:
    'Open https://portal.example.test/broken, take a screenshot and tell me the total shown there.',
  neverEnds: 'Open https://portal.example.test/reports and tell me the total of every report.',
  keepsGoing: 'Open https://portal.example.test/ledger and tell me the closing balance.',
  goesInCircles: 'Open https://portal.example.test/ledger and tell me the opening balance.',
  endsUnderneath:
    'Open https://portal.example.test/archive and tell me the total of the oldest invoice.',
  continue: 'continue',
} as const;

const QUESTION = 'Which invoice do you want: August 2026 or September 2026?';
const SCREENSHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const PAY_TAP: AgentIntent = {
  kind: 'interact',
  action: 'tap',
  selector: '#pay',
  value: 'Pay now',
};

function plan(intents: AgentIntent[], status?: 'continue' | 'done'): Promise<DecomposeResult> {
  return Promise.resolve({
    kind: 'plan',
    intents,
    ...(status === undefined ? {} : { status }),
    tokensConsumed: 50,
  });
}

class ScriptedPlanner implements AgentDecomposer {
  readonly calls: DecomposeArgs[] = [];
  readonly answerCalls: AnswerArgs[] = [];

  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    this.calls.push(args);
    switch (args.task) {
      case TASK.readInvoice:
        return plan([
          { kind: 'navigate', url: 'https://portal.example.test/invoices' },
          SCREENSHOT,
        ]);
      case TASK.unreadable:
        return plan([{ kind: 'navigate', url: 'https://portal.example.test/broken' }, SCREENSHOT]);
      case TASK.vague:
        return Promise.resolve({
          kind: 'clarify',
          clarifyingQuestion: QUESTION,
          tokensConsumed: 50,
        });
      case TASK.reply:
        // A reply only means something next to the question it answers.
        return args.history.some((entry) => entry.body.includes(QUESTION))
          ? plan([
              { kind: 'navigate', url: 'https://portal.example.test/invoices/2026-09' },
              SCREENSHOT,
            ])
          : Promise.resolve({
              kind: 'refuse',
              refuseReason: 'There is no earlier question this could be the answer to.',
              tokensConsumed: 50,
            });
      case TASK.payInvoice:
        return plan([
          { kind: 'navigate', url: 'https://portal.example.test/invoices' },
          PAY_TAP,
          SCREENSHOT,
        ]);
      case TASK.offLimits:
        return Promise.resolve({
          kind: 'refuse',
          refuseReason: 'I will not read another customer’s account.',
          tokensConsumed: 50,
        });
      case TASK.keepsGoing: {
        // A different page every round, so nothing is a repeat: the turn keeps
        // planning until it runs out of the planning rounds it may make for one
        // message, and hands back with the notice that asks for "continue".
        const round = this.calls.filter((call) => call.task === TASK.keepsGoing).length;
        return plan(
          [{ kind: 'navigate', url: `https://portal.example.test/ledger/page-${String(round)}` }],
          'continue',
        );
      }
      case TASK.goesInCircles:
        // The SAME page every round, so the turn notices it is about to do what
        // it just did, and hands back with a notice that asks for something
        // other than "continue".
        return plan([{ kind: 'navigate', url: 'https://portal.example.test/ledger' }], 'continue');
      case TASK.continue:
        return plan([{ kind: 'navigate', url: 'https://portal.example.test/ledger/end' }], 'done');
      case TASK.neverEnds:
        return this.planUntilStopped(args.signal);
      case TASK.endsUnderneath:
        // A planning call that takes a moment — long enough for the session to
        // be ended underneath it, the way a real one takes as long as the model
        // does. It then returns a plan, and the turn finds the session gone.
        return new Promise<DecomposeResult>((resolve) => {
          setTimeout(() => {
            void plan([{ kind: 'navigate', url: 'https://portal.example.test/archive' }]).then(
              resolve,
            );
          }, 250);
        });
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
        total !== undefined
          ? `The September 2026 invoice totals ${total}.`
          : 'The page shows no total.',
      tokensConsumed: 0,
    });
  }

  private planUntilStopped(signal: AbortSignal | undefined): Promise<DecomposeResult> {
    return new Promise<DecomposeResult>((_resolve, reject) => {
      if (signal === undefined) {
        reject(new Error('this task only ends when it is stopped, and the turn carried no signal'));
        return;
      }
      const end = (): void => {
        reject(new Error('aborted'));
      };
      if (signal.aborted) end();
      else signal.addEventListener('abort', end, { once: true });
    });
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

/** The program's own Anthropic key, sent on every message. A stand-in value. */
const OWN_KEY = `sk-ant-api03-docs-${randomUUID()}`;

const planner = new ScriptedPlanner();
let fx: TestAppFixture | undefined;
let baseUrl = '';
/** The key the program runs under: broad read + write, and nothing else. */
let programKey = '';

beforeAll(async () => {
  fx = await buildTestApp({
    enableAgentRuntime: true,
    agentDecomposer: planner,
    // The account owner's key, which mints the program's key and does nothing else.
    scopes: ['read', 'write', 'account_owner'],
  });
  await fx.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(fx.app.server.address() as AddressInfo).port.toString()}`;

  const owner = new Driftstack({ apiKey: fx.plaintext, baseUrl });
  const minted = await owner.apiKeys.create({
    name: `nightly-invoice-job-${randomUUID()}`,
    // Exactly what the guide tells a job to mint: broad `read` and `write`,
    // and deliberately never `account_owner`.
    scopes: ['read', 'write'],
  });
  expect([...minted.scopes].sort()).toEqual(['read', 'write']);
  programKey = minted.plaintext;

  // Watch the receipt store's own release, without changing what it does.
  const receipts = fx.agentTurnReceiptsRepo;
  if (receipts?.release === undefined) throw new Error('the fixture wired no releasable receipts');
  const realRelease = receipts.release.bind(receipts);
  vi.spyOn(receipts, 'release').mockImplementation(async (args) => {
    released.push(args.idempotencyKey);
    await realRelease(args);
  });
});

afterAll(async () => {
  if (fx !== undefined) await fx.cleanup();
});

function owner(): Driftstack {
  if (fx === undefined) throw new Error('the test app did not start');
  return new Driftstack({ apiKey: fx.plaintext, baseUrl });
}

/**
 * Every Idempotency-Key the server gave back, in order. The guide's same-key
 * table has two mechanisms behind it: a refusal decided before the key is ever
 * reserved (nothing to give back), and one decided after, which the server has
 * to release. A customer cannot tell them apart, and should not have to — but a
 * test that never sees a release is not testing the second one.
 */
const released: string[] = [];

/** A session the program did not create: poll it the way the guide says to. */
async function waitUntilActive(sdk: Driftstack, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = await sdk.agentSessions.get(id);
    if (session.status !== 'provisioning') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`agent session ${id} was still provisioning after 100 reads`);
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A profile the job runs on, as the guide's one-time setup leaves one. */
async function signedInProfile(name: string): Promise<string> {
  const profile = await new Driftstack({ apiKey: programKey, baseUrl }).profiles.create({ name });
  return profile.id;
}

const said: string[] = [];

/** The job's configuration, with only what each test varies passed in. */
function job(overrides: Partial<JobConfig> & { profileId: string; task: string }): JobConfig {
  return {
    apiKey: programKey,
    baseUrl,
    replyToQuestions: TASK.reply,
    ownAnthropicKey: OWN_KEY,
    approveActions: false,
    stopAfterMs: 120_000,
    continueOnNotice: false,
    log: (line) => said.push(line),
    ...overrides,
  };
}

/** What the guide promises every run does, whatever the outcome. */
async function expectTheSessionWasClosedAndTheProfileIsFree(
  report: JobReport,
  profileId: string,
): Promise<void> {
  const after = await owner().agentSessions.get(report.sessionId);
  expect(after.status, 'the program closes the session in a finally').toBe('closed');
  expect(after.closed_reason).toBe('customer-closed');
  // "Only one session can be open on a profile at a time" — so a closed one
  // leaves the profile free for tomorrow's run.
  const next = await owner().agentSessions.create(
    { mode: 'ai', profile_id: profileId },
    { idempotencyKey: randomUUID() },
  );
  await owner().agentSessions.close(next.id);
}

describe('a program written only from the guide runs unchanged against the server', () => {
  it('runs the task, reads the answer, fetches the screenshot, reads the conversation back, stops and closes', async () => {
    device.pageText = 'Invoices · INV-0926 · September 2026 · Total due: $1,284.50';
    const profileId = await signedInProfile('supplier-portal-answered');

    const report = await runInvoiceTask(job({ profileId, task: TASK.readInvoice }));

    expect(report.outcome).toBe('answered');
    expect(report.answer).toBe('The September 2026 invoice totals $1,284.50.');
    expect(report.answerUnavailable).toBeUndefined();
    expect(report.notice, 'a task that finished carries no notice').toBeUndefined();
    expect(report.steps).toHaveLength(2);
    expect(report.steps.every((line) => line.startsWith('done:'))).toBe(true);

    // The screenshot behind the step's captureId came back, as bytes with the
    // media type the server gave them.
    expect(report.captures).toHaveLength(1);
    expect(report.captures[0]?.contentType).toBe('image/png');
    expect(report.captures[0]?.byteLength).toBe(
      Buffer.from(device.screenshotB64, 'base64').byteLength,
    );

    // The conversation read back oldest first, and the loop ended at the last
    // entry the way the guide's snippet does.
    expect(report.transcript.length).toBeGreaterThanOrEqual(2);
    expect(report.transcript.map((e) => e.index)).toEqual(
      report.transcript.map((_, index) => index),
    );
    expect(report.transcript[0]?.role).toBe('user');
    expect(report.transcript[0]?.body).toBe(TASK.readInvoice);
    expect(report.transcript.at(-1)?.role).toBe('agent');

    // Stop, when nothing is running, says so and leaves the session open.
    expect(report.stopStatus).toBe('no_turn_running');
    expect(report.messagesSent).toBe(1);
    expect(report.messageAttempts).toBe(1);

    await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
  }, 30_000);

  it('answers the agent’s clarifying question as the next message and gets the answer', async () => {
    device.pageText = 'Invoices · INV-0926 · September 2026 · Total due: $1,284.50';
    const profileId = await signedInProfile('supplier-portal-clarify');

    const report = await runInvoiceTask(job({ profileId, task: TASK.vague }));

    expect(report.outcome).toBe('answered');
    expect(report.answer).toBe('The September 2026 invoice totals $1,284.50.');
    expect(report.messagesSent, 'the task, then the reply').toBe(2);
    // The reply was planned against the question before it — the planner refuses
    // a reply that arrives without its question in the history.
    expect(planner.calls.at(-1)?.task).toBe(TASK.reply);
    expect(report.transcript.map((e) => e.body)).toContain(TASK.reply);

    await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
  }, 30_000);

  it('holds a payment step for a person instead of approving it, and says what is held', async () => {
    device.pageText = 'Invoices · INV-0926 · September 2026 · Total due: $1,284.50';
    const profileId = await signedInProfile('supplier-portal-held');

    const report = await runInvoiceTask(
      job({ profileId, task: TASK.payInvoice, approveActions: false }),
    );

    expect(report.outcome).toBe('needs-a-person');
    expect(report.heldForApproval).toEqual({ category: 'payment', matchedText: 'Pay now' });
    // The held step did not run, and nothing after it ran either.
    expect(report.steps).toEqual([
      expect.stringMatching(/^done:/),
      'held for approval: payment "Pay now"',
    ]);
    expect(report.messagesSent, 'an unattended job does not send an approval').toBe(1);

    await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
  }, 30_000);

  it('approves the held step when a person has said it may, and the agent carries on from it', async () => {
    device.pageText = 'Invoices · INV-0926 · September 2026 · Total due: $1,284.50';
    const profileId = await signedInProfile('supplier-portal-approved');
    const plannedBefore = planner.calls.length;

    const report = await runInvoiceTask(
      job({ profileId, task: TASK.payInvoice, approveActions: true }),
    );

    expect(report.heldForApproval).toBeUndefined();
    expect(report.outcome).toBe('answered');
    // The approval message carried on from the step that halted: the tap ran,
    // and so did the screenshot after it — and the navigate BEFORE the halt was
    // not run a second time, because the turn did not plan the task again.
    expect(report.steps).toEqual([
      expect.stringMatching(/^done: .*navigate/),
      'held for approval: payment "Pay now"',
      expect.stringMatching(/^done: .*tap on #pay/),
      expect.stringMatching(/^done: .*screenshot/),
    ]);
    expect(report.captures.length).toBeGreaterThanOrEqual(1);
    expect(report.messagesSent, 'the task, then the same task with the approval').toBe(2);
    expect(
      planner.calls.length - plannedBefore,
      'the approval turn carries on without planning the task again',
    ).toBe(1);

    await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
  }, 30_000);

  it('reports a refusal, and does not send the task again under the key that got it', async () => {
    const profileId = await signedInProfile('supplier-portal-refused');

    const report = await runInvoiceTask(job({ profileId, task: TASK.offLimits }));

    expect(report.outcome).toBe('refused');
    expect(report.refuseReason).toBe('I will not read another customer’s account.');
    expect(report.steps, 'a refused turn ran no steps').toEqual([]);
    expect(report.answer).toBeUndefined();
    // A refusal is final for its key: one logical message, one send.
    expect(report.messagesSent).toBe(1);
    expect(report.messageAttempts).toBe(1);

    await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
  }, 30_000);

  it('shows the one-sentence reason when it asked for information and none could be produced', async () => {
    // The page could not be read back, so there is nothing to answer from.
    device.pageText = null;
    const profileId = await signedInProfile('supplier-portal-unreadable');

    const report = await runInvoiceTask(job({ profileId, task: TASK.unreadable }));

    expect(report.outcome).toBe('answer-unavailable');
    expect(report.answer, 'the two never arrive together').toBeUndefined();
    expect(report.answerUnavailable).toEqual(expect.any(String));
    expect(report.answerUnavailable?.length, 'one sentence, in plain words').toBeGreaterThan(10);
    // Every step still succeeded; it is the read-back that could not happen.
    expect(report.steps.every((line) => line.startsWith('done:'))).toBe(true);

    await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
  }, 30_000);

  it('reports a turn that is not finished, and carries it on with "continue" when the notice asks for that', async () => {
    device.pageText = 'Ledger · running balance · nothing final yet';
    const stopped = await signedInProfile('supplier-portal-notice');

    // Left to itself, an unattended job reports that the task is not finished.
    const halted = await runInvoiceTask(
      job({ profileId: stopped, task: TASK.keepsGoing, continueOnNotice: false }),
    );
    expect(halted.outcome).toBe('not-finished');
    expect(halted.notice, 'one sentence saying it is not finished').toEqual(expect.any(String));
    // This is the limit whose sentence asks for "continue" — which is why the
    // next half of this test may send it. A notice that asked for something
    // else would make that reply the wrong one, and the arm below is the case
    // where it does.
    expect(halted.notice, 'the sentence asks for “continue”').toMatch(/continue/i);
    // And the job did not have to read the sentence to know that: the guide's
    // table says `step_limit` is one of the three a program may answer itself.
    expect(halted.noticeReason, 'the one-word reason beside the sentence').toBe('step_limit');
    expect(halted.messagesSent).toBe(1);
    await expectTheSessionWasClosedAndTheProfileIsFree(halted, stopped);

    // Told to carry on, it sends "continue" and the agent finishes from the
    // current page.
    const carriedOn = await signedInProfile('supplier-portal-continue');
    const finished = await runInvoiceTask(
      job({ profileId: carriedOn, task: TASK.keepsGoing, continueOnNotice: true }),
    );
    expect(finished.messagesSent, 'the task, then "continue"').toBe(2);
    expect(finished.notice, 'the turn that carried on finished').toBeUndefined();
    expect(finished.outcome).not.toBe('not-finished');
    expect(planner.calls.at(-1)?.task).toBe(TASK.continue);
    await expectTheSessionWasClosedAndTheProfileIsFree(finished, carriedOn);
  }, 60_000);

  it('is told it may carry on, and still does not answer a notice whose `notice_reason` needs a person', async () => {
    // The guide's notice_reason table: `no_progress` is one of the endings a
    // program must NOT answer by itself — the agent said it was about to repeat
    // something that changed nothing, and "continue" sends it round the same
    // loop. The job is switched ON for automatic continues here, so the ONLY
    // thing stopping it is the reason it read off the result.
    device.pageText = 'Ledger · running balance · nothing final yet';
    const profileId = await signedInProfile('supplier-portal-circles');
    const sentBefore = planner.calls.length;

    const report = await runInvoiceTask(
      job({ profileId, task: TASK.goesInCircles, continueOnNotice: true }),
    );

    expect(report.outcome).toBe('not-finished');
    expect(report.noticeReason, 'the ending a program must not answer itself').toBe('no_progress');
    expect(report.notice, 'the sentence does not ask for “continue”').not.toMatch(/continue/i);
    expect(report.notice, 'it says what it needs instead').toMatch(/what to try differently/i);
    expect(report.messagesSent, 'the job did not reply to it').toBe(1);
    expect(
      planner.calls.slice(sentBefore).every((call) => call.task === TASK.goesInCircles),
      'no "continue" was sent',
    ).toBe(true);

    await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
  }, 30_000);

  it('stops a task that runs too long and reports how far it got', async () => {
    const profileId = await signedInProfile('supplier-portal-stopped');

    const report = await runInvoiceTask(
      // The job's own timer asks the task to stop, from outside the message.
      job({ profileId, task: TASK.neverEnds, stopAfterMs: 200 }),
    );

    expect(report.outcome).toBe('stopped');
    expect(report.stoppedDuring).toBe('planning');
    expect(report.notice, 'a stopped turn says how far it got').toEqual(expect.any(String));
    expect(report.steps, 'nothing had run yet').toEqual([]);
    // Stopping is safe to repeat: the second one, after the turn ended, says
    // there was nothing running.
    expect(report.stopStatus).toBe('no_turn_running');

    await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
  }, 30_000);

  it('reuses its Idempotency-Key after a refusal that did no work, and the same key then runs the task once', async () => {
    device.pageText = 'Invoices · INV-0926 · September 2026 · Total due: $1,284.50';
    const profileId = await signedInProfile('supplier-portal-retry');
    if (fx === undefined) throw new Error('the test app did not start');
    const plannedBefore = planner.calls.length;

    // The first message is refused by the message rate limit — a refusal the
    // docs list as "did no work", so the key is still the program's to use.
    let refusals = 0;
    const releasedBefore = released.length;
    const realConsume = fx.rateLimitStore.consume.bind(fx.rateLimitStore);
    const spy = vi
      .spyOn(fx.rateLimitStore, 'consume')
      .mockImplementation(async (input: Parameters<typeof realConsume>[0]) => {
        if (input.key.includes('agent_sessions:message') && refusals === 0) {
          refusals += 1;
          return { allowed: false, remaining: 0, retryAfterMs: 1_000 };
        }
        return realConsume(input);
      });

    try {
      const report = await runInvoiceTask(job({ profileId, task: TASK.readInvoice }));

      expect(refusals, 'the rate limit really did refuse once').toBe(1);
      expect(report.outcome).toBe('answered');
      expect(report.answer).toBe('The September 2026 invoice totals $1,284.50.');
      expect(report.messagesSent, 'one logical message').toBe(1);
      expect(report.messageAttempts, 'sent twice, under the same key').toBe(2);
      expect(
        planner.calls.length - plannedBefore,
        'the refusal ran nothing, and the retry ran the task once',
      ).toBe(1);
      expect(said).toContain('  nothing ran (RateLimitError); sending the same key again');
      // This row of the guide's table is safe for a reason of its own: the
      // message rate is spent BEFORE the key is reserved, so there is nothing
      // to give back. The arm below is the other half — a refusal that reserved
      // the key and had to release it — and the two releases counters are what
      // tell them apart.
      expect(released.length - releasedBefore, 'no key was reserved to give back').toBe(0);

      await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('reuses its Idempotency-Key after a refusal the server reserved the key for and gave back, and the same key then runs the task once', async () => {
    // The guide's same-key table row "too many AI messages running at once".
    // Unlike the message-rate row above, this refusal happens AFTER the key is
    // reserved, so the server has to release it — the path the docs promise is
    // live in production. Filling the ceiling for real, rather than mocking the
    // refusal, is what makes the release the server's own decision.
    device.pageText = 'Invoices · INV-0926 · September 2026 · Total due: $1,284.50';
    const profileId = await signedInProfile('supplier-portal-ceiling');
    const sdk = owner();
    const plannedBefore = planner.calls.length;
    const releasedBefore = released.length;

    // The guide's Limits table: "AI messages running at once, per account | 3".
    const ceiling = 3;
    const blockers = await Promise.all(
      Array.from({ length: ceiling }, () =>
        sdk.agentSessions.create({ mode: 'ai' }, { idempotencyKey: randomUUID() }),
      ),
    );
    for (const blocker of blockers) await waitUntilActive(sdk, blocker.id);
    // Each of these only ends when it is stopped, so the ceiling stays full.
    const running = blockers.map((blocker) =>
      sdk.agentSessions
        .message(blocker.id, TASK.neverEnds, { idempotencyKey: randomUUID(), byokApiKey: OWN_KEY })
        .catch(() => undefined),
    );
    await waitFor(
      () => planner.calls.filter((call) => call.task === TASK.neverEnds).length >= ceiling,
      'the account’s AI turns to be at the ceiling',
    );

    const saidBefore = said.length;
    const run = runInvoiceTask(job({ profileId, task: TASK.readInvoice }));
    try {
      await waitFor(
        () => said.slice(saidBefore).some((line) => line.includes('nothing ran (RateLimitError)')),
        'the job to be refused by the ceiling and decide to reuse its key',
      );
      // Make room. The job's next send, under the SAME key, then runs the task.
      for (const blocker of blockers) await sdk.agentSessions.stop(blocker.id);
      await Promise.all(running);

      const report = await run;
      expect(report.outcome).toBe('answered');
      expect(report.answer).toBe('The September 2026 invoice totals $1,284.50.');
      expect(report.messagesSent, 'one logical message').toBe(1);
      expect(report.messageAttempts, 'sent more than once, under the same key').toBeGreaterThan(1);
      expect(
        planner.calls.filter((call) => call.task === TASK.readInvoice).length -
          planner.calls.slice(0, plannedBefore).filter((call) => call.task === TASK.readInvoice)
            .length,
        'the refusals ran nothing, and the retry ran the task exactly once',
      ).toBe(1);
      // The server really did give a reserved key back — this is the release
      // the message-rate arm above never needs.
      expect(
        released.length - releasedBefore,
        'the server released the reserved key',
      ).toBeGreaterThan(0);

      await expectTheSessionWasClosedAndTheProfileIsFree(report, profileId);
    } finally {
      await Promise.allSettled(running);
      for (const blocker of blockers)
        await sdk.agentSessions.close(blocker.id).catch(() => undefined);
    }
  }, 60_000);

  it('says the session ended when it ends ON ITS OWN underneath a running message, and does not repeat the steps that ran', async () => {
    // The guide: "A session can also end on its own — when its token budget runs
    // out, when its history is full, … or when the browser behind it ends it …
    // It then reads `status: "closed"` with a `closed_reason`, and a message to
    // it returns `409` with `session_status: "closed"`." The error table adds
    // that `partial_results` lists any steps that did run, and says to check
    // them before sending the task again.
    //
    // ⛔ ON ITS OWN, not by the customer's own close: the guide's "Close the
    // session" says a close stops the running turn, so THAT path answers the
    // `stopped` result the next arm measures. This one is the budget running
    // out underneath the message, which is the sentence above.
    const profileId = await signedInProfile('supplier-portal-ended');
    const sdk = owner();
    const runningBefore = planner.calls.filter((call) => call.task === TASK.endsUnderneath).length;

    const run = runInvoiceTask(job({ profileId, task: TASK.endsUnderneath, stopAfterMs: 120_000 }));
    await waitFor(
      () =>
        planner.calls.filter((call) => call.task === TASK.endsUnderneath).length > runningBefore,
      'the job’s message to be running',
    );
    const mine = await sdk.agentSessions.list({ limit: 1 });
    const sessionId = mine.data[0]?.id ?? '';
    expect(sessionId, 'the session the job created').toMatch(/^agt_/);
    // The session ends the way the product ends one whose budget is spent —
    // not through the customer's own DELETE.
    const repo = fx?.agentSessionsRepo;
    if (repo === undefined) throw new Error('the fixture wired no sessions repository');
    await repo.closeWithReason(sessionId, 'budget-exhausted');

    const report = await run;
    expect(report.sessionId, 'the session the job reported is the one that ended').toBe(sessionId);
    expect(report.outcome).toBe('session-ended');
    expect(report.sessionStatus).toBe('closed');
    expect(report.closedReason, 'why it ended').toBe('budget-exhausted');
    expect(report.answer, 'nothing was answered').toBeUndefined();
    expect(report.messagesSent, 'the job did not send the task again').toBe(1);
    // Closed for good, and the profile is free for tomorrow's run.
    expect((await sdk.agentSessions.get(sessionId)).status).toBe('closed');
    const next = await sdk.agentSessions.create(
      { mode: 'ai', profile_id: profileId },
      { idempotencyKey: randomUUID() },
    );
    await sdk.agentSessions.close(next.id);
  }, 30_000);

  it('closing the session while its message is still running ends that message as `stopped`, not as a session that vanished', async () => {
    // The guide's "Close the session": closing "stops a turn that is still
    // running, so closing to cut a task short does not leave you paying out an
    // AI call you will never read. That message answers the same `stopped`
    // result POST /{id}/stop gives." Measured from the program's side: the job
    // reports `stopped`, with how far the turn got, and never treats it as a
    // session that ended underneath it.
    const profileId = await signedInProfile('supplier-portal-closed-mid-turn');
    const sdk = owner();
    const runningBefore = planner.calls.filter((call) => call.task === TASK.endsUnderneath).length;

    const run = runInvoiceTask(job({ profileId, task: TASK.endsUnderneath, stopAfterMs: 120_000 }));
    await waitFor(
      () =>
        planner.calls.filter((call) => call.task === TASK.endsUnderneath).length > runningBefore,
      'the job’s message to be running',
    );
    const mine = await sdk.agentSessions.list({ limit: 1 });
    const sessionId = mine.data[0]?.id ?? '';
    expect(sessionId, 'the session the job created').toMatch(/^agt_/);
    await sdk.agentSessions.close(sessionId);

    const report = await run;
    expect(report.sessionId).toBe(sessionId);
    expect(report.outcome, 'the customer’s own close ends the turn, it does not lose it').toBe(
      'stopped',
    );
    expect(report.stoppedDuring, 'how far the turn got').toBe('planning');
    expect(report.notice, 'one sentence saying how far it got').toEqual(expect.any(String));
    expect(report.messagesSent, 'the job did not send the task again').toBe(1);
    expect((await sdk.agentSessions.get(sessionId)).status).toBe('closed');
    const next = await sdk.agentSessions.create(
      { mode: 'ai', profile_id: profileId },
      { idempotencyKey: randomUUID() },
    );
    await sdk.agentSessions.close(next.id);
  }, 30_000);

  it('closes the session in its finally even when the message throws', async () => {
    const profileId = await signedInProfile('supplier-portal-throws');

    // A message over the documented 8,000-character ceiling: `400
    // validation-failed`, which is final for its key and not something the
    // program retries.
    const tooLong = `Open https://portal.example.test/invoices and tell me ${'x'.repeat(8_000)}`;
    await expect(runInvoiceTask(job({ profileId, task: tooLong }))).rejects.toThrow();

    // The session it created is closed all the same, and the profile is free.
    const mine = await owner().agentSessions.list({ limit: 5 });
    const latest = mine.data[0];
    expect(latest?.status, 'the finally ran').toBe('closed');
    expect(latest?.closed_reason).toBe('customer-closed');
    const next = await owner().agentSessions.create(
      { mode: 'ai', profile_id: profileId },
      { idempotencyKey: randomUUID() },
    );
    await owner().agentSessions.close(next.id);
  }, 30_000);
});
