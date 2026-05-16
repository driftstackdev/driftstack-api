// AI-D SDK — unit tests for AgentSessionsResource.
//
// Pin the wire contract: method/path/body shape per endpoint, plus
// URL-encoding on the id parameter so labels with spaces or slashes
// don't break route matching.

import { describe, expect, it } from 'vitest';
import { AgentSessionsResource } from '../../src/resources/agent-sessions.js';
import type { HttpClient } from '../../src/http.js';

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

function makeFakeHttp<T>(reply: T): { http: HttpClient; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const http = {
    request: <R>(opts: { method: string; path: string; body?: unknown }) => {
      const recorded: RecordedRequest = { method: opts.method, path: opts.path };
      if (opts.body !== undefined) recorded.body = opts.body;
      calls.push(recorded);
      return Promise.resolve(reply as unknown as R);
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe('AgentSessionsResource', () => {
  it('create POSTs /v1/agent-sessions with the body verbatim', async () => {
    const reply = {
      id: 'agt_xxx',
      account_id: 'acc_1',
      driftstack_session_id: null,
      status: 'active' as const,
      closed_reason: null,
      token_budget_total: 100_000,
      token_budget_remaining: 100_000,
      transcript_length: 0,
      created_at: '2026-05-16T00:00:00Z',
      updated_at: '2026-05-16T00:00:00Z',
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    const out = await res.create({ token_budget: 50_000 });
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/agent-sessions', body: { token_budget: 50_000 } },
    ]);
    expect(out).toEqual(reply);
  });

  it('create with no body sends {} (so the server defaults token_budget)', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.create();
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/agent-sessions', body: {} });
  });

  it('get GETs /v1/agent-sessions/{id} (URL-encoded)', async () => {
    const { http, calls } = makeFakeHttp({});
    const res = new AgentSessionsResource(http);
    await res.get('agt xyz');
    expect(calls).toEqual([{ method: 'GET', path: '/v1/agent-sessions/agt%20xyz' }]);
  });

  it('message POSTs /v1/agent-sessions/{id}/message with { user_message }', async () => {
    const reply = {
      kind: 'plan-executed' as const,
      session: {
        id: 'agt_1',
        account_id: 'acc_1',
        driftstack_session_id: null,
        status: 'active' as const,
        closed_reason: null,
        token_budget_total: 100_000,
        token_budget_remaining: 99_000,
        transcript_length: 2,
        created_at: '2026-05-16T00:00:00Z',
        updated_at: '2026-05-16T00:00:01Z',
      },
      intents: [{ kind: 'navigate' as const, url: 'https://example.com' }],
      results: [
        {
          kind: 'success' as const,
          intent: { kind: 'navigate' as const, url: 'https://example.com' },
          summary: 'navigated',
        },
      ],
      ok: true,
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new AgentSessionsResource(http);
    const out = await res.message('agt_1', 'open https://example.com');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/agent-sessions/agt_1/message',
        body: { user_message: 'open https://example.com' },
      },
    ]);
    expect(out.kind).toBe('plan-executed');
  });

  it('close DELETEs /v1/agent-sessions/{id} (URL-encoded)', async () => {
    const { http, calls } = makeFakeHttp(undefined as unknown as void);
    const res = new AgentSessionsResource(http);
    await res.close('agt with space');
    expect(calls).toEqual([{ method: 'DELETE', path: '/v1/agent-sessions/agt%20with%20space' }]);
  });
});
