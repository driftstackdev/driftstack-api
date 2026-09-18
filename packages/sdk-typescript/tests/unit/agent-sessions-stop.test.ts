// B2 — `agentSessions.stop()`: driven, not read. What a source-text pin cannot
// show is that calling the method puts the request on the wire; this records it.

import { describe, expect, it, vi } from 'vitest';
import { AgentSessionsResource } from '../../src/resources/agent-sessions.js';
import type { HttpClient } from '../../src/http.js';

type RequestOpts = { method: string; path: string; body?: unknown };

function recorder<T>(reply: T): { http: HttpClient; calls: RequestOpts[] } {
  const calls: RequestOpts[] = [];
  const request = vi.fn((opts: RequestOpts) => {
    calls.push(opts);
    return Promise.resolve(reply);
  });
  return { http: { request } as unknown as HttpClient, calls };
}

describe('AgentSessionsResource.stop', () => {
  it('POSTs an empty JSON object to the stop sub-path, the session id escaped', async () => {
    const { http, calls } = recorder({ status: 'stop_requested', session_id: 'agt x' });
    const out = await new AgentSessionsResource(http).stop('agt x');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/agent-sessions/agt%20x/stop');
    // The server's body schema is strict: `{}`, never an omitted body a proxy
    // could turn into something else, never a stray field.
    expect(calls[0]?.body).toEqual({});
    expect(out).toEqual({ status: 'stop_requested', session_id: 'agt x' });
  });

  it('returns the "nothing was running" answer as a success, not an error', async () => {
    const { http } = recorder({ status: 'no_turn_running', session_id: 'agt_1' });
    const out = await new AgentSessionsResource(http).stop('agt_1');
    expect(out.status).toBe('no_turn_running');
  });
});
