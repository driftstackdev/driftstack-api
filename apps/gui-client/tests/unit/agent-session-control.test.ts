// Transport for the simulator session-control panel — raw-fetch against the
// agent-session control endpoints (the simulator window has no SDK client).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/settings', () => ({
  loadSettings: vi.fn().mockResolvedValue({ apiKey: 'ds_test', baseUrl: 'https://api.test' }),
}));

import { loadSettings } from '../../src/lib/settings';
import {
  getAgentSession,
  setSessionMode,
  takeoverSession,
  handbackSession,
  sendAgentMessage,
  endAgentSession,
  AgentSessionControlError,
} from '../../src/lib/agent-session-control';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function ok(body: unknown): unknown {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}
function fail(status: number, type: string, detail: string): unknown {
  return { ok: false, status, json: () => Promise.resolve({ type, detail }) };
}

afterEach(() => {
  mockFetch.mockReset();
  (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiKey: 'ds_test',
    baseUrl: 'https://api.test',
  });
});

describe('agent-session-control transport', () => {
  it('setSessionMode POSTs /mode {mode} with the bearer + returns the new state', async () => {
    mockFetch.mockResolvedValue(ok({ mode: 'manual', pair_mode_state: null }));
    const s = await setSessionMode('agt_1', 'manual');
    expect(s).toEqual({ mode: 'manual', pairKind: null });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/agent-sessions/agt_1/mode');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'manual' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ds_test');
  });

  it('takeoverSession POSTs /takeover {client_id} + returns the new pair kind', async () => {
    mockFetch.mockResolvedValue(ok({ pair_mode_state: { kind: 'human-driving' } }));
    const kind = await takeoverSession('agt_1', 'client-9');
    expect(kind).toBe('human-driving');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/agent-sessions/agt_1/takeover');
    expect(JSON.parse(init.body as string)).toEqual({ client_id: 'client-9' });
  });

  it('handbackSession POSTs /handback + returns the pair kind', async () => {
    mockFetch.mockResolvedValue(ok({ pair_mode_state: { kind: 'ai-driving' } }));
    expect(await handbackSession('agt_1')).toBe('ai-driving');
    expect((mockFetch.mock.calls[0] as [string])[0]).toContain('/handback');
  });

  it('sendAgentMessage POSTs /message {user_message}', async () => {
    mockFetch.mockResolvedValue(ok({ ok: true }));
    await sendAgentMessage('agt_1', 'go to checkout');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/message');
    expect(JSON.parse(init.body as string)).toEqual({ user_message: 'go to checkout' });
  });

  it('endAgentSession DELETEs /v1/agent-sessions/:id (closing the phone stops the session)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error('no body')),
    });
    await endAgentSession('agt_42');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/agent-sessions/agt_42');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ds_test');
  });

  it('getAgentSession GETs /:id + parses mode + pair kind', async () => {
    mockFetch.mockResolvedValue(ok({ mode: 'pair', pair_mode_state: { kind: 'ai-driving' } }));
    expect(await getAgentSession('agt_1')).toEqual({ mode: 'pair', pairKind: 'ai-driving' });
    expect((mockFetch.mock.calls[0] as [string, RequestInit])[1].method).toBe('GET');
  });

  it('maps 403 → forbidden and 409 → conflict via AgentSessionControlError', async () => {
    mockFetch.mockResolvedValue(fail(403, 'https://errors.driftstack.dev/forbidden', 'nope'));
    await expect(setSessionMode('agt_1', 'ai')).rejects.toMatchObject({
      status: 403,
      kind: 'forbidden',
    });
    mockFetch.mockResolvedValue(fail(409, 'https://errors.driftstack.dev/conflict', 'bad state'));
    await expect(setSessionMode('agt_1', 'ai')).rejects.toBeInstanceOf(AgentSessionControlError);
  });

  it('throws auth_missing WITHOUT fetching when no apiKey is configured', async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      apiKey: null,
      baseUrl: 'https://api.test',
    });
    await expect(getAgentSession('agt_1')).rejects.toMatchObject({ kind: 'auth_missing' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
