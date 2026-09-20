// run-invoice-task — a nightly job that asks the AI agent to read a figure off a
// supplier portal, screenshots the page, reads the conversation back, and always
// closes its session.
//
// ⛔⛔ THIS FILE IS WRITTEN FROM THE CUSTOMER DOCUMENTATION ONLY — NEVER FROM THE
// SERVER OR THE SDK SOURCE. It is the customer's half of
// `a-program-written-only-from-the-guide-runs-unchanged-against-the-server.test.ts`,
// and it is only worth having while that stays true.
//
// The whole of what may be consulted to write or change it:
//   · apps/docs/src/pages/guides/run-ai-tasks-from-code.md   (start here)
//   · apps/docs/src/pages/api/agent-sessions.md
//   · apps/docs/src/pages/reference/idempotency.md
//   · apps/docs/src/pages/reference/errors.md
//   · apps/docs/src/pages/reference/rate-limits.md
//   · apps/docs/src/pages/sdk/installation.md
//
// If this program cannot do something, or has to guess at it, that is a DOCS or an
// API defect and the docs (or the spec and the SDK) are what gets fixed — reading
// `apps/server/src/**` or `packages/sdk-typescript/src/**` to make it pass would
// destroy the only thing the test measures. Every comment below quotes the page it
// came from, so a reviewer can check that claim without trusting it.
//
// Run it for real:
//   DRIFTSTACK_API_KEY=ds_live_… PROFILE_ID=prof_… npx tsx a-program-written-only-from-the-guide.ts
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  Driftstack,
  ConflictError,
  NotFoundError,
  ProfileInUseError,
  RateLimitError,
  TransportError,
  type AgentIntentResult,
  type AgentMessageResponse,
  type ConsequentialActionCategory,
} from '@driftstack/sdk';

/** What the job is told before it starts. */
export interface JobConfig {
  apiKey: string;
  /** Omitted in production — the SDK knows the API's address. */
  baseUrl?: string;
  /** A profile you signed in to the portal once, by hand. */
  profileId: string;
  /** The task, in plain words. It asks for information, so the agent answers it. */
  task: string;
  /** What the job answers if the agent asks a question part-way. */
  replyToQuestions: string;
  /**
   * Your own Anthropic key, sent with every message. The guide's "Who pays for
   * the AI": a key on the message always wins, and needs only the `write` scope.
   * Omit it on an account that has stored a key or opted in to the included AI.
   */
  ownAnthropicKey?: string;
  /** Leave this off for an unattended job: a person should approve payments. */
  approveActions: boolean;
  /** Ask the agent to stop if one message runs longer than this. */
  stopAfterMs: number;
  /**
   * Carry on by itself when the agent hands back unfinished — but only for the
   * endings whose `notice_reason` the guide says a program may answer on its
   * own. The ones that need a person are never answered automatically.
   */
  continueOnNotice: boolean;
  log: (line: string) => void;
}

/** What the job learned, for the alerting side of the nightly run. */
export interface JobReport {
  sessionId: string;
  outcome: JobOutcome;
  answer?: string;
  answerUnavailable?: string;
  notice?: string;
  /** The same ending in one word, for the alerting side to branch on. */
  noticeReason?: string;
  clarifyingQuestion?: string;
  refuseReason?: string;
  stoppedDuring?: string;
  heldForApproval?: { category: ConsequentialActionCategory; matchedText: string };
  sessionStatus?: string;
  closedReason?: string;
  /** One line per step that ran, over every message this job sent. */
  steps: string[];
  captures: { captureId: string; contentType: string; byteLength: number }[];
  transcript: { index: number; role: string; body: string }[];
  stopStatus?: string;
  /** How many logical messages were sent, and how many HTTP sends they cost. */
  messagesSent: number;
  messageAttempts: number;
}

