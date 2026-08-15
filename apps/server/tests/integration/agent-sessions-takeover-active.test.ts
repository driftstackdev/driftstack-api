// Active-variant coverage for POST /v1/agent-sessions/:id/takeover
// (registered when the agent runtime + pairModeLock are wired via
// enableAgentRuntime). The disabled-stub variant only asserts the 503;
// agent-sessions-routes.test.ts exercises the input-event takeover
// trigger but never the explicit /takeover endpoint, whose guards had
// no direct coverage: the mode!='pair' rejection, the happy-path
// transition to takeover-pending, request validation, and the
// cross-account/unknown-id 404.
//
// The PairModeConflictError race (two clients contending for the
// SET-NX-EX lock) is intentionally not covered here — the lock is
// acquired and released within a single request, so a deterministic
// conflict needs genuinely concurrent in-flight requests rather than
// the sequential injects an integration test issues.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

async function createSession(fx: TestAppFixture, mode: 'ai' | 'pair' | 'manual'): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { mode },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('active POST /v1/agent-sessions/:id/takeover (agent runtime wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it("mode='pair' + valid client_id → 200 and pair_mode_state transitions to takeover-pending", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'pair');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(res.statusCode).toBe(200);
    const state = res.json<{
      pair_mode_state: { kind: string; requestedByClientId?: string };
    }>().pair_mode_state;
    expect(state.kind).toBe('takeover-pending');
    expect(state.requestedByClientId).toBe('cli_tab_a');
  });

  it('a delayed stale takeover cannot replace the controller that committed first', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'pair');
    const repo = fx.agentSessionsRepo!;
    const original = repo.compareAndSetPairModeState.bind(repo);
    const winner = {
      kind: 'takeover-pending',
      requestedByClientId: 'cli_winner',
      requestedAt: '2026-07-13T12:00:00.000Z',
    };
    vi.spyOn(repo, 'compareAndSetPairModeState').mockImplementationOnce(
      async (sessionId, expected, next) => {
        // Deterministically model the production TOCTOU: this request already
        // read ai-driving, but another lock holder commits and releases before
        // this request reaches its UPDATE.
        await repo.setPairModeState(sessionId, winner);
        return original(sessionId, expected, next);
      },
    );

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_delayed' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string; winner_client_id: string }>()).toMatchObject({
      type: PROBLEM_TYPES.PairModeConflict,
      winner_client_id: 'cli_winner',
    });
    expect((await repo.get(id))?.pairModeState).toEqual(winner);
  });

  it("mode='ai' → 409 Conflict (takeover requires mode='pair')", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'ai');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Conflict);
  });

  it('missing client_id → 400 ValidationFailed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'pair');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('unknown / cross-account id → 404 NotFound (guard fires before lock acquire)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000aa/takeover',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.NotFound);
  });
});

