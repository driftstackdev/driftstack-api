// Run an AI task from code: start an agent session, send it a task, read the
// outcome, and close the session.
//
// The flow:
//   1. create the session (mode 'ai') and wait until its browser is ready;
//   2. send the task with a fresh idempotency key, printing live progress;
//   3. branch on the result's `kind` — and, if the agent stopped before a
//      purchase, a payment or an account deletion, approve it by sending the
//      next message with the approvals;
//   4. close the session in `finally`, whatever happened.
//
// Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... npx tsx examples/agent-chat.ts
//
// Optional:
//
//     DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-...  run the AI on your own Anthropic key
//     DRIFTSTACK_TASK='Open https://example.com and tell me the main heading.'
//     DRIFTSTACK_APPROVE_ACTIONS=yes                approve a purchase / payment /
//                                                   account deletion the agent stops on
//
// Deployments without an AI provider reject these calls with
// FeatureUnavailableError (exit code 2).

/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';
import {
  BundledLlmBudgetExhaustedError,
  BundledLlmConsentRequiredError,
  ByokAnthropicRequiredError,
  ConcurrencyLimitError,
  ConflictError,
  Driftstack,
  FeatureUnavailableError,
  ForbiddenError,
  RateLimitError,
  type AgentIntentResult,
  type AgentMessageResponse,
  type AgentSession,
} from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
if (!apiKey) {
  console.error('Set DRIFTSTACK_API_KEY in your environment.');
  process.exit(1);
}

// Your own Anthropic key, optional. Empty means "none": the SDK sends the
// x-byok-anthropic-api-key header only for a non-empty key.
const byokKey = process.env.DRIFTSTACK_BYOK_ANTHROPIC_API_KEY ?? '';
const keyOpts = byokKey.length > 0 ? { byokApiKey: byokKey } : {};

// Ask for what you want back ("…and tell me …"): a task that asks for
// information comes back with an `answer`. Put the start URL in the task.
const task =
  process.env.DRIFTSTACK_TASK ??
  'Open https://example.com and tell me the main heading on the page.';
const approveActions = process.env.DRIFTSTACK_APPROVE_ACTIONS === 'yes';

const client = new Driftstack({ apiKey });

type PendingApproval = Extract<AgentIntentResult, { kind: 'confirmation_required' }>;

/** Poll until the session's browser is ready (or two minutes pass). */
async function waitUntilReady(session: AgentSession): Promise<AgentSession> {
  const deadline = Date.now() + 2 * 60_000;
  let current = session;
  while (current.status === 'provisioning' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    current = await client.agentSessions.get(current.id);
  }
  return current;
}

/** Send one turn. Every logical turn gets its own idempotency key; reuse a key
 *  only to retry the same turn after the connection dropped with no response. */
function sendTurn(
  sessionId: string,
  text: string,
  approvals: ReadonlyArray<PendingApproval> = [],
): Promise<AgentMessageResponse> {
  return client.agentSessions.message(sessionId, text, {
    ...keyOpts,
    idempotencyKey: randomUUID(),
    approveConsequentialActions: approvals,
    onStep: ({ index, result }) => {
      console.log(`  step ${index + 1}: ${result.kind}`);
    },
    onEvent: ({ type, data }) => {
      // The set of event names is open: ignore the ones you do not use.
      if (type === 'step_start') {
        console.log(`  … ${(data as { label?: string }).label ?? 'working'}`);
      }
    },
  });
}

