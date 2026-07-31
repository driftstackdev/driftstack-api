// Account B cannot reach account A's agent session through ANY of its routes.
//
// Measured before writing a line, and this was the worst result of the three
// resources: making `callerCanAccessAgentSession` return true unconditionally —
// disabling agent-session ownership completely — left the ENTIRE integration
// suite green. 2,193 passing, zero failures. Twenty id-taking routes and
// nineteen call sites of that predicate, and nothing anywhere verified it.
//
// Sessions had 2 guarding tests and profiles 1. Agent sessions had none, on the
// resource that carries the live browser, its transcript, its cookies, its page
// state and its downloads.
//
// Note the predicate is NOT a plain account-id comparison: a team admin may
// legitimately reach a member's session. Account B here is an unrelated account
// with no membership in A's team, which is the case that must always be denied.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/** Full rights over B's OWN account, so the scope gate cannot mask ownership. */
const FULL_SCOPES = ['read', 'write', 'account_owner', 'gui_control'] as const;

const AGENT_ROUTES: ReadonlyArray<{
  method: 'GET' | 'POST' | 'DELETE';
  suffix: string;
  payload?: Record<string, unknown>;
}> = [
  { method: 'GET', suffix: '' },
  { method: 'DELETE', suffix: '' },
  { method: 'GET', suffix: '/transcript' },
  { method: 'GET', suffix: '/page-state' },
  { method: 'GET', suffix: '/cookies' },
  { method: 'GET', suffix: '/downloads' },
  { method: 'GET', suffix: '/gui-control-key' },
  { method: 'POST', suffix: '/mode', payload: { mode: 'manual' } },
  { method: 'POST', suffix: '/takeover', payload: { client_id: 'b-client' } },
  { method: 'POST', suffix: '/handback', payload: {} },
  { method: 'POST', suffix: '/resume', payload: {} },
];

async function createAgentSessionForAccountA(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: { task: 'owned by A' },
  });
  expect(
    [200, 201],
    `agent-session create returned ${res.statusCode}: ${res.body.slice(0, 200)}`,
  ).toContain(res.statusCode);
  return res.json<{ id: string }>().id;
}

describe("account B cannot reach account A's agent session on any route", () => {
  it.each(AGENT_ROUTES.map((r) => [`${r.method} /v1/agent-sessions/:id${r.suffix}`, r] as const))(
    'CRITICAL %s refuses an unrelated account. A 2xx here exposes another customer’s live browser — its transcript, cookies, page state and downloads — and this boundary had NO test at all before this file.',
    async (_label, route) => {
      fx = await buildTestApp({ tier: 'api_builder', enableAgentRuntime: true });
      const agentSessionId = await createAgentSessionForAccountA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@agent-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const res = await fx.app.inject({
        method: route.method,
        url: `/v1/agent-sessions/${agentSessionId}${route.suffix}`,
        headers: { authorization: `Bearer ${other.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });

      expect(
        res.statusCode,
        `${route.method} /v1/agent-sessions/:id${route.suffix} returned ${res.statusCode} for an unrelated account`,
      ).toBe(404);
    },
  );

  /**
   * `POST /:id/message` is the ONE route here not proven by mutation, and that
   * is stated plainly rather than papered over.
   *
   * It answers 400 before reaching the ownership check — and to the OWNER too,
   * for every body shape probed, so the rejection is not simple field
   * validation; the route carries durable at-most-once receipts and most likely
   * wants an `Idempotency-Key`. Because it 400s either way, disabling ownership
   * does not red this case, so it contributes nothing to the 11-of-12 mutation
   * result below.
   *
   * What IS established: the handler does call `callerCanAccessAgentSession`
   * (verified by reading it — roughly 150 lines into the handler, past the
   * window a short scan would cover), and an unrelated account receives neither
   * a 2xx nor any session content. Proving it by mutation needs the accepted
   * request shape, which is worth a follow-up.
   */
  it('CRITICAL POST /:id/message never returns another account’s session content, even though body validation answers before the ownership check', async () => {
    fx = await buildTestApp({ tier: 'api_builder', enableAgentRuntime: true });
    const agentSessionId = await createAgentSessionForAccountA(fx);
    const other = await seedAdditionalAccount(fx, {
      email: 'b@agent-isolation.test',
      tier: 'api_builder',
      scopes: [...FULL_SCOPES],
    });

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${agentSessionId}/message`,
      headers: { authorization: `Bearer ${other.plaintext}` },
      payload: { message: 'hello from B' },
    });

    expect(res.statusCode, 'an unrelated account must never get a 2xx here').toBeGreaterThanOrEqual(
      400,
    );
    expect(res.body).not.toContain('owned by A');
  });
});
