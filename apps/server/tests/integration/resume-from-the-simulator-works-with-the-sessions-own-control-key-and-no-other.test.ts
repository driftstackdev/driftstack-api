// GUI audit #2 (HIGH) — "Resume" after a challenge could never succeed from the
// Simulator.
//
// The Simulator calls POST /v1/agent-sessions/:id/resume with the per-session
// control key only (`x-driftstack-gui-control-key`; on macOS the separate
// Simulator app holds no account key). Every sibling Simulator route accepted
// that key; resume alone was `app.requireAuth`, so it answered 401 "Missing
// Authorization header." on every retry and the session stayed paused. The
// account-key fallback did not help a Free user either: resume was not on the
// Free desktop allowlist.
//
// The contract pinned here is the one /stop already keeps:
//   · the session's own control key may resume it;
//   · a control key for ANOTHER session gets exactly the refusal /stop gives;
//   · a Free desktop key may resume its own session;
//   · the rest of the route is unchanged (no auth → 401, closed → 409).

import { afterEach, describe, expect, it } from 'vitest';
import { FREE_DESKTOP_ROUTE_DENIED_DETAIL } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const GCK = 'x-driftstack-gui-control-key';

let fixtures: TestAppFixture[] = [];

afterEach(async () => {
  for (const fx of fixtures) await fx.cleanup();
  fixtures = [];
});

async function build(opts: Parameters<typeof buildTestApp>[0]): Promise<TestAppFixture> {
  const fx = await buildTestApp({ enableAgentRuntime: true, ...opts });
  fixtures.push(fx);
  return fx;
}

const bearer = (fx: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fx.plaintext}`,
});

async function createSession(fx: TestAppFixture, mode?: 'manual'): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: bearer(fx),
    payload: mode === undefined ? {} : { mode },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

async function mintControlKey(fx: TestAppFixture, sessionId: string): Promise<string> {
  const res = await fx.app.inject({
    method: 'GET',
    url: `/v1/agent-sessions/${sessionId}/gui-control-key`,
    headers: bearer(fx),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ gui_control_key: string }>().gui_control_key;
}

function isFreeDesktopDenied(res: { statusCode: number; body: string }): boolean {
  if (res.statusCode !== 403) return false;
  return (JSON.parse(res.body) as { detail?: string }).detail === FREE_DESKTOP_ROUTE_DENIED_DETAIL;
}

describe('POST /v1/agent-sessions/:id/resume from the Simulator', () => {
  it('CRITICAL the session’s own control key resumes it — no account key is sent, as on the macOS Simulator', async () => {
    const fx = await build({});
    const id = await createSession(fx);
    const key = await mintControlKey(fx, id);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/resume`,
      headers: { [GCK]: key },
      payload: { challenge_id: 'chl_1' },
    });

    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ status: 'resume_requested', session_id: id });
  });

  it('CRITICAL a control key for ANOTHER session cannot resume this one, and is refused exactly as /stop refuses it', async () => {
    const fx = await build({});
    const id = await createSession(fx);
    const other = await createSession(fx);
    const foreignKey = await mintControlKey(fx, other);

    const resume = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/resume`,
      headers: { [GCK]: foreignKey },
      payload: {},
    });
    const stop = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/stop`,
      headers: { [GCK]: foreignKey },
      payload: {},
    });

    // The key is bound to its own session: presented here it authenticates nothing.
    expect(resume.statusCode).toBe(401);
    expect(resume.statusCode).toBe(stop.statusCode);
    const resumeBody = resume.json<{ type: string; detail: string }>();
    const stopBody = stop.json<{ type: string; detail: string }>();
    expect(resumeBody.type).toBe(stopBody.type);
    expect(resumeBody.detail).toBe(stopBody.detail);
    // And it did not fall through to anything that resumed the session.
    expect(resume.body).not.toContain('resume_requested');
  });

  it('CRITICAL a Free desktop key resumes its own session instead of being refused by the Free route policy', async () => {
    const fx = await build({
      tier: 'free',
      keyProvenance: 'cli_device',
      scopes: ['account_owner'],
    });
    const id = await createSession(fx, 'manual');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/resume`,
      headers: bearer(fx),
      payload: {},
    });

    expect(isFreeDesktopDenied(res), res.body).toBe(false);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ status: 'resume_requested', session_id: id });
  });

  it('the Free desktop key is still refused on routes the allowlist does not name (positive control for the check above)', async () => {
    const fx = await build({
      tier: 'free',
      keyProvenance: 'cli_device',
      scopes: ['account_owner'],
    });
    const id = await createSession(fx, 'manual');
    const network = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/network`,
      headers: bearer(fx),
    });
    expect(isFreeDesktopDenied(network), network.body).toBe(true);
  });

  it('with its own control key, a closed session is still a 409 and not a resume', async () => {
    const fx = await build({});
    const id = await createSession(fx);
    const key = await mintControlKey(fx, id);
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: bearer(fx),
    });
    expect(del.statusCode).toBe(204);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/resume`,
      headers: { [GCK]: key },
      payload: {},
    });
    // The key still authenticates (it is bound to this session, not to its
    // status), so the route's own terminal-session guard is what answers.
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).not.toContain('resume_requested');
  });

  it('with neither a control key nor an account key the caller learns nothing (401)', async () => {
    const fx = await build({});
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/resume`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('with its own control key, a malformed body is still refused (400), not ignored', async () => {
    const fx = await build({});
    const id = await createSession(fx);
    const key = await mintControlKey(fx, id);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/resume`,
      headers: { [GCK]: key },
      payload: { challenge_id: 42 },
    });
    expect(res.statusCode, res.body).toBe(400);
  });
});
