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
   * `POST /:id/message` validates its body before consulting ownership, so it
   * answers 400 to an unrelated account rather than 404. That is not a leak —
   * the same 400 comes back for an id that never existed — but it means the
   * route cannot demonstrate isolation through its status code. Asserted on the
   * property that matters instead: the caller never receives session content.
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
