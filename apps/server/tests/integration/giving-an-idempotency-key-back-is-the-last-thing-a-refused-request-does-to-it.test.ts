// Giving an Idempotency-Key back is the LAST thing a refused request does to it.
//
// A refusal raised before the turn did any work releases its Idempotency-Key, so
// the same key can run the turn once the cause is gone (see
// a-refusal-that-did-no-work-leaves-the-idempotency-key-free). This file is about
// the two ways that release could let a task run TWICE, which is the one thing an
// Idempotency-Key exists to prevent.
//
// 1. A RELEASE THAT FAILS IS AMBIGUOUS. The store can reject after the key was in
//    fact given back (the write landed, the acknowledgement did not). From that
//    instant the key is free, and the customer's retry — same key, same request —
//    may already hold it and be mid-turn. A receipt is identified by account, key,
//    session and request, ALL of which that retry shares, so a refused request
//    that went on to store its refusal "instead" would stamp "nothing ran, try
//    again" onto the retry's running turn: the retry's own result then cannot be
//    stored, the key replays a refusal for a task that RAN, and the customer's
//    next move (a new key) runs it a second time. So after a release is attempted
//    the refused request answers and never touches the receipt again.
//
// 2. ONLY THE REQUEST THAT RESERVED A KEY MAY GIVE IT BACK. A second request with
//    the same key, arriving while the first is mid-turn, is told the first is
//    still in progress. It must release nothing: the reservation is the running
//    turn's, and removing it would let a third request run the task again.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWN_KEY = 'sk-ant-api03-giveback-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TASK = 'open https://example.com and capture';

/** Holds every planning call open until `finish()`, and counts them. */
class HeldPlanner implements AgentDecomposer {
  readonly tasksPlanned: string[] = [];
  private readonly held: Array<() => void> = [];
  hold = false;

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
    if (!this.hold) return Promise.resolve(plan);
    return new Promise<DecomposeResult>((resolve) => {
      this.held.push(() => {
        resolve(plan);
      });
    });
  }

  get holding(): number {
    return this.held.length;
  }

  finish(): void {
    this.hold = false;
    for (const done of this.held.splice(0)) done();
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
  idempotency_status?: string;
}