export type JobOutcome =
  /** Done, and it answered the question. */
  | 'answered'
  /** Done, and it says in one sentence why there is no answer. */
  | 'answer-unavailable'
  /** Done. The task only asked for actions, so there is nothing to answer. */
  | 'done-no-answer'
  /** Not finished: it stopped at a limit, or asked something part-way. */
  | 'not-finished'
  /** A step failed, and the turn did not recover. */
  | 'step-failed'
  /** A purchase, payment or account deletion is held; a person must decide. */
  | 'needs-a-person'
  /** It is still asking a question. */
  | 'still-asking'
  /** It would not do the task, or the AI was briefly unavailable. */
  | 'refused'
  /** We stopped it. */
  | 'stopped'
  /** The session was closed or paused, so the message did not run. */
  | 'session-ended';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One step, for the log. `diagnosis` is optional — check before reading it. */
function describe(result: AgentIntentResult): string {
  switch (result.kind) {
    case 'success':
      return result.captureId === undefined
        ? `done: ${result.summary}`
        : `done: ${result.summary} (screenshot ${result.captureId})`;
    case 'failure':
      // An unrecognised `diagnosis.category` is read as `unknown`; decide on
      // `retryable`, and never repeat a `retryable: false` step automatically.
      return `failed: ${result.reason} [${result.diagnosis?.category ?? 'unknown'}, retryable=${String(
        result.diagnosis?.retryable ?? false,
      )}]`;
    case 'confirmation_required':
      return `held for approval: ${result.category} "${result.matchedText}"`;
  }
}

/**
 * The refusals this job retries BY ITSELF, under the same Idempotency-Key: the
 * rows of the docs' "a refusal that did no work" table whose cause clears on its
 * own, plus the lost-response case. Nothing ran, so the server gives the key back
 * and the same request runs the turn once the cause is gone.
 *
 * That table has four more rows that also give the key back: the two 402s about
 * Driftstack's included AI, the 403 about the plan or the model, and the 502 with
 * no Anthropic key. Waiting does not clear those — a person has to add a key, opt
 * in, raise the cap or change the plan — so an unattended job surfaces them
 * instead, and whoever fixes the cause may send the SAME key afterwards.
 *
 * Every OTHER answer is final for its key: sending it again replays the stored
 * answer instead of doing the work. (Guide, "Errors and safe retries";
 * reference/idempotency.md, "refusals that free their key".)
 */
function sameKeyIsStillSafe(err: unknown): boolean {
  // No response at all — the connection dropped, or the process restarted.
  if (err instanceof TransportError) return true;
  // The request rate, or too many AI messages running at once. No step ran.
  if (err instanceof RateLimitError) return true;
  if (err instanceof ConflictError) {
    // The first attempt with this key is still running.
    if (err.extensions['idempotency_status'] === 'in_progress') return true;
    // Another message is still running on this session.
    if (err.extensions['turn_in_progress'] === true) return true;
  }
  return false;
}

/** How long to wait before sending the same key again. */
function waitBeforeRetry(err: unknown, attempt: number): number {
  if (err instanceof RateLimitError && typeof err.retryAfterSeconds === 'number') {
    return Math.max(err.retryAfterSeconds, 1) * 1_000;
  }
  return Math.min(500 * attempt, 5_000);
}

/**
 * What the guide's `notice_reason` table says to do about an unfinished turn.
 *
 * ⛔ The default matters more than any of the cases. The guide says the list is
 * OPEN — a turn may one day end a way this job has never heard of — and that an
 * older server sends `notice` with no reason at all. Both land here, and both
 * are handled the way the guide handles the endings it cannot answer for you:
 * show the sentence and let a person decide.
 */
function whatToDoAbout(
  noticeReason: string | undefined,
): 'continue' | 'answer' | 'new-session' | 'ask-a-person' {
  switch (noticeReason) {
    // "Send continue."
    case 'step_limit':
    case 'time_limit':
    case 'ai_unavailable':
      return 'continue';
    // "Check the page, then send continue only if it is safe." An unattended
    // job cannot check the page, so this one is a person's call.
    case 'repeated_step':
      return 'ask-a-person';
    // "Start a new session and carry on there."
    case 'budget_low':
      return 'new-session';
    // "Answer it as the next message" — the same answer a `clarify` gets.
    case 'question':
      return 'answer';
    // no_progress, declined, anything newer, and no reason at all.
    default:
      return 'ask-a-person';
  }
}

