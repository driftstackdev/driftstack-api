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
  mintGuiControlKey,
  getPageState,
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

  // gui_control_key control-auth (separate-simulator-app path).

  it('sends the x-driftstack-gui-control-key header (NOT Authorization) when a control key is supplied', async () => {
    mockFetch.mockResolvedValue(ok({ mode: 'manual', pair_mode_state: null }));
    await setSessionMode('agt_1', 'manual', { controlKey: 'gck_abc123' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-driftstack-gui-control-key']).toBe('gck_abc123');
    // The control key REPLACES the bearer — never both.
    expect(headers.Authorization).toBeUndefined();
  });

  it('endAgentSession + sendAgentMessage send the control-key header (NOT Authorization) when a control key is supplied', async () => {
    // window-close DELETE with a control key.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error('no body')),
    });
    await endAgentSession('agt_1', { controlKey: 'gck_del' });
    const delInit = (mockFetch.mock.calls[0] as [string, RequestInit])[1];
    const delHeaders = delInit.headers as Record<string, string>;
    expect(delInit.method).toBe('DELETE');
    expect(delHeaders['x-driftstack-gui-control-key']).toBe('gck_del');
    expect(delHeaders.Authorization).toBeUndefined();
    // composer "tell the agent" POST /message with a control key.
    mockFetch.mockResolvedValueOnce(ok({ ok: true }));
    await sendAgentMessage('agt_1', 'go to checkout', { controlKey: 'gck_msg' });
    const [msgUrl, msgInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const msgHeaders = msgInit.headers as Record<string, string>;
    expect(msgUrl).toContain('/message');
    expect(msgInit.method).toBe('POST');
    expect(msgHeaders['x-driftstack-gui-control-key']).toBe('gck_msg');
    expect(msgHeaders.Authorization).toBeUndefined();
  });

  it('the control key authorizes EVEN WHEN no apiKey is configured (the separate-app case)', async () => {
    (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      apiKey: null,
      baseUrl: 'https://api.test',
    });
    mockFetch.mockResolvedValue(ok({ mode: 'pair', pair_mode_state: { kind: 'ai-driving' } }));
    const s = await getAgentSession('agt_1', { controlKey: 'gck_xyz' });
    expect(s).toEqual({ mode: 'pair', pairKind: 'ai-driving' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-driftstack-gui-control-key']).toBe(
      'gck_xyz',
    );
  });

  it('falls back to the bearer when controlKey is null (in-app window)', async () => {
    mockFetch.mockResolvedValue(ok({ pair_mode_state: { kind: 'ai-driving' } }));
    await handbackSession('agt_1', null);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ds_test');
    expect(headers['x-driftstack-gui-control-key']).toBeUndefined();
  });

  it('mintGuiControlKey GETs /:id/gui-control-key with the bearer + returns the plaintext', async () => {
    mockFetch.mockResolvedValue(ok({ gui_control_key: 'gck_minted', minted: true }));
    const key = await mintGuiControlKey('https://api.test', 'ds_test', 'agt_7');
    expect(key).toBe('gck_minted');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/agent-sessions/agt_7/gui-control-key');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ds_test');
  });

  it('mintGuiControlKey returns null (never throws) on a non-2xx so the launch degrades gracefully', async () => {
    mockFetch.mockResolvedValue(fail(404, 'https://errors.driftstack.dev/not-found', 'gone'));
    expect(await mintGuiControlKey('https://api.test', 'ds_test', 'agt_7')).toBeNull();
  });

  // getPageState — GUI-side liveness probe for boundSession (founder 2026-06-18).

  it('getPageState GETs /:id/page-state with the bearer + returns TRUE when page_state is non-null (a worker is driving the page)', async () => {
    mockFetch.mockResolvedValue(ok({ page_state: { state: 'loaded' } }));
    const present = await getPageState('https://api.test', 'ds_test', 'agt_live');
    expect(present).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/agent-sessions/agt_live/page-state');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ds_test');
  });

  it('getPageState returns FALSE when page_state is null (no worker is publishing — active-but-dead session)', async () => {
    mockFetch.mockResolvedValue(ok({ page_state: null }));
    expect(await getPageState('https://api.test', 'ds_test', 'agt_dead')).toBe(false);
  });

  it('getPageState returns null (never throws) on a non-2xx so boundSession falls back to trusting the binding', async () => {
    mockFetch.mockResolvedValue(fail(503, 'https://errors.driftstack.dev/unavailable', 'no fleet'));
    expect(await getPageState('https://api.test', 'ds_test', 'agt_x')).toBeNull();
  });
});
