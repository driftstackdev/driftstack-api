// Per-request AI telemetry, through the real message route.
//
// The unit tests prove what the collector does with what it is handed. This
// file proves the ROUTE hands it the right things on every exit — and, above
// all, that wiring it in changed nothing a customer can observe:
//
//   • every exit of POST /v1/agent-sessions/:id/message leaves exactly one row
//     with the right outcome (a turn, a 404, a closed session, a busy session);
//   • an Idempotency-Key replay is counted as a replay and leaves NO second row;
//   • a turn whose task and URL are sentinels leaves a row containing neither,
//     nor the session id, nor the account id;
//   • CRITICAL: with the diagnostics writer throwing, or never settling, the
//     status and body of every response are identical to a build with no
//     telemetry at all, on both transports.

import { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';
import type { AgentTurnTelemetryWriter } from '../../src/services/agent-turn-telemetry.js';

let fixtures: TestAppFixture[] = [];

afterEach(async () => {
  for (const fx of fixtures) await fx.cleanup();
  fixtures = [];
});

async function build(opts: Parameters<typeof buildTestApp>[0] = {}): Promise<TestAppFixture> {
  const fx = await buildTestApp({ enableAgentRuntime: true, ...opts });
  fixtures.push(fx);
  return fx;
}

const auth = (fx: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fx.plaintext}`,
});

async function createSession(fx: TestAppFixture): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: auth(fx),
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function send(
  fx: TestAppFixture,
  id: string,
  message: unknown,
  headers: Record<string, string> = {},
) {
  return fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${id}/message`,
    headers: { ...auth(fx), ...headers },
    payload: message as Record<string, unknown>,
  });
}

const TASK = { user_message: 'open https://example.com and capture' };