/** The session was not active, or ended mid-message. No retry can fix it. */
export class SessionEndedError extends Error {
  constructor(
    readonly sessionStatus: string,
    readonly closedReason: string | undefined,
    /** Steps that did run before the session ended. Check them before repeating work. */
    readonly partialResults: unknown,
  ) {
    super(
      `the session is ${sessionStatus}${closedReason === undefined ? '' : ` (${closedReason})`}`,
    );
    this.name = 'SessionEndedError';
  }
}

export async function runInvoiceTask(config: JobConfig): Promise<JobReport> {
  const client = new Driftstack({
    apiKey: config.apiKey,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
  });
  const log = config.log;
  const ownKey = config.ownAnthropicKey === undefined ? {} : { byokApiKey: config.ownAnthropicKey };

  // A new session is `provisioning` until its browser is ready: poll every 2
  // seconds, give up after about two minutes.
  async function waitUntilReady(id: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const session = await client.agentSessions.get(id);
      if (session.status === 'active') return;
      if (session.status === 'closed') {
        throw new Error(`the session ended before it was ready: ${String(session.closed_reason)}`);
      }
      await sleep(2_000);
    }
    throw new Error('the session was not ready after two minutes');
  }

  let messagesSent = 0;
  let messageAttempts = 0;

  /** One logical message = one Idempotency-Key, kept across every retry of it. */
  async function send(
    id: string,
    text: string,
    approvals: { category: ConsequentialActionCategory; matchedText: string }[] = [],
  ): Promise<AgentMessageResponse> {
    const idempotencyKey = randomUUID();
    messagesSent += 1;
    // message() waits until the task ends, so the stop has to come from somewhere
    // else. If it runs too long, ask it to stop; this message then returns
    // kind "stopped" with the steps that ran.
    const stopTimer = setTimeout(() => {
      client.agentSessions.stop(id).catch(() => undefined);
    }, config.stopAfterMs);
    try {
      for (let attempt = 1; ; attempt++) {
        messageAttempts += 1;
        try {
          return await client.agentSessions.message(id, text, {
            idempotencyKey,
            ...ownKey,
            ...(approvals.length > 0 ? { approveConsequentialActions: approvals } : {}),
            onStep: ({ index, result }) => {
              log(`  step ${String(index + 1)}: ${describe(result)}`);
            },
            onEvent: ({ type, data }) => {
              if (type === 'step_start') log(`  now: ${(data as { label: string }).label}`);
            },
          });
        } catch (err) {
          if (
            err instanceof ConflictError &&
            typeof err.extensions['session_status'] === 'string'
          ) {
            throw new SessionEndedError(
              err.extensions['session_status'],
              typeof err.extensions['closed_reason'] === 'string'
                ? err.extensions['closed_reason']
                : undefined,
              err.extensions['partial_results'],
            );
          }
          if (sameKeyIsStillSafe(err) && attempt < 6) {
            log(`  nothing ran (${(err as Error).name}); sending the same key again`);
            await sleep(waitBeforeRetry(err, attempt));
            continue;
          }
          // Final for this key. A new logical message needs a new key.
          throw err;
        }
      }
    } finally {
      clearTimeout(stopTimer);
    }
  }

  // An Idempotency-Key so a retried create returns the same session, not a second one.
  const session = await client.agentSessions.create(
    { mode: 'ai', profile_id: config.profileId, token_budget: 100_000 },
    { idempotencyKey: randomUUID() },
  );
  const report: JobReport = {
    sessionId: session.id,
    outcome: 'done-no-answer',
    steps: [],
    captures: [],
    transcript: [],
    messagesSent: 0,
    messageAttempts: 0,
  };
  const id = session.id;

  try {
    // `active` — ready. `provisioning` — poll. `closed` — it could not start.
    if (session.status === 'closed') {
      throw new Error(`the session could not start: ${String(session.closed_reason)}`);
    }
    if (session.status !== 'active') await waitUntilReady(id);

    const captureIds: string[] = [];
    /** Read steps from `results`, never from `intents`. */
    const collect = (reply: AgentMessageResponse): void => {
      if (reply.kind !== 'plan-executed' && reply.kind !== 'stopped') return;
      for (const step of reply.results) {
        report.steps.push(describe(step));
        if (step.kind === 'success' && step.captureId !== undefined) {
          if (!captureIds.includes(step.captureId)) captureIds.push(step.captureId);
        }
      }
    };

    let reply: AgentMessageResponse;
    try {
      reply = await send(id, config.task);
    } catch (err) {
      if (err instanceof SessionEndedError) {
        report.outcome = 'session-ended';
        report.sessionStatus = err.sessionStatus;
        report.closedReason = err.closedReason;
        log(`The message did not run: ${err.message}`);
        return report;
      }
      throw err;
    }
    collect(reply);

    let continuesSent = 0;
    const approvals: { category: ConsequentialActionCategory; matchedText: string }[] = [];

    // Up to four follow-ups: an answer to a question, a "continue", or an approval.
    for (let followUps = 0; followUps < 4; followUps++) {
      if (reply.kind === 'clarify') {
        // It needs more information before it starts. Send the answer as the next message.
        log(`The agent asked: ${reply.clarifying_question}`);
        reply = await send(id, config.replyToQuestions);
        collect(reply);
        continue;
      }
      if (reply.kind !== 'plan-executed') break;

      const last = reply.results.at(-1);
      if (last?.kind === 'confirmation_required') {
        if (!config.approveActions) {
          // In an unattended job, do not approve automatically: alert a person.
          log(`A person must approve: ${last.category} "${last.matchedText}"`);
          report.heldForApproval = { category: last.category, matchedText: last.matchedText };
          break;
        }
        // Approve by sending the same message again as the VERY NEXT message on
        // the session, with a new key and the approval. If anything comes in
        // between, the approval no longer applies.
        approvals.push({ category: last.category, matchedText: last.matchedText });
        reply = await send(id, config.task, approvals);
        collect(reply);
        continue;
      }

      if (reply.notice !== undefined && config.continueOnNotice && continuesSent < 2) {
        // Not finished — it stopped at a limit, or asked something part-way.
        // `notice_reason` says which, so the job does not have to read English.
        const next = whatToDoAbout(reply.notice_reason);
        log(`Not finished yet (${reply.notice_reason ?? 'no reason given'}): ${reply.notice}`);
        if (next === 'ask-a-person') {
          // no_progress, declined, a reason this job has never heard of, and an
          // older server that sends no reason at all: show the sentence to a
          // person rather than replying to it.
          log('A person should decide what to try next.');
          break;
        }
        if (next === 'new-session') {
          // budget_low: this session has too little AI budget left, so sending
          // anything more to it only spends what is left for nothing.
          log('This session is out of AI budget; carry on in a new one.');
          break;
        }
        continuesSent += 1;
        reply = await send(id, next === 'answer' ? config.replyToQuestions : 'continue');
        collect(reply);
        continue;
      }
      break;
    }

    // What came back, decided in the order the guide gives: notice, then ok, then
    // answer or answer_unavailable.
    switch (reply.kind) {
      case 'plan-executed': {
        if (reply.answer !== undefined) report.answer = reply.answer;
        if (reply.answer_unavailable !== undefined) {
          // Open text: show it, do not match on it.
          report.answerUnavailable = reply.answer_unavailable;
        }
        if (reply.notice !== undefined) report.notice = reply.notice;
        if (reply.notice_reason !== undefined) report.noticeReason = reply.notice_reason;

        if (report.heldForApproval !== undefined) report.outcome = 'needs-a-person';
        else if (reply.notice !== undefined) report.outcome = 'not-finished';
        else if (!reply.ok) report.outcome = 'step-failed';
        else if (reply.answer !== undefined) report.outcome = 'answered';
        else if (reply.answer_unavailable !== undefined) report.outcome = 'answer-unavailable';
        else report.outcome = 'done-no-answer';
        break;
      }
      case 'clarify':
        report.outcome = 'still-asking';
        report.clarifyingQuestion = reply.clarifying_question;
        break;
      case 'refuse':
        // Either the agent declining, or the AI briefly unavailable. Either way the
        // session stays active, and this answer is stored against the key that got
        // it — a retry of the task needs a NEW key.
        report.outcome = 'refused';
        report.refuseReason = reply.refuse_reason;
        break;
      case 'stopped':
        report.outcome = 'stopped';
        report.notice = reply.notice;
        report.stoppedDuring = reply.stopped_during;
        break;
      default:
        log(`Unexpected result: ${String((reply as { kind: string }).kind)}`);
        break;
    }
    log(`Outcome: ${report.outcome}`);
    if (report.answer !== undefined) log(`Answer: ${report.answer}`);
    if (report.answerUnavailable !== undefined) log(`No answer: ${report.answerUnavailable}`);
    if (report.notice !== undefined) {
      log(`Notice (${report.noticeReason ?? 'no reason given'}): ${report.notice}`);
    }
    if (report.refuseReason !== undefined) log(`Refused: ${report.refuseReason}`);

    // Screenshots work only while the session is open, so fetch before closing.
    // Only the 20 most recent are kept; an unknown or expired id is a 404.
    for (const captureId of captureIds) {
      try {
        const shot = await client.agentSessions.getCapture(id, captureId);
        report.captures.push({
          captureId,
          contentType: shot.contentType,
          byteLength: shot.bytes.byteLength,
        });
        log(
          `  screenshot ${captureId}: ${shot.contentType}, ${String(shot.bytes.byteLength)} bytes`,
        );
      } catch (err) {
        if (err instanceof NotFoundError) {
          log(`  screenshot ${captureId} is gone (unknown or expired)`);
          continue;
        }
        throw err;
      }
    }

    // The whole conversation. transcript() replays what is recorded and then
    // follows the session live, so it does not end by itself: take
    // transcript_length from get() first and leave the loop at the last entry,
    // which closes the connection.
    const now = await client.agentSessions.get(id);
    if (now.transcript_length > 0) {
      for await (const { index, entry } of client.agentSessions.transcript(id)) {
        report.transcript.push({ index, role: entry.role, body: entry.body });
        log(`  [${String(index)}] ${entry.role}: ${entry.body.slice(0, 80)}`);
        if (index === now.transcript_length - 1) break;
      }
    }

    // Stopping is safe to repeat, and safe when nothing is running: it answers
    // `no_turn_running` then, and the session stays open for the next message.
    const stopped = await client.agentSessions.stop(id);
    report.stopStatus = stopped.status;
    log(`Stop: ${stopped.status}`);

    return report;
  } finally {
    report.messagesSent = messagesSent;
    report.messageAttempts = messageAttempts;
    // Always close: it frees an open-session slot and saves the profile's sign-in.
    await client.agentSessions.close(id);
  }
}

