// A message to a session that has ended says so in a field.
//
// A session that closes DURING a turn answers 409 with `session_status`, so a
// program can tell "this session is over, start another" from "this session is
// busy, wait". A message to a session that had ALREADY closed (or was paused)
// was refused by a different branch, before the turn starts, and that 409
// carried prose only: a program had to read the sentence to know which conflict
// it was.
//
// Both now carry the same fields. ADDITIVE: `session_status` on every such 409,
// and `closed_reason` beside it whenever the session records one — the same
// value `GET /v1/agent-sessions/{id}` returns. Status, type, title and detail are
// unchanged, and it is the same on the streamed turn's final response.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  session_status?: string;
  closed_reason?: string;
  turn_in_progress?: boolean;
}

describe('a message to a session that has ended says so in a field', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fx) await fx.cleanup();
  });

  const createSession = async (): Promise<string> => {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  };

  const close = (id: string) =>
    fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

  const send = (id: string, headers: Record<string, string> = {}) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: 'open https://example.com and capture' },
    });

  it('CRITICAL a message to an already-closed session is 409 conflict with session_status "closed" and the closed_reason the session records', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    expect((await close(id)).statusCode).toBe(204);
    const runTurn = vi.spyOn(AgentRuntime.prototype, 'runTurn');

    const res = await send(id);
    expect(res.statusCode).toBe(409);
    expect(runTurn, 'refused before the turn started').not.toHaveBeenCalled();
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.Conflict);
    expect(body.session_status).toBe('closed');
    expect(body.closed_reason).toBe('customer-closed');
    // The same value the session itself reports.
    const session = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(session.json<{ closed_reason: string }>().closed_reason).toBe(body.closed_reason);
    // Unchanged: the sentence a person reads.
    expect(body.title).toBe('Conflict');
    expect(body.detail).toBe('Agent session is closed. Start a new agent session.');
  });

  it('the streamed turn’s final response carries the same fields', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    await close(id);

    const res = await send(id, { accept: 'text/event-stream' });
    expect(res.statusCode).toBe(200);
    const frame = /event: response\ndata: (.+)\n\n$/.exec(res.body)?.[1];
    const terminal = JSON.parse(frame ?? '{}') as { status: number; body: Problem };
    expect(terminal.status).toBe(409);
    expect(terminal.body.session_status).toBe('closed');
    expect(terminal.body.closed_reason).toBe('customer-closed');
  });

  it('a PAUSED session says "paused", and carries no closed_reason because it has none', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const repo = fx.agentSessionsRepo;
    if (repo === undefined) throw new Error('fixture has no agent sessions repo');
    const realGet = repo.get.bind(repo);
    vi.spyOn(repo, 'get').mockImplementation(async (sessionId) => {
      const session = await realGet(sessionId);
      return session === null ? null : { ...session, status: 'paused' };
    });
    // The narrow read the message route decides admission from says paused too,
    // so this is the refusal raised BEFORE the turn starts.
    const realSnapshot = repo.getAuthoritySnapshot.bind(repo);
    vi.spyOn(repo, 'getAuthoritySnapshot').mockImplementation(async (sessionId) => {
      const snapshot = await realSnapshot(sessionId);
      return snapshot === null ? null : { ...snapshot, status: 'paused' };
    });
    const runTurn = vi.spyOn(AgentRuntime.prototype, 'runTurn');

    const body = (await send(id)).json<Problem>();
    expect(body.status).toBe(409);
    expect(body.session_status).toBe('paused');
    expect(body).not.toHaveProperty('closed_reason');
    expect(body.detail).toBe(
      'Agent session is paused. Resume this agent session before sending another message.',
    );
    expect(runTurn, 'refused before the turn started').not.toHaveBeenCalled();
  });

  it('a session that closes DURING the turn keeps session_status, and now carries closed_reason as well', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const active = await fx.agentSessionsRepo?.get(id);
    if (active === null || active === undefined) throw new Error('agent session expected');
    vi.spyOn(AgentRuntime.prototype, 'runTurn').mockResolvedValue({
      kind: 'session-closed',
      reason: 'budget-exhausted',
      session: { ...active, status: 'closed', closedReason: 'budget-exhausted' },
    });

    const body = (await send(id)).json<Problem>();
    expect(body.status).toBe(409);
    expect(body.session_status).toBe('closed');
    expect(body.closed_reason).toBe('budget-exhausted');
  });

  it('a BUSY session is still told apart from an ended one: turn_in_progress, and no session_status', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const active = await fx.agentSessionsRepo?.get(id);
    if (active === null || active === undefined) throw new Error('agent session expected');
    vi.spyOn(AgentRuntime.prototype, 'runTurn').mockResolvedValue({
      kind: 'turn-in-progress',
      session: active,
    });

    const body = (await send(id)).json<Problem>();
    expect(body.status).toBe(409);
    expect(body.turn_in_progress).toBe(true);
    expect(body).not.toHaveProperty('session_status');
    expect(body).not.toHaveProperty('closed_reason');
  });
});