function printOutcome(resp: AgentMessageResponse): void {
  switch (resp.kind) {
    case 'plan-executed':
      for (const r of resp.results) {
        if (r.kind === 'success') {
          console.log(`  ✓ ${r.summary}`);
        } else if (r.kind === 'failure') {
          // Treat a category you do not recognise as 'unknown'. Never replay a
          // step whose `retryable` is false without checking the page first.
          const category = r.diagnosis?.category ?? 'unknown';
          console.log(`  ✗ ${r.reason} (${category})`);
        } else {
          console.log(`  ⏸ waiting for approval: ${r.category} ("${r.matchedText}")`);
        }
      }
      if (resp.answer !== undefined) console.log(`Answer: ${resp.answer}`);
      // `ok` alone does not mean finished: a `notice` says why the task is not
      // done yet (send "continue" as the next message when it asks for that).
      if (resp.notice !== undefined) console.log(`Not finished: ${resp.notice}`);
      console.log(resp.ok && resp.notice === undefined ? 'Done.' : 'The task did not finish.');
      break;
    case 'clarify':
      console.log(`The agent asks: ${resp.clarifying_question} (reply with another message)`);
      break;
    case 'refuse':
      console.log(`Refused: ${resp.refuse_reason}`);
      break;
    case 'stopped':
      console.log(`Stopped: ${resp.notice}`);
      break;
    case 'logged-manual':
      console.log('Recorded without running (manual mode).');
      break;
    default:
      // A kind newer than this example: log it rather than fail.
      console.log('Unrecognised result:', resp);
  }
}

/** Map the AI-specific errors to a message and an exit code. */
function reportError(err: unknown): number {
  if (err instanceof FeatureUnavailableError) {
    console.error(
      `AI tasks are unavailable on this deployment: ${err.message}\nUse a deployment with bundled Anthropic access or provide a valid BYOK Anthropic key.`,
    );
    return 2;
  }
  if (err instanceof ForbiddenError && err.requiresOwnKey) {
    console.error(
      `${err.model ?? 'This model'} runs only on your own Anthropic key: set DRIFTSTACK_BYOK_ANTHROPIC_API_KEY or pick another model.`,
    );
  } else if (
    err instanceof ByokAnthropicRequiredError ||
    err instanceof BundledLlmConsentRequiredError ||
    err instanceof BundledLlmBudgetExhaustedError
  ) {
    console.error(`No AI key or budget is available: ${err.message}`);
  } else if (err instanceof RateLimitError) {
    console.error(
      `Too many requests or AI tasks at once. Wait ${String(err.retryAfterSeconds)}s, then send again with a new idempotency key.`,
    );
  } else if (err instanceof ConcurrencyLimitError) {
    console.error(`Concurrency limit reached: ${err.message}`);
  } else if (err instanceof ConflictError && err.turnInProgress) {
    console.error('Another message is still running on this session. Wait for it, or stop it.');
  } else if (err instanceof ConflictError && err.sessionStatus !== undefined) {
    console.error(`The session is ${err.sessionStatus}; start a new one.`);
  } else {
    console.error(err);
  }
  return 1;
}

async function main(): Promise<number> {
  let session: AgentSession;
  try {
    session = await client.agentSessions.create(
      { mode: 'ai', token_budget: 100_000 },
      { idempotencyKey: randomUUID(), ...keyOpts },
    );
  } catch (err) {
    return reportError(err);
  }
  console.log(`Created agent session ${session.id}`);

  // A runaway task is stopped after ten minutes; message() then returns kind 'stopped'.
  const stopTimer = setTimeout(() => {
    client.agentSessions.stop(session.id).catch(() => undefined);
  }, 10 * 60_000);
  try {
    session = await waitUntilReady(session);
    if (session.status !== 'active') {
      console.error(
        `The session did not start: status=${session.status} closed_reason=${session.closed_reason ?? 'none'}`,
      );
      return 1;
    }

    console.log(`→ ${task}`);
    let resp = await sendTurn(session.id, task);

    // The agent stops BEFORE a purchase, a payment or an account deletion and
    // waits for approval. Approve by sending the very next message with the
    // approvals (the result objects can be passed as they are).
    const pending =
      resp.kind === 'plan-executed'
        ? resp.results.filter((r): r is PendingApproval => r.kind === 'confirmation_required')
        : [];
    if (pending.length > 0 && approveActions) {
      console.log('Approving and continuing…');
      resp = await sendTurn(session.id, task, pending);
    }
    printOutcome(resp);
    return 0;
  } catch (err) {
    return reportError(err);
  } finally {
    clearTimeout(stopTimer);
    // Always close: an open session keeps counting toward your plan's limit.
    await client.agentSessions.close(session.id).catch((err: unknown) => {
      console.error('Could not close the session:', err);
    });
    console.log('Closed.');
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
