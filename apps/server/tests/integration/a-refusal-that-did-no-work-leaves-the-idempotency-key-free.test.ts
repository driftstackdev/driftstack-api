// A refusal that did no work leaves the Idempotency-Key free.
//
// With an Idempotency-Key, the first definite result of a message is stored and
// every later request with that key replays it. That is what makes a retry safe:
// a task can never run twice. It was also applied to refusals raised BEFORE the
// turn did anything at all — "another turn is still running", "too many turns
// running", "opt in first", "add a key first" — so the natural next move, waiting
// or fixing the cause and sending the SAME request again, replayed the refusal
// for ever.
//
// For exactly those refusals the key is now released instead: nothing was stored,
// so the same key can be sent again and the turn runs. Anything that STARTED WORK
// — a planning call, a step on the page — stays final, exactly as before.
//
// Each refusal is proved the same way, because the claim is the same: refuse with
// a key, remove the cause, send the identical request with the identical key, and
// the turn runs — ONCE. The last block proves the other half: a failure after
// work started is still replayed, and the task is not run a second time.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
// The wait this refusal hands out is the route's own constant, never a number
// written here — see the-wait-after-an-ai-turn-limit-is-one-number.test.ts.
import { AI_TURNS_RUNNING_RETRY_AFTER_SECONDS } from '../../src/routes/agent-sessions.js';

const OWN_KEY = 'sk-ant-api03-idempotent-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TASK = 'open https://example.com and capture';
const HOLD = 'HOLD this turn open until the test lets it finish';

/**
 * Plans every task at once, except HOLD, which stays in planning until
 * `release()` — a turn that is genuinely still running, for as long as a test
 * needs one. Counts its calls so "ran once" is measured, not assumed.
 */
class CountingPlanner implements AgentDecomposer {
  readonly tasksPlanned: string[] = [];
  private readonly held: Array<() => void> = [];
  /** Set to make the NEXT planning call fail the way a provider failure does. */
  failNextWith: Error | undefined;

  decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    this.tasksPlanned.push(args.task);
    const plan: DecomposeResult = {
      kind: 'plan',
      intents: [
        { kind: 'navigate', url: 'https://example.com/' },
        { kind: 'capture', capture: 'screenshot' },
      ],
      tokensConsumed: 10,
    };
    if (this.failNextWith !== undefined) {
      const error = this.failNextWith;
      this.failNextWith = undefined;
      return Promise.reject(error);
    }
    if (args.task !== HOLD) return Promise.resolve(plan);
    return new Promise<DecomposeResult>((resolve) => {
      this.held.push(() => {
        resolve(plan);
      });
    });
  }

  get holding(): number {
    return this.held.length;
  }

  release(): void {
    for (const finish of this.held.splice(0)) finish();
  }

  timesPlanned(task: string): number {
    return this.tasksPlanned.filter((t) => t === task).length;
  }
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Problem {
  type: string;
  status: number;
  instance?: string;
  turn_in_progress?: boolean;
  idempotency_status?: string;
  requires_own_key?: boolean;
}