describe('giving an Idempotency-Key back is the last thing a refused request does to it', () => {
  let fx: TestAppFixture;
  let planner: HeldPlanner;

  afterEach(async () => {
    planner?.finish();
    vi.restoreAllMocks();
    if (fx) await fx.cleanup();
  });

  const build = async (extra: Parameters<typeof buildTestApp>[0] = {}): Promise<void> => {
    planner = new HeldPlanner();
    fx = await buildTestApp({ enableAgentRuntime: true, agentDecomposer: planner, ...extra });
  };

  const createSession = async (): Promise<string> => {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  };

  const send = (id: string, key: string, headers: Record<string, string> = {}) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': key, ...headers },
      payload: { user_message: TASK },
    });

  const receipts = () => {
    const repo = fx.agentTurnReceiptsRepo;
    if (repo === undefined) throw new Error('fixture has no receipts store');
    return repo;
  };

  describe('a release that fails is ambiguous, so the refused request never writes to the key again', () => {
    it('CRITICAL a retry that took the freed key while the release was still failing keeps its reservation: the refusal is never stamped over its running turn, its result is the one the key replays, and the task runs once', async () => {
      await build({ agentDecomposerKind: 'claude' });
      const id = await createSession();
      const store = receipts();
      const realRelease = store.release.bind(store);
      let keyIsFree = false;
      let letTheReleaseFail: () => void = () => {};
      const acknowledgementLost = new Promise<void>((resolve) => {
        letTheReleaseFail = resolve;
      });
      vi.spyOn(store, 'release').mockImplementationOnce(async (args) => {
        // The write lands: the key IS free from here on…
        await realRelease(args);
        keyIsFree = true;
        // …but the store only reports failure, and only later.
        await acknowledgementLost;
        throw new Error('connection lost after the release committed');
      });
      const complete = vi.spyOn(store, 'complete');

      // Refused before any work: there is no AI key to run on.
      const refused = send(id, 'key-given-back');
      await until(() => keyIsFree, 'the release to land');

      // The customer's retry: same key, same request, now WITH a key. It reserves
      // the freed key and is mid-turn when the first request's release "fails".
      planner.hold = true;
      const retry = send(id, 'key-given-back', { 'x-byok-anthropic-api-key': OWN_KEY });
      await until(() => planner.holding === 1, 'the retry to be planning');
      letTheReleaseFail();

      const refusal = await refused;
      expect(refusal.statusCode).toBe(502);
      expect(refusal.json<Problem>().type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);
      // Read now, before the retry's own (legitimate) completion is counted.
      const storedByTheRefusedRequest = complete.mock.calls.length;

      planner.finish();
      const ran = await retry;
      expect(ran.statusCode, 'the retry ran the task and must be told so').toBe(200);
      expect(ran.json<{ kind: string }>().kind).toBe('plan-executed');

      // The key now replays the turn that RAN — never "nothing ran, try again".
      const replay = await send(id, 'key-given-back', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(ran.json());
      expect(planner.tasksPlanned, 'the task must never run twice').toHaveLength(1);
      expect(
        storedByTheRefusedRequest,
        'a refused request that tried to give its key back must not store anything under it',
      ).toBe(0);
    });

    it('a release that failed AFTER the key was given back still answers the refusal, not a 500, and the same key then runs the turn once', async () => {
      await build({ agentDecomposerKind: 'claude' });
      const id = await createSession();
      const store = receipts();
      const realRelease = store.release.bind(store);
      vi.spyOn(store, 'release').mockImplementationOnce(async (args) => {
        await realRelease(args);
        throw new Error('connection lost after the release committed');
      });

      const refused = await send(id, 'key-ack-lost');
      expect(refused.statusCode).toBe(502);
      expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);

      const ran = await send(id, 'key-ack-lost', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(ran.statusCode).toBe(200);
      const replay = await send(id, 'key-ack-lost', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(replay.json()).toEqual(ran.json());
      expect(planner.tasksPlanned).toHaveLength(1);
    });

    it('a release that failed BEFORE the key was given back still answers the refusal and stores nothing: the key then says its first request is unresolved, which is true and safe, rather than replaying a refusal whose cause is gone', async () => {
      await build({ agentDecomposerKind: 'claude' });
      const id = await createSession();
      const store = receipts();
      vi.spyOn(store, 'release').mockRejectedValueOnce(new Error('storage unavailable'));
      const complete = vi.spyOn(store, 'complete');

      const refused = await send(id, 'key-not-given-back');
      expect(refused.statusCode).toBe(502);
      expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.ByokAnthropicRequired);
      expect(complete).not.toHaveBeenCalled();

      const again = await send(id, 'key-not-given-back', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(again.statusCode).toBe(409);
      expect(again.json<Problem>().idempotency_status).toBe('in_progress');
      expect(planner.tasksPlanned, 'an unresolved key never runs anything').toHaveLength(0);
    });
  });

  describe('only the request that reserved a key may give it back', () => {
    it('CRITICAL a second request with the SAME key while the first is mid-turn is told in_progress and releases nothing: the first turn’s result is stored, the key replays it, and the task runs once', async () => {
      await build();
      const id = await createSession();
      const release = vi.spyOn(receipts(), 'release');

      planner.hold = true;
      const first = send(id, 'key-mid-turn', { 'x-byok-anthropic-api-key': OWN_KEY });
      await until(() => planner.holding === 1, 'the first turn to be planning');

      // Same key, same request, on both lanes, while the first is still running.
      const second = await send(id, 'key-mid-turn', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(second.statusCode).toBe(409);
      expect(second.json<Problem>().idempotency_status).toBe('in_progress');
      const streamed = await send(id, 'key-mid-turn', {
        'x-byok-anthropic-api-key': OWN_KEY,
        accept: 'text/event-stream',
      });
      expect(streamed.body).toContain('"idempotency_status":"in_progress"');
      expect(
        release,
        'a request that did not reserve the key never gives it back',
      ).not.toHaveBeenCalled();

      planner.finish();
      const ran = await first;
      expect(ran.statusCode).toBe(200);
      expect(ran.json<{ kind: string }>().kind).toBe('plan-executed');

      const replay = await send(id, 'key-mid-turn', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(ran.json());
      expect(planner.tasksPlanned, 'the task must never run twice').toHaveLength(1);
    });

    it('a DIFFERENT key refused because that turn is running releases only itself: the running turn’s key still stores and replays its result', async () => {
      await build();
      const id = await createSession();

      planner.hold = true;
      const first = send(id, 'key-running', { 'x-byok-anthropic-api-key': OWN_KEY });
      await until(() => planner.holding === 1, 'the first turn to be planning');

      const busy = await send(id, 'key-waiting', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(busy.statusCode).toBe(409);
      expect(busy.json<{ turn_in_progress?: boolean }>().turn_in_progress).toBe(true);

      planner.finish();
      const ran = await first;
      expect(ran.statusCode).toBe(200);
      const replay = await send(id, 'key-running', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(replay.json()).toEqual(ran.json());
      expect(planner.tasksPlanned).toHaveLength(1);

      // And the waiting key was given back: it now runs its own turn, once.
      const waited = await send(id, 'key-waiting', { 'x-byok-anthropic-api-key': OWN_KEY });
      expect(waited.statusCode).toBe(200);
      expect(planner.tasksPlanned).toHaveLength(2);
    });
  });
});