// ─── losing the takeover lock ───────────────────────────────────────────────
//
// `/takeover` and the `/input-event` takeover trigger both acquire a per-session
// pair-mode lock and refuse the loser with `PairModeConflictError(winner)`.
// Neither refusal had ever executed: disabling each left 332 tests across 15
// files green, including `agent-pair-mode-lock.test.ts`, which tests the lock
// itself but never a route losing it.
//
// ⚠️ They cannot be reached by ordering requests, and the reason is worth
// stating because it looks like they should be. Both routes release the lock in
// a `finally`, so a SECOND sequential takeover acquires it cleanly and is
// refused further on by the STATE MACHINE — a different error
// (`pair-mode-invalid-transition`) thrown from a different line. Measured: two
// back-to-back takeovers by different clients answer 409
// `pair-mode-invalid-transition`, not `pair-mode-conflict`. A test built on that
// sequence would look like it covered the lock and would not.
//
// Holding the lock is therefore what the test controls, and that is the
// production condition rather than a contrivance: one tab holds control while
// another asks for it.
//
// ⭐ Each arm is paired with the same request against a FREE lock. Without that,
// a build that refused every takeover would satisfy both refusals — and the
// state-machine error above proves those two refusals are genuinely
// distinguishable, so asserting the conflict TYPE is not incidental.
//
// LEDGER — control 7/7:
//
//   :4006 takeover lock-loser removed        1 red
//   :3708 input-event lock-loser removed     1 red
//   :4006 names the LOSER as the winner      1 red
//
// The third is the one a status assertion cannot see. The guard still fires, the
// status is still 409, the type is still pair-mode-conflict — only the identity
// in the payload is wrong, so every client is told IT holds control while
// somebody else does. Two tabs then both render themselves as the driver. That
// is why the arm asserts the holder's id and not merely the error shape.
describe('a client that loses the pair-mode lock is told who holds it', () => {
  let fx2: TestAppFixture;

  afterEach(async () => {
    if (fx2) await fx2.cleanup();
  });

  async function pairSession(): Promise<string> {
    const res = await fx2.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx2.plaintext}` },
      payload: { token_budget: 50_000, mode: 'pair' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('POST /takeover → 409 pair-mode-conflict naming the holder, while the same request succeeds on a free lock', async () => {
    fx2 = await buildTestApp({ enableAgentRuntime: true });
    const id = await pairSession();
    await fx2.pairModeLock.tryAcquire({ sessionId: id, clientId: 'cli_holder' });

    const loser = await fx2.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx2.plaintext}` },
      payload: { client_id: 'cli_latecomer' },
    });
    expect(loser.statusCode, loser.body).toBe(409);
    const body = loser.json<{ type: string; winner_client_id?: string }>();
    expect(body.type).toContain('pair-mode-conflict');
    // Naming the winner is the point: the UI renders "cli_holder is driving".
    expect(JSON.stringify(body)).toContain('cli_holder');

    // Same request, lock free — proves the refusal is the lock and not takeover
    // being broken on this fixture.
    await fx2.pairModeLock.release({ sessionId: id, clientId: 'cli_holder' });
    const winner = await fx2.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx2.plaintext}` },
      payload: { client_id: 'cli_latecomer' },
    });
    expect(winner.statusCode, winner.body).toBe(200);
  });

  it('POST /input-event takeover trigger → the same conflict, from its own copy of the guard', async () => {
    fx2 = await buildTestApp({ enableAgentRuntime: true });
    const id = await pairSession();
    await fx2.pairModeLock.tryAcquire({ sessionId: id, clientId: 'cli_holder' });

    // The input-event path reaches its lock only when the session is ai-driving
    // and an input arrives — the implicit takeover trigger. It carries its OWN
    // acquire/refuse pair, so covering /takeover leaves this one cold.
    const res = await fx2.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx2.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 10, y: 10 }, client_id: 'cli_latecomer' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('pair-mode-conflict');
    expect(res.body).toContain('cli_holder');
  });
});

// ─── the pair-mode STATE MACHINE's refusals, which are not the lock's ───────
//
// Three more sites, all measured uncovered (disabling each left 237 tests across
// the agent-session, pair-mode and lock files green):
//
//   :4101  /takeover      — transition rejected by the state machine
//   :3908  /mode          — the session is no longer active
//
// ⚠️ A third arm was written for `:3801`, the input-event route's own copy of the
// invalid-transition catch, and then REMOVED. It never reached that line: the
// input-event route refuses first at its "wait for the transition to settle"
// guard, which excludes exactly the states (`takeover-pending`, `*-queued`,
// `handback-pending`) that could produce an invalid transition. Measured twice —
// the arm's body came back as a plain `conflict`, and disabling the settling
// guard reds pre-existing arms, so that one is already covered. `:3801` is
// shadowed by a guard upstream of it in the same handler.
//
// ⚠️ The first two are the ones the previous slice's lock arms are easy to
// confuse with. A lock loser and a state-machine refusal are DIFFERENT branches
// producing DIFFERENT problem types from DIFFERENT lines, and the sequential
// case reaches the second, never the first: the lock is released in a `finally`,
// so a second takeover acquires it cleanly and is then refused for asking for a
// transition the current state does not allow. Both arms assert the problem TYPE
// precisely for that reason — `pair-mode-invalid-transition` here,
// `pair-mode-conflict` there. Asserting only "409" would let either stand in for
// the other, and a build that collapsed them would look correct.
//
// LEDGER — control 9/9:
//
//   :4101 invalid-transition throw voided      1 red
//   :3908 non-active guard removed             1 red
//   :3908 INVERTED (refuses ACTIVE sessions)   1 red
//
// The inversion matters more than the removal. `/mode` toward manual is the
// handback the tier gate deliberately leaves open on every tier, so a guard that
// refused ACTIVE sessions instead of closed ones would strand every live session
// in whatever mode it was in — a 409 on the one flip that must always work.
describe('the pair-mode state machine refuses transitions the lock would allow', () => {
  let fx3: TestAppFixture;

  afterEach(async () => {
    if (fx3) await fx3.cleanup();
  });

  async function pairSession(): Promise<string> {
    const res = await fx3.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx3.plaintext}` },
      payload: { token_budget: 50_000, mode: 'pair' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('POST /takeover twice → the SECOND is an invalid-transition, not a lock conflict', async () => {
    fx3 = await buildTestApp({ enableAgentRuntime: true });
    const id = await pairSession();
    const first = await fx3.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx3.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(first.statusCode, first.body).toBe(200);

    const second = await fx3.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx3.plaintext}` },
      payload: { client_id: 'cli_tab_b' },
    });
    expect(second.statusCode, second.body).toBe(409);
    const body = second.json<{ type: string; from?: string; transition?: string }>();
    // The distinction that matters: NOT pair-mode-conflict. The lock was free.
    expect(body.type).toContain('pair-mode-invalid-transition');
    expect(body.type).not.toContain('pair-mode-conflict');
    // The payload names where the machine was and what was asked of it, which is
    // what lets a client decide whether to retry or to re-read state.
    expect(body.from).toBe('takeover-pending');
    expect(body.transition).toBe('takeover-request');
  });

  it('POST /mode on a session that is no longer active → 409 naming the status', async () => {
    fx3 = await buildTestApp({ enableAgentRuntime: true });
    const id = await pairSession();
    const closed = await fx3.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx3.plaintext}` },
    });
    expect(closed.statusCode, closed.body).toBeLessThan(300);

    const res = await fx3.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx3.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(res.statusCode, res.body).toBe(409);
    // Naming the actual status is the useful part — "closed" and "errored" send
    // a client to different places, and a bare 409 sends it to neither.
    expect(res.json<{ detail: string }>().detail).toMatch(/mode can only be changed on active/i);
  });
});