describe('agent turn telemetry at the message route', () => {
  it('a completed JSON turn leaves one row and moves the turn counter, the duration and the phase histograms', async () => {
    const fx = await build();
    const id = await createSession(fx);
    const res = await send(fx, id, TASK);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ kind: string; ok: boolean }>()).toMatchObject({
      kind: 'plan-executed',
      ok: true,
    });
    await fx.agentTurnTelemetry.flush();

    const rows = fx.agentTurnTelemetryRepo.allForTest();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      outcome: 'completed',
      deathReason: 'none',
      diedStepIndex: null,
      diedStepKind: null,
      httpStatus: 200,
      transport: 'json',
      replans: 0,
      customerStopped: false,
      viewerDisconnected: false,
    });
    expect(row?.stepsRun).toBeGreaterThan(0);
    expect(row?.stepsSucceeded).toBe(row?.stepsRun);
    expect(row?.stepsPlanned).toBe(row?.stepsRun);
    // The runtime announced `planning` even though nobody was streaming: the
    // JSON lane's phases are timed too.
    expect(row?.modelCalls).toBe(1);
    expect(row?.timeToFirstProgressMs).not.toBeNull();

    const m = fx.metricsRegistry;
    expect(m.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'completed' })).toBe(1);
    expect(
      m.getHistogram(METRIC_NAMES.agentTurnDurationSeconds, { outcome: 'completed' }).count,
    ).toBe(1);
    expect(
      m.getHistogram(METRIC_NAMES.agentTurnTimeToFirstProgressSeconds, { transport: 'json' }).count,
    ).toBe(1);
    expect(m.getHistogram(METRIC_NAMES.agentTurnReplans, { outcome: 'completed' }).count).toBe(1);
    expect(m.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'ok' })).toBe(1);
    // The settled planning call reached the recorder seam and was attributed to
    // THIS request as its first plan.
    expect(
      m.getValue(METRIC_NAMES.agentTurnModelCallTotal, { call_kind: 'plan', model: 'none' }),
    ).toBe(1);
  });

  it('a streamed turn is recorded as transport=stream with a time to first progress', async () => {
    const fx = await build();
    const id = await createSession(fx);
    const res = await send(fx, id, TASK, { accept: 'text/event-stream' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: response');
    await fx.agentTurnTelemetry.flush();
    const rows = fx.agentTurnTelemetryRepo.allForTest();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'completed', transport: 'stream', httpStatus: 200 });
    expect(rows[0]?.timeToFirstProgressMs).not.toBeNull();
    expect(
      fx.metricsRegistry.getHistogram(METRIC_NAMES.agentTurnTimeToFirstProgressSeconds, {
        transport: 'stream',
      }).count,
    ).toBe(1);
  });

  it('exits that never reach the runtime are rows too: unknown session, invalid body, ended session', async () => {
    const fx = await build();
    const id = await createSession(fx);

    const unknown = await send(fx, 'ags_00000000-0000-4000-8000-000000000000', TASK);
    expect(unknown.statusCode).toBe(404);
    const invalid = await send(fx, id, { nope: true });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    expect(invalid.statusCode).toBeLessThan(500);

    const closed = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: auth(fx),
    });
    expect(closed.statusCode).toBe(204);
    const afterClose = await send(fx, id, TASK);
    expect(afterClose.statusCode).toBe(409);

    // The same admission failure on the streaming lane is reported inside the
    // terminal frame, with HTTP 200 on the wire — the ROW must carry the real
    // status, not the transport's.
    const streamed = await send(fx, id, TASK, { accept: 'text/event-stream' });
    expect(streamed.statusCode).toBe(200);

    await fx.agentTurnTelemetry.flush();
    const rows = fx.agentTurnTelemetryRepo.allForTest();
    expect(rows.map((r) => [r.outcome, r.deathReason, r.httpStatus, r.transport])).toEqual([
      ['rejected', 'request_rejected', 404, 'json'],
      ['rejected', 'request_rejected', invalid.statusCode, 'json'],
      ['conflict_409', 'session_not_active', 409, 'json'],
      ['conflict_409', 'session_not_active', 409, 'stream'],
    ]);
    for (const r of rows) {
      expect(r.modelCalls).toBe(0);
      expect(r.timeToFirstProgressMs).toBeNull();
    }
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'rejected' })).toBe(
      2,
    );
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'conflict_409' }),
    ).toBe(2);
  });

  it('a message sent while a turn is still running is a busy_409 — and the running turn keeps its own model call', async () => {
    const fx = await build();
    const id = await createSession(fx);
    // Hold the first turn INSIDE the runtime's exclusive section, so the second
    // request deterministically finds the session busy. (Two plain concurrent
    // injects do not overlap: the stub executor finishes first.)
    const repo = fx.agentSessionsRepo;
    if (repo === undefined) throw new Error('fixture has no agent sessions repo');
    const append = repo.appendTranscriptIfAuthorityRevision.bind(repo);
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let first = true;
    repo.appendTranscriptIfAuthorityRevision = async (...args) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return append(...args);
    };

    const running = send(fx, id, TASK);
    await inside;
    const bounced = await send(fx, id, TASK);
    expect(bounced.statusCode).toBe(409);
    expect(bounced.json()).toMatchObject({ turn_in_progress: true });
    release();
    expect((await running).statusCode).toBe(200);

    await fx.agentTurnTelemetry.flush();
    const rows = fx.agentTurnTelemetryRepo.allForTest();
    expect(rows.map((r) => r.outcome).sort()).toEqual(['busy_409', 'completed']);
    expect(rows.find((r) => r.outcome === 'busy_409')).toMatchObject({
      deathReason: 'turn_in_progress',
      httpStatus: 409,
      modelCalls: 0,
    });
    expect(rows.find((r) => r.outcome === 'completed')?.modelCalls).toBe(1);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'busy_409' })).toBe(
      1,
    );
    expect(fx.agentTurnTelemetry.activeCount()).toBe(0);
  });

  it('an Idempotency-Key replay is counted as `replayed` and leaves NO second row — a client retrying one slow turn is not several turns', async () => {
    const fx = await build();
    const id = await createSession(fx);
    const key = { 'idempotency-key': 'telemetry-replay-1' };
    const first = await send(fx, id, TASK, key);
    const second = await send(fx, id, TASK, key);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    await fx.agentTurnTelemetry.flush();
    expect(fx.agentTurnTelemetryRepo.allForTest()).toHaveLength(1);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'completed' })).toBe(
      1,
    );
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'replayed' })).toBe(
      1,
    );
  });

  it('CRITICAL a raw error carrying somebody ELSE’s status is recorded as what the customer received. A provider error with `status: 401` reaches the JSON lane’s catch un-normalised; the customer gets a 500, and a row saying "rejected, 401" would take a provider outage out of the error count and out of the completion rate.', async () => {
    const fx = await build();
    const id = await createSession(fx);
    const repo = fx.agentSessionsRepo;
    if (repo === undefined) throw new Error('fixture has no agent sessions repo');
    repo.appendTranscriptIfAuthorityRevision = () =>
      Promise.reject(
        Object.assign(new Error('Anthropic API 401'), {
          name: 'AnthropicStreamError',
          status: 401,
        }),
      );
    const json = await send(fx, id, TASK);
    const stream = await send(fx, id, TASK, { accept: 'text/event-stream' });
    expect(json.statusCode).toBe(500);
    expect(stream.body).toContain('"status":500');
    await fx.agentTurnTelemetry.flush();
    expect(
      fx.agentTurnTelemetryRepo.allForTest().map((r) => [r.outcome, r.httpStatus, r.transport]),
    ).toEqual([
      ['error', 500, 'json'],
      ['error', 500, 'stream'],
    ]);
    expect(fx.agentTurnTelemetry.activeCount()).toBe(0);
  });

  it('the account-level 429 is a `rate_limited` row on BOTH transports, and neither request is left open. On the streaming lane this denial is thrown before the stream opens, so it is the one stream exit that does not pass through the terminal-frame finish.', async () => {
    const OWNER_ID = '00000000-0000-4000-8000-00000000e001';
    const fx = await build({ tier: 'api_scale' });
    fx.authRepo.upsertAccount({
      id: OWNER_ID,
      email: 'owner@turn-telemetry.test',
      name: null,
      tier: 'free',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
      updatedAt: new Date('2026-07-30T00:00:00.000Z'),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: '00000000-0000-4000-8000-00000000e002',
        ownerAccountId: OWNER_ID,
        role: 'admin',
      },
    ]);
    const repo = fx.agentSessionsRepo;
    if (repo === undefined) throw new Error('fixture has no agent sessions repo');
    const session = await repo.create({ accountId: OWNER_ID, tokenBudgetTotal: 50_000 });
    fx.authRepo.setRateLimitOverride(OWNER_ID, {
      bucketKey: 'agent_sessions:message',
      capacity: 1,
      refillPerSecond: 0.001,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await fx.rateLimitStore.consume({
      key: `rl:${OWNER_ID}:agent_sessions:message`,
      capacity: 1,
      refillPerSecond: 0.001,
      cost: 1,
      now: Date.now(),
    });
    const team = { 'x-driftstack-account': `acc_${OWNER_ID}` };

    const json = await send(fx, session.id, TASK, team);
    const stream = await send(fx, session.id, TASK, { ...team, accept: 'text/event-stream' });
    expect(json.statusCode).toBe(429);
    expect(stream.statusCode).toBe(429);

    await fx.agentTurnTelemetry.flush();
    expect(
      fx.agentTurnTelemetryRepo
        .allForTest()
        .map((r) => [r.outcome, r.deathReason, r.httpStatus, r.transport]),
    ).toEqual([
      ['rate_limited', 'rate_limited', 429, 'json'],
      ['rate_limited', 'rate_limited', 429, 'stream'],
    ]);
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'rate_limited' }),
    ).toBe(2);
    expect(fx.agentTurnTelemetry.activeCount()).toBe(0);
  });

  it('a viewer that goes away mid-stream: the turn still runs to the end, and its row says the viewer was gone', async () => {
    const fx = await build();
    const id = await createSession(fx);
    // The response object is not reachable through inject, so it is caught at
    // the one write only this route makes.
    const write: unknown = Reflect.get(ServerResponse.prototype, 'write');
    if (typeof write !== 'function') throw new Error('ServerResponse has no write');
    // A narrowing does not reach into a hoisted function; a second const does.
    const original = write;
    const wasOwn = Object.hasOwn(ServerResponse.prototype, 'write');
    const seen: { streamed?: ServerResponse } = {};
    function patched(this: ServerResponse, chunk: unknown, ...rest: unknown[]): boolean {
      if (chunk === ': stream open\n\n') seen.streamed = this;
      const wrote: unknown = Reflect.apply(original, this, [chunk, ...rest]);
      return wrote === true;
    }
    const install = (value: unknown): void => {
      Object.defineProperty(ServerResponse.prototype, 'write', {
        value,
        configurable: true,
        writable: true,
      });
    };
    install(patched);
    try {
      const held = holdFirstTurn(fx);
      const request = send(fx, id, TASK, { accept: 'text/event-stream' }).catch(() => undefined);
      await held.inside;
      if (seen.streamed === undefined) throw new Error('the stream never opened');
      seen.streamed.emit('close');
      held.release();
      await request;
      for (let i = 0; i < 200 && fx.agentTurnTelemetry.activeCount() > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      // `write` is inherited, so removing the shadow IS the restore.
      if (wasOwn) install(write);
      else Reflect.deleteProperty(ServerResponse.prototype, 'write');
    }
    await fx.agentTurnTelemetry.flush();
    const rows = fx.agentTurnTelemetryRepo.allForTest();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'completed',
      transport: 'stream',
      viewerDisconnected: true,
    });
  });

  it('CRITICAL content-free: a turn whose task and URL are sentinels leaves a row holding neither, nor any id', async () => {
    const fx = await build();
    const id = await createSession(fx);
    const res = await send(fx, id, {
      user_message:
        'open https://sentinel-host.example/SENTINEL_PATH_4417?q=SENTINEL_QUERY and capture SENTINEL_TASK_WORDS',
    });
    expect(res.statusCode).toBe(200);
    // The sentinels really were in play: the response carries the URL.
    expect(res.body).toContain('SENTINEL_PATH_4417');
    await fx.agentTurnTelemetry.flush();

    const rows = fx.agentTurnTelemetryRepo.allForTest();
    expect(rows).toHaveLength(1);
    const serialised = JSON.stringify(rows[0]);
    expect(serialised).not.toContain('SENTINEL');
    expect(serialised).not.toContain('sentinel-host');
    expect(serialised).not.toContain(id);
    expect(serialised).not.toContain(id.replace(/^ags_/, ''));
    expect(serialised).not.toContain(fx.accountId);
    expect(fx.metricsRegistry.render()).not.toContain('SENTINEL');
    expect(fx.metricsRegistry.render()).not.toContain(id);
  });
});