/* eslint-disable no-console -- from here down this file is a SCRIPT, not library
   code: the repository's marker for output a person is meant to read. */

/** The nightly job, wired from the environment. */
export async function main(): Promise<void> {
  const report = await runInvoiceTask({
    apiKey: process.env['DRIFTSTACK_API_KEY'] ?? '',
    profileId: process.env['PROFILE_ID'] ?? '',
    task:
      'Open https://portal.example.com/invoices, take a screenshot of the September 2026 ' +
      'invoice and tell me its total amount. If you see a sign-in page, stop and tell me.',
    replyToQuestions: 'Use the invoice dated September 2026. Do not pay anything.',
    ...(process.env['ANTHROPIC_API_KEY'] === undefined
      ? {}
      : { ownAnthropicKey: process.env['ANTHROPIC_API_KEY'] }),
    approveActions: process.env['APPROVE_ACTIONS'] === 'yes',
    stopAfterMs: 10 * 60_000,
    continueOnNotice: true,
    log: (line) => {
      console.log(line);
    },
  });
  console.log(JSON.stringify(report, null, 2));
}

/* c8 ignore start — the command-line entry point, not reached from the test */
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  main().catch((err: unknown) => {
    if (err instanceof ProfileInUseError) {
      console.error(
        `The profile is in use by ${String(err.activeSessionId)}; close that one first.`,
      );
    } else if (err instanceof RateLimitError) {
      console.error(`Too many requests; try again in ${String(err.retryAfterSeconds)}s.`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
