// Hardening (2026-06-24, LOW defense-in-depth) — integration tests for the
// per-ACCOUNT CONCURRENT-RELAY COUNT cap shared across the lightweight control-
// relay routes that carry only the `global` RATE
// limiter (which bounds requests/window, NOT how many handlers can be awaiting
// a 10–30s relay at once):
//   GET  /v1/agent-sessions/:id/cookies
//   POST /v1/agent-sessions/:id/cookies/set
//   POST /v1/agent-sessions/:id/history
//   GET  /v1/agent-sessions/:id/downloads
//
// Each route reserves a per-account slot (Map<accountId, number>) BEFORE relaying,
// sheds the (cap+1)-th request with a discriminated busy outcome WITHOUT relaying,
// and RELEASES the slot in a `finally` regardless of outcome (ok / error / timeout /
// throw). These tests pin that accounting end-to-end through the HTTP layer:
//   1. concurrent requests up to the cap relay; the (cap+1)-th is shed (status
//      'error' + the "too many concurrent requests" reason) and is NEVER relayed,
//   2. releasing an in-flight relay frees a slot (a fresh request then relays),
//   3. the cap is SHARED across the lightweight routes (a mix fills it),
//   4. per-account isolation — one account at the cap doesn't block another.
//
// The download-content route also takes this shared slot, but separately admits
// only one large fetch per account because a 64 MiB file expands to ~85.3 MiB of
// base64 before parser/response copies. Its dedicated memory guard is exercised
// by agent-sessions-downloads-route.test.ts instead of this CAP=2 matrix.
//
// The cap is injectable: buildTestApp({ relayMaxAccountInFlight }) threads a TINY
// cap into AppDeps so we trip it with 2 concurrent relays. We keep relays "in
// flight" by registering a node that NEVER echoes a result for the hang frames →
// the route stays awaiting (correlator default 10–30s) until we close the
// connection in teardown (failAll → the route's finally releases).

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from '../integration/_helpers/build-test-app.js';

const CAP = 2; // injected per-account concurrent-relay cap
const BUSY = /too many concurrent requests for this account/i;

interface DiscriminatedBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  reason?: string;
}

const JAR = [{ domain: '.example.com', name: 'sid', value: 'abc' }];