/**
 * Hold the next turn INSIDE the runtime's exclusive section until released, so
 * a second request deterministically finds the session busy. (Two plain
 * concurrent injects do not overlap: the stub executor finishes first.)
 */
function holdFirstTurn(fx: TestAppFixture): { inside: Promise<void>; release: () => void } {
  const repo = fx.agentSessionsRepo;
  if (repo === undefined) throw new Error('fixture has no agent sessions repo');
  const append = repo.appendTranscriptIfAuthorityRevision.bind(repo);
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let first = true;
  repo.appendTranscriptIfAuthorityRevision = async (...args) => {
    if (first) {
      first = false;
      entered();
      await gate;
      repo.appendTranscriptIfAuthorityRevision = append;
    }
    return append(...args);
  };
  return { inside, release };
}

describe('CRITICAL telemetry never changes the response', () => {
  const throwing: AgentTurnTelemetryWriter = {
    insert: () => Promise.reject(new Error('diagnostics table is gone')),
  };
  const throwingSync: AgentTurnTelemetryWriter = {
    insert: () => {
      throw new Error('diagnostics writer exploded');
    },
  };
  const hanging: AgentTurnTelemetryWriter = { insert: () => new Promise<void>(() => undefined) };

  /** Everything a customer can observe, with the per-run values removed. */
  function observable(status: number, body: string): unknown {
    const scrub = (text: string): string =>
      text
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
        .replace(/"instance":"[^"]*"/g, '"instance":"<req>"');
    return { status, body: scrub(body) };
  }

  async function scenario(opts: Parameters<typeof buildTestApp>[0]): Promise<unknown[]> {
    const fx = await build(opts);
    const id = await createSession(fx);
    const out: unknown[] = [];
    const json = await send(fx, id, TASK);
    out.push(observable(json.statusCode, json.body));
    const stream = await send(fx, id, TASK, { accept: 'text/event-stream' });
    out.push(observable(stream.statusCode, stream.body.replace(/^: .*$/gm, '')));
    const invalid = await send(fx, id, { nope: true });
    out.push(observable(invalid.statusCode, invalid.body));
    const unknown = await send(fx, 'ags_00000000-0000-4000-8000-000000000000', TASK);
    out.push(observable(unknown.statusCode, unknown.body));

    // The exits the production complaint was ABOUT: a message sent while the
    // previous turn is still running, on both transports.
    const held = holdFirstTurn(fx);
    const running = send(fx, id, TASK);
    await held.inside;
    const bounced = await send(fx, id, TASK);
    out.push(observable(bounced.statusCode, bounced.body));
    const bouncedStream = await send(fx, id, TASK, { accept: 'text/event-stream' });
    out.push(observable(bouncedStream.statusCode, bouncedStream.body.replace(/^: .*$/gm, '')));
    held.release();
    const ran = await running;
    out.push(observable(ran.statusCode, ran.body));

    // Idempotency: the first send, its replay (markReplay), and the same key
    // reused for a different message (a mismatch 409).
    const key = { 'idempotency-key': 'invariance-key-1' };
    for (const message of [TASK, TASK, { user_message: 'open https://example.org' }]) {
      const res = await send(fx, id, message, key);
      out.push(observable(res.statusCode, res.body));
    }

    // A 5xx: storage fails inside the turn, on both transports. On the JSON lane
    // this is the path that reaches finishWithError with a raw, non-API error.
    const repo = fx.agentSessionsRepo;
    if (repo === undefined) throw new Error('fixture has no agent sessions repo');
    const append = repo.appendTranscriptIfAuthorityRevision.bind(repo);
    repo.appendTranscriptIfAuthorityRevision = () => Promise.reject(new Error('storage is down'));
    try {
      const brokenJson = await send(fx, id, TASK);
      out.push(observable(brokenJson.statusCode, brokenJson.body));
      const brokenStream = await send(fx, id, TASK, { accept: 'text/event-stream' });
      out.push(observable(brokenStream.statusCode, brokenStream.body.replace(/^: .*$/gm, '')));
    } finally {
      repo.appendTranscriptIfAuthorityRevision = append;
    }

    await fx.app.inject({ method: 'DELETE', url: `/v1/agent-sessions/${id}`, headers: auth(fx) });
    const closed = await send(fx, id, TASK);
    out.push(observable(closed.statusCode, closed.body));
    const closedStream = await send(fx, id, TASK, { accept: 'text/event-stream' });
    out.push(observable(closedStream.statusCode, closedStream.body.replace(/^: .*$/gm, '')));
    return out;
  }

  it('with the writer REJECTING, THROWING or HANGING, every response on both transports is identical to a build with no telemetry', async () => {
    const baseline = await scenario({ disableAgentTurnTelemetry: true });
    // The scenario really exercised these exits, in this order: a JSON turn, a
    // streamed turn, an invalid body, an unknown session, busy (JSON, then
    // inside a stream), the held turn itself, first-send / replay / key
    // mismatch, a 5xx on each transport, and an ended session on each.
    expect(baseline.map((o) => (o as { status: number }).status)).toEqual([
      200, 200, 400, 404, 409, 200, 200, 200, 200, 409, 500, 200, 409, 200,
    ]);
    const bodyOf = (i: number): string => (baseline[i] as { body: string }).body;
    expect(bodyOf(4)).toContain('turn_in_progress');
    expect(bodyOf(5)).toContain('turn_in_progress');
    expect(bodyOf(8)).toBe(bodyOf(7));
    expect(bodyOf(11)).toContain('"status":500');
    expect(await scenario({})).toEqual(baseline);
    expect(await scenario({ agentTurnTelemetryWriter: throwing })).toEqual(baseline);
    expect(await scenario({ agentTurnTelemetryWriter: throwingSync })).toEqual(baseline);
    expect(await scenario({ agentTurnTelemetryWriter: hanging })).toEqual(baseline);
  });

  it('CRITICAL with a telemetry object whose EVERY method throws — begin, or each collector call — every response is still identical. The route does not take the collector’s word that it cannot throw.', async () => {
    const boom = (): never => {
      throw new Error('telemetry is broken');
    };
    const baseline = await scenario({ disableAgentTurnTelemetry: true });
    // Cannot even start.
    expect(await scenario({ agentTurnTelemetryOverride: { begin: boom } })).toEqual(baseline);
    // Starts, then every call the route makes throws.
    let calls = 0;
    const hostile = {
      begin: () => ({
        recordProgress: () => {
          calls += 1;
          return boom();
        },
        observeResult: () => {
          calls += 1;
          return boom();
        },
        markReplay: boom,
        finish: () => {
          calls += 1;
          return boom();
        },
        finishWithError: () => {
          calls += 1;
          return boom();
        },
      }),
    };
    expect(await scenario({ agentTurnTelemetryOverride: hostile })).toEqual(baseline);
    // Not vacuous: the hostile methods really were reached, many times.
    expect(calls).toBeGreaterThan(10);
  });

  it('…and each failed write was COUNTED, since nothing else is allowed to notice it', async () => {
    const fx = await build({ agentTurnTelemetryWriter: throwing });
    const id = await createSession(fx);
    const res = await send(fx, id, TASK);
    expect(res.statusCode).toBe(200);
    await fx.agentTurnTelemetry.flush();
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'error' }),
    ).toBe(1);
    // The turn is still counted: losing the row must not lose the metric.
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'completed' })).toBe(
      1,
    );
  });

  it('with telemetry unwired the route records nothing at all', async () => {
    const fx = await build({ disableAgentTurnTelemetry: true });
    const id = await createSession(fx);
    expect((await send(fx, id, TASK)).statusCode).toBe(200);
    await fx.agentTurnTelemetry.flush();
    expect(fx.agentTurnTelemetryRepo.allForTest()).toEqual([]);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'completed' })).toBe(
      0,
    );
  });
});