describe('a refusal that did no work leaves the Idempotency-Key free', () => {
  let fx: TestAppFixture;
  let planner: CountingPlanner;

  afterEach(async () => {
    planner?.release();
    vi.restoreAllMocks();
    if (fx) await fx.cleanup();
  });

  const build = async (extra: Parameters<typeof buildTestApp>[0] = {}): Promise<void> => {
    planner = new CountingPlanner();
    fx = await buildTestApp({ enableAgentRuntime: true, agentDecomposer: planner, ...extra });
  };

  const createSession = async (
    payload: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<string> => {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { token_budget: 50_000, ...payload },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  };

  const send = (
    id: string,
    key: string | undefined,
    headers: Record<string, string> = {},
    userMessage: string = TASK,
  ) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        ...(key !== undefined ? { 'idempotency-key': key } : {}),
        ...headers,
      },
      payload: { user_message: userMessage },
    });

  /** The key really is free: the same request runs, and then it is a normal key
   *  again — a third send replays the turn instead of running it a second time. */
  const expectTheSameKeyNowRunsTheTurnOnce = async (
    id: string,
    key: string,
    headers: Record<string, string> = {},
  ): Promise<void> => {
    const before = planner.timesPlanned(TASK);
    const ran = await send(id, key, headers);
    expect(ran.statusCode, 'the same key runs the turn once the cause is gone').toBe(200);
    expect(ran.json<{ kind: string }>().kind).toBe('plan-executed');
    expect(planner.timesPlanned(TASK)).toBe(before + 1);

    const replay = await send(id, key, headers);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(ran.json());
    expect(planner.timesPlanned(TASK), 'a finished turn is replayed, never re-run').toBe(
      before + 1,
    );
  };

  describe('refusals raised before the turn did anything release the key', () => {
    it('CRITICAL another turn is still running on the session (409 turn_in_progress): once it finishes, the same key runs the turn', async () => {
      await build();
      const id = await createSession();
      const running = send(id, undefined, {}, HOLD);
      await until(() => planner.holding === 1, 'the first turn to be planning');

      const refused = await send(id, 'key-turn-in-progress');
      expect(refused.statusCode).toBe(409);
      expect(refused.json<Problem>().turn_in_progress).toBe(true);
      // Still refused while the other turn runs — and still not stored.
      expect((await send(id, 'key-turn-in-progress')).statusCode).toBe(409);
      expect(planner.timesPlanned(TASK)).toBe(0);

      planner.release();
      expect((await running).statusCode).toBe(200);
      await expectTheSameKeyNowRunsTheTurnOnce(id, 'key-turn-in-progress');
    });

    it('CRITICAL the account already has its maximum number of AI turns running (429 rate-limited): once one finishes, the same key runs the turn', async () => {
      await build();
      const busy = [await createSession(), await createSession(), await createSession()];
      const id = await createSession();
      const running = busy.map((sessionId) => send(sessionId, undefined, {}, HOLD));
      await until(() => planner.holding === 3, 'three turns to be planning');

      const refused = await send(id, 'key-account-turn-limit');
      expect(refused.statusCode).toBe(429);
      expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.RateLimited);
      expect(refused.headers['retry-after']).toBe(String(AI_TURNS_RUNNING_RETRY_AFTER_SECONDS));

      planner.release();
      for (const turn of running) expect((await turn).statusCode).toBe(200);
      await expectTheSameKeyNowRunsTheTurnOnce(id, 'key-account-turn-limit');
    });

    it('too many turns running on Driftstack’s included AI (429 rate-limited): once a slot frees, the same key runs the turn', async () => {
      await build({
        enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 },
        bundledTurnMaxConcurrency: 1,
      });
      const id = await createSession();
      expect(fx.bundledTurnConcurrency.tryAcquire(fx.accountId)).toBe(true);

      const refused = await send(id, 'key-included-ai-ceiling');
      expect(refused.statusCode).toBe(429);
      expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.RateLimited);

      fx.bundledTurnConcurrency.release(fx.accountId);
      await expectTheSameKeyNowRunsTheTurnOnce(id, 'key-included-ai-ceiling');
    });

    it('the monthly budget for Driftstack’s included AI is used up (402): once the cap is raised, the same key runs the turn', async () => {
      await build({ enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 } });
      const id = await createSession();
      fx.bundledLlmRepo.addSpend(fx.accountId, new Date(), 2_000);

      const refused = await send(id, 'key-budget-used-up');
      expect(refused.statusCode).toBe(402);
      expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.BundledLlmBudgetExhausted);

      const raise = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { monthly_cap_usd_cents: 5_000 },
      });
      expect(raise.statusCode).toBe(200);
      await expectTheSameKeyNowRunsTheTurnOnce(id, 'key-budget-used-up');
    });

    it('the account has not opted in to Driftstack’s included AI (402): once it opts in, the same key runs the turn', async () => {
      await build({
        agentDecomposerKind: 'claude',
        enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
      });
      const id = await createSession();

      const refused = await send(id, 'key-not-opted-in');
      expect(refused.statusCode).toBe(402);
      expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.BundledLlmConsentRequired);

      const optIn = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { consent: true },
      });
      expect(optIn.statusCode).toBe(200);
      await expectTheSameKeyNowRunsTheTurnOnce(id, 'key-not-opted-in');
    });

    it('CRITICAL there is no AI key to run on (502 byok-anthropic-required): the same key, sent again WITH a key, runs the turn', async () => {
      await build({ agentDecomposerKind: 'claude' });
      const id = await createSession();

      const refused = await send(id, 'key-no-ai-key');
      expect(refused.statusCode).toBe(502);
      expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);

      await expectTheSameKeyNowRunsTheTurnOnce(id, 'key-no-ai-key', {
        'x-byok-anthropic-api-key': OWN_KEY,
      });
    });

    it('the plan no longer includes Driftstack’s included AI (403): once the plan does, the same key runs the turn', async () => {
      await build({
        agentDecomposerKind: 'claude',
        enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 },
      });
      const id = await createSession();
      const live = await fx.authRepo.getAccount(fx.accountId);
      if (live === null) throw new Error('fixture account missing');
      fx.authRepo.upsertAccount({ ...live, tier: 'team_manual' });

      const refused = await send(id, 'key-plan-ineligible');
      expect(refused.statusCode).toBe(403);
      expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.Forbidden);

      fx.authRepo.upsertAccount({ ...live, tier: 'api_builder' });
      await expectTheSameKeyNowRunsTheTurnOnce(id, 'key-plan-ineligible');
    });

    it('the session’s model runs only on the customer’s own key (403 requires_own_key): the same key, sent again WITH a key, runs the turn', async () => {
      await build({
        agentDecomposerKind: 'claude',
        enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 },
      });
      // Created with the customer's own key, so the model is accepted; the turn
      // below is sent without one, and would run on Driftstack's included AI.
      const id = await createSession(
        { model: 'claude-opus-5' },
        { 'x-byok-anthropic-api-key': OWN_KEY },
      );

      const refused = await send(id, 'key-own-key-only-model');
      expect(refused.statusCode).toBe(403);
      expect(refused.json<Problem>().requires_own_key).toBe(true);

      await expectTheSameKeyNowRunsTheTurnOnce(id, 'key-own-key-only-model', {
        'x-byok-anthropic-api-key': OWN_KEY,
      });
    });

    it('the streamed turn releases the key the same way', async () => {
      await build({ agentDecomposerKind: 'claude' });
      const id = await createSession();
      const stream = { accept: 'text/event-stream' };

      const refused = await send(id, 'key-streamed', stream);
      expect(refused.body).toContain('"status":502');

      const ran = await send(id, 'key-streamed', {
        ...stream,
        'x-byok-anthropic-api-key': OWN_KEY,
      });
      expect(ran.body).toContain('"status":200');
      expect(ran.body).toContain('"kind":"plan-executed"');
      expect(planner.timesPlanned(TASK)).toBe(1);
    });
  });

  describe('anything that started work stays final: the key replays it, and the task never runs twice', () => {
    it('CRITICAL a turn whose planning call was made and then failed is replayed, and the planner is not called a second time', async () => {
      await build();
      const id = await createSession();
      planner.failNextWith = new Error('Anthropic API 400: {"type":"error"}');

      const first = await send(id, 'key-planning-failed', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(first.statusCode).toBe(500);
      expect(planner.timesPlanned(TASK)).toBe(1);

      // The planner would succeed now. It must not be asked.
      const replay = await send(id, 'key-planning-failed', {
        'x-byok-anthropic-api-key': OWN_KEY,
      });
      expect(replay.statusCode).toBe(500);
      expect(replay.json()).toEqual(first.json());
      expect(planner.timesPlanned(TASK)).toBe(1);
    });

    it('CRITICAL a rejected own key is final too: the planning call was made, so the same key replays the refusal rather than planning again', async () => {
      await build();
      const id = await createSession();
      planner.failNextWith = new Error('Anthropic API 401: {"type":"error"}');

      const first = await send(id, 'key-own-key-rejected', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(first.statusCode).toBe(502);
      const replay = await send(id, 'key-own-key-rejected', {
        'x-byok-anthropic-api-key': `${OWN_KEY}-replaced`,
      });
      expect(replay.statusCode).toBe(502);
      expect(replay.json()).toEqual(first.json());
      expect(planner.timesPlanned(TASK)).toBe(1);

      // A NEW key is how this message is tried again.
      const retried = await send(id, 'key-own-key-rejected-2', {
        'x-byok-anthropic-api-key': `${OWN_KEY}-replaced`,
      });
      expect(retried.statusCode).toBe(200);
    });

    it('CRITICAL a turn whose steps RAN on the page and which then failed is replayed: the steps are not run again', async () => {
      await build();
      const id = await createSession();
      const repo = fx.agentSessionsRepo;
      if (repo === undefined) throw new Error('fixture has no agent sessions repo');
      // Let the customer's message be recorded, then fail the write that records
      // the executed plan — after every step has run on the page.
      const realAppend = repo.appendTranscriptIfAuthorityRevision.bind(repo);
      let appends = 0;
      vi.spyOn(repo, 'appendTranscriptIfAuthorityRevision').mockImplementation((...args) => {
        appends += 1;
        if (appends === 2) return Promise.reject(new Error('storage went away'));
        return realAppend(...args);
      });

      const first = await send(id, 'key-failed-after-steps', {
        'x-byok-anthropic-api-key': OWN_KEY,
      });
      expect(first.statusCode).toBe(500);
      expect(planner.timesPlanned(TASK)).toBe(1);

      const replay = await send(id, 'key-failed-after-steps', {
        'x-byok-anthropic-api-key': OWN_KEY,
      });
      expect(replay.statusCode).toBe(500);
      expect(replay.json()).toEqual(first.json());
      expect(planner.timesPlanned(TASK), 'the task must never run twice').toBe(1);
    });

    it('a message to a session that is already closed is final, as it always was: the same key replays the same 409', async () => {
      await build();
      const id = await createSession();
      await fx.app.inject({
        method: 'DELETE',
        url: `/v1/agent-sessions/${id}`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      const first = await send(id, 'key-closed-session');
      const replay = await send(id, 'key-closed-session');
      expect(first.statusCode).toBe(409);
      expect(replay.json()).toEqual(first.json());
    });

    it('a released key is not a wildcard: reusing it for a DIFFERENT message while the first is still refused is simply that message’s own first use', async () => {
      await build({ agentDecomposerKind: 'claude' });
      const id = await createSession();
      expect((await send(id, 'key-reused')).statusCode).toBe(502);
      // Nothing was stored for the key, so there is nothing to mismatch against:
      // the other message is refused on its own merits, not as a key conflict.
      const other = await send(id, 'key-reused', {}, 'a different message');
      expect(other.statusCode).toBe(502);
      expect(other.json<Problem>().idempotency_status).toBeUndefined();
    });
  });
});