async function createSession(fx: TestAppFixture, plaintext: string): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${plaintext}` },
    payload: { token_budget: 50_000 },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

/** Spin until `cond()` is true or the budget elapses (concurrent handlers need a
 *  few event-loop ticks to each reach their reservation/relay point). */
async function waitFor(cond: () => boolean, label: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

/** Register a node that RECORDS every relayed frame type but NEVER echoes a result
 *  → the route handler stays awaiting (relay in-flight, slot reserved) until the
 *  connection is closed in teardown. */
function registerHangNode(fx: TestAppFixture, nodeId: string, relayed: string[]): void {
  fx.fleetControlRegistry.register(nodeId, (data) => {
    const f = JSON.parse(data) as { type?: string };
    if (f.type !== undefined) relayed.push(f.type);
    // never echo → hang
  });
}

// GET cookies (pull) — hang frame type 'cookiesRequest'.
function getCookies(fx: TestAppFixture, id: string, plaintext: string) {
  return fx.app.inject({
    method: 'GET',
    url: `/v1/agent-sessions/${id}/cookies`,
    headers: { authorization: `Bearer ${plaintext}` },
  });
}
// POST cookies/set — hang frame type 'setCookies'.
function postCookiesSet(fx: TestAppFixture, id: string, plaintext: string) {
  return fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${id}/cookies/set`,
    headers: { authorization: `Bearer ${plaintext}` },
    payload: { cookies: JAR },
  });
}
// POST history — hang frame type 'navigateHistory'.
function postHistory(fx: TestAppFixture, id: string, plaintext: string) {
  return fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${id}/history`,
    headers: { authorization: `Bearer ${plaintext}` },
    payload: { direction: 'back' },
  });
}
// GET downloads list — hang frame type 'listDownloads'.
function getDownloads(fx: TestAppFixture, id: string, plaintext: string) {
  return fx.app.inject({
    method: 'GET',
    url: `/v1/agent-sessions/${id}/downloads`,
    headers: { authorization: `Bearer ${plaintext}` },
  });
}
describe('per-account concurrent-relay cap (shared across cookies/set, history, and downloads list)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it.each([
    ['cookies pull', 'cookiesRequest', getCookies],
    ['cookies/set', 'setCookies', postCookiesSet],
    ['history', 'navigateHistory', postHistory],
    ['downloads list', 'listDownloads', getDownloads],
  ] as const)(
    '%s — CAP concurrent relays are accepted, the (CAP+1)-th is shed (status:"error", never relayed)',
    async (_label, frameType, fire) => {
      fx = await buildTestApp({
        enableAgentRuntime: true,
        enableFleetControlPlane: true,
        relayMaxAccountInFlight: CAP,
      });
      const id = await createSession(fx, fx.plaintext);
      const nodeId = `node-relay-${frameType}`;
      const relayed: string[] = [];
      registerHangNode(fx, nodeId, relayed);
      await fx.agentSessionsRepo!.setNodeId(id, nodeId);

      // Fill the account to EXACTLY the cap with CAP hanging relays.
      const hanging = Array.from({ length: CAP }, () => fire(fx, id, fx.plaintext));
      await waitFor(
        () => relayed.filter((t) => t === frameType).length === CAP,
        `${frameType} ×CAP relayed`,
      );

      // The (CAP+1)-th request is shed WITHOUT relaying.
      const relayedBefore = relayed.length;
      const res = await fire(fx, id, fx.plaintext);
      expect(res.statusCode).toBe(200);
      const body = res.json<DiscriminatedBody>();
      expect(body.status).toBe('error');
      expect(body.reason).toMatch(BUSY);
      expect(relayed.length).toBe(relayedBefore); // not relayed

      // Settle the hanging relays so cleanup doesn't await them.
      fx.fleetControlRegistry.get(nodeId)!.close('test teardown');
      await Promise.all(hanging);
    },
  );

  it('releasing an in-flight relay frees a slot (the finally runs → a fresh request relays)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      relayMaxAccountInFlight: CAP,
    });
    const id = await createSession(fx, fx.plaintext);
    const nodeId = 'node-relay-release';
    const relayed: string[] = [];
    registerHangNode(fx, nodeId, relayed);
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);

    // Saturate to the cap with CAP hanging cookies/set relays.
    const hanging = Array.from({ length: CAP }, () => postCookiesSet(fx, id, fx.plaintext));
    await waitFor(
      () => relayed.filter((t) => t === 'setCookies').length === CAP,
      'cookies ×CAP relayed',
    );

    // At cap → shed.
    expect((await postCookiesSet(fx, id, fx.plaintext)).json<DiscriminatedBody>().status).toBe(
      'error',
    );

    // Release ALL in-flight relays (failAll → each route's finally decrements).
    fx.fleetControlRegistry.get(nodeId)!.close('release for test');
    const settled = await Promise.all(hanging);
    for (const r of settled) {
      // failAll resolves the correlator as a timeout outcome → discriminated 200.
      expect(r.statusCode).toBe(200);
    }

    // A fresh node + relay now succeeds (slots freed). The node echoes ok.
    const nodeId2 = 'node-relay-release-2';
    const conn = fx.fleetControlRegistry.register(nodeId2, (data) => {
      const f = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (f.type === 'setCookies') {
        conn.handleInbound(
          JSON.stringify({
            type: 'setCookiesResult',
            requestId: f.requestId,
            sessionId: f.sessionId,
            ok: true,
          }),
        );
      }
    });
    await fx.agentSessionsRepo!.setNodeId(id, nodeId2);
    const ok = await postCookiesSet(fx, id, fx.plaintext);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<DiscriminatedBody>().status).toBe('ok');
  });

  it('the cap is SHARED across the four routes (a mix of routes fills it)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      relayMaxAccountInFlight: CAP, // 2
    });
    const id = await createSession(fx, fx.plaintext);
    const nodeId = 'node-relay-shared';
    const relayed: string[] = [];
    registerHangNode(fx, nodeId, relayed);
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);

    // Fill the (shared) cap with ONE cookies/set + ONE history → CAP relays.
    const hanging = [postCookiesSet(fx, id, fx.plaintext), postHistory(fx, id, fx.plaintext)];
    await waitFor(() => relayed.length === CAP, 'two distinct-route relays in flight');
    expect(relayed.sort()).toEqual(['navigateHistory', 'setCookies']);

    // A THIRD request on a DIFFERENT route is shed by the SHARED cap.
    const res = await getDownloads(fx, id, fx.plaintext);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; files: unknown; reason?: string }>();
    expect(body.status).toBe('error');
    expect(body.files).toBeNull();
    expect(body.reason).toMatch(BUSY);

    fx.fleetControlRegistry.get(nodeId)!.close('test teardown');
    await Promise.all(hanging);
  });

  it('per-account isolation — one account at the cap does not block a DIFFERENT account', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      relayMaxAccountInFlight: CAP,
    });
    const second = await seedAdditionalAccount(fx);
    const id1 = await createSession(fx, fx.plaintext);
    const id2 = await createSession(fx, second.plaintext);
    const relayed: string[] = [];
    registerHangNode(fx, 'node-relay-iso', relayed);
    await fx.agentSessionsRepo!.setNodeId(id1, 'node-relay-iso');

    // Saturate account 1.
    const hanging = Array.from({ length: CAP }, () => postCookiesSet(fx, id1, fx.plaintext));
    await waitFor(
      () => relayed.filter((t) => t === 'setCookies').length === CAP,
      'account-1 saturated',
    );

    // Account 1 is shed at the cap…
    expect((await postCookiesSet(fx, id1, fx.plaintext)).json<DiscriminatedBody>().status).toBe(
      'error',
    );

    // …while account 2 (a separate accountId) relays fine. A2 echoes ok.
    const conn2 = fx.fleetControlRegistry.register('node-relay-iso-2', (data) => {
      const f = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (f.type === 'setCookies') {
        conn2.handleInbound(
          JSON.stringify({
            type: 'setCookiesResult',
            requestId: f.requestId,
            sessionId: f.sessionId,
            ok: true,
          }),
        );
      }
    });
    await fx.agentSessionsRepo!.setNodeId(id2, 'node-relay-iso-2');
    const other = await postCookiesSet(fx, id2, second.plaintext);
    expect(other.statusCode).toBe(200);
    expect(other.json<DiscriminatedBody>().status).toBe('ok');

    fx.fleetControlRegistry.get('node-relay-iso')!.close('test teardown');
    await Promise.all(hanging);
  });
});