// ─── three more refusals, and one asymmetry that made them easy to miss ─────
//
// Measured uncovered (each neutralized in turn against 239 tests across the
// agent-session, pair-mode and lock files):
//
//   :4019  /takeover          — requires mode='pair'
//   :3566  /gui-control-key   — requires an ACTIVE session
//   :4249  /message           — AI control unavailable in manual/pair/transition
//
// ⭐ `:4019`'s sibling is the reason it went unnoticed. `/handback` carries the
// SAME guard with the same message shape, and that one IS covered — so a reader
// checking "is the mode precondition tested?" finds a passing arm and stops. The
// two routes have independent copies; covering one says nothing about the other.
// The pair is now symmetric.
//
// LEDGER — control 12/12:
//
//   :4019 takeover mode guard neutralized     1 red
//   :3566 control-key active guard            1 red
//   :4249 ai-control-unavailable              1 red
//   :4019 INVERTED (refuses PAIR sessions)    6 red
//
// The inversion is the anti-vacuity row and it reds six arms, not one: every
// pair-mode test in this file goes through a takeover first, so a guard that
// refused pair sessions breaks the whole feature rather than one assertion. That
// is what stops the three new arms from being satisfied by a build that refuses
// takeover outright.
describe('preconditions that are not about ownership or the lock', () => {
  let fx4: TestAppFixture;

  afterEach(async () => {
    if (fx4) await fx4.cleanup();
  });

  async function session(mode: 'ai' | 'manual' | 'pair'): Promise<string> {
    const res = await fx4.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx4.plaintext}` },
      payload: { token_budget: 50_000, mode },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it("409: /takeover on a mode='manual' session names the mode it found — the handback sibling had this covered and takeover did not", async () => {
    fx4 = await buildTestApp({ enableAgentRuntime: true });
    const id = await session('manual');
    const res = await fx4.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx4.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(res.statusCode, res.body).toBe(409);
    // Naming the mode is what tells a client whether to flip mode first or give
    // up; a bare 409 leaves it guessing which precondition it missed.
    expect(res.json<{ detail: string }>().detail).toMatch(/mode='manual'/);
    expect(res.json<{ detail: string }>().detail).toMatch(/takeover requires mode='pair'/);
  });

  it('409: a GUI control key cannot be minted for a session that is no longer active', async () => {
    fx4 = await buildTestApp({ enableAgentRuntime: true });
    const id = await session('manual');
    const closed = await fx4.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx4.plaintext}` },
    });
    expect(closed.statusCode, closed.body).toBeLessThan(300);

    // The key is session-scoped and long-lived; minting one for a dead session
    // hands out a credential whose session can never check it again.
    const res = await fx4.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx4.plaintext}` },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/require an active session/i);
  });

  it('409 with ai_control_unavailable: a message cannot be admitted while a human holds control', async () => {
    fx4 = await buildTestApp({ enableAgentRuntime: true });
    const id = await session('pair');
    // ⚠️ NOT a manual-mode session. A message there answers 200
    // `kind: 'logged-manual'` — manual appends a transcript entry and never
    // decomposes, so it never reaches admission at all. Measured; the first
    // draft of this arm used manual and was asserting against a success.
    const took = await fx4.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx4.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(took.statusCode, took.body).toBe(200);

    const res = await fx4.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx4.plaintext}` },
      payload: { user_message: 'drive for me' },
    });
    expect(res.statusCode, res.body).toBe(409);
    const body = res.json<{ detail: string; ai_control_unavailable?: boolean; phase?: string }>();
    expect(body.detail).toMatch(/AI control is unavailable/i);
    // ⭐ The extension fields are the contract, not decoration: the GUI branches
    // on `ai_control_unavailable` to show "you are driving" rather than an error
    // toast, and `phase` tells it the turn never started. A refusal that dropped
    // them would render as a generic failure on a perfectly healthy session.
    expect(body.ai_control_unavailable).toBe(true);
    expect(body.phase).toBe('admission');
  });
});
