// Transport for the simulator session-control panel — raw-fetch against the
// agent-session control endpoints (the simulator window has no SDK client).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/settings', () => ({
  loadSettings: vi.fn().mockResolvedValue({ apiKey: 'ds_test', baseUrl: 'https://api.test' }),
  loadBaseUrl: vi.fn().mockResolvedValue('https://api.test'),
}));

import { loadBaseUrl, loadSettings } from '../../src/lib/settings';
import {
  getAgentSession,
  setSessionMode,
  takeoverSession,
  heartbeatPairSession,
  handbackSession,
  sendAgentMessage,
  endAgentSession,
  mintGuiControlKey,
  getAgentSessionCookies,
  fetchAgentSessionDownload,
  reportTransport,
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
  vi.useRealTimers();
  (loadSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiKey: 'ds_test',
    baseUrl: 'https://api.test',
  });
  (loadSettings as ReturnType<typeof vi.fn>).mockClear();
  (loadBaseUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://api.test');
  (loadBaseUrl as ReturnType<typeof vi.fn>).mockClear();
});

describe('agent-session-control transport', () => {
  it('setSessionMode POSTs /mode {mode} with the bearer + returns the new state', async () => {
    mockFetch.mockResolvedValue(ok({ mode: 'manual', pair_mode_state: null, status: 'active' }));
    const s = await setSessionMode('agt_1', 'manual');
    expect(s).toEqual({
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
    });
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

  it('heartbeatPairSession POSTs an owner-attributed ping input-event', async () => {
    mockFetch.mockResolvedValue(ok({ kind: 'forwarded', duration_ms: 0 }));
    await heartbeatPairSession('agt_1', 'client-9');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/agent-sessions/agt_1/input-event');
    const body = JSON.parse(init.body as string) as {
      event: { type: string; timestamp: number };
      client_id: string;
    };
    expect(body.client_id).toBe('client-9');
    expect(body.event.type).toBe('ping');
    expect(Number.isSafeInteger(body.event.timestamp)).toBe(true);
  });

  it('handbackSession POSTs /handback + returns the pair kind', async () => {
    mockFetch.mockResolvedValue(ok({ pair_mode_state: { kind: 'ai-driving' } }));
    expect(await handbackSession('agt_1', 'client-9')).toBe('ai-driving');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/handback');
    expect(JSON.parse(init.body as string)).toEqual({ client_id: 'client-9' });
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
    mockFetch.mockResolvedValue(
      ok({ mode: 'pair', pair_mode_state: { kind: 'ai-driving' }, status: 'active' }),
    );
    expect(await getAgentSession('agt_1')).toEqual({
      mode: 'pair',
      pairKind: 'ai-driving',
      terminal: false,
      status: 'active',
      closedReason: null,
    });
    expect((mockFetch.mock.calls[0] as [string, RequestInit])[1].method).toBe('GET');
  });

  it('getAgentSession preserves validated harness input, streaming, and egress health', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'active',
        capability_report: {
          manual_input_available: false,
          streaming_state: 'blank',
          egress_state: 'dead_proxy',
          proxy_kind: 'socks5',
        },
      }),
    );
    expect(await getAgentSession('agt_1')).toMatchObject({
      capabilityReport: {
        manual_input_available: false,
        streaming_state: 'blank',
        egress_state: 'dead_proxy',
      },
    });
  });

  it('getAgentSession omits a malformed capability envelope and nulls unknown nested states', async () => {
    mockFetch.mockResolvedValue(
      ok({ mode: 'manual', status: 'active', capability_report: 'not-an-object' }),
    );
    expect((await getAgentSession('agt_1')).capabilityReport).toBeUndefined();

    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'active',
        capability_report: {
          manual_input_available: 'yes',
          streaming_state: 'fine',
          egress_state: 'maybe',
        },
      }),
    );
    expect((await getAgentSession('agt_1')).capabilityReport).toEqual({
      manual_input_available: null,
      streaming_state: null,
      egress_state: null,
    });
  });

  it('getAgentSession preserves a validated harness error and ignores malformed customer state', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'closed',
        error_event: {
          code: 'launch_timeout',
          severity: 'error',
          summary: 'The live browser did not become ready in time.',
          customer_actionable: false,
          retryable: true,
        },
      }),
    );
    expect((await getAgentSession('agt_1')).errorEvent).toEqual({
      code: 'launch_timeout',
      severity: 'error',
      summary: 'The live browser did not become ready in time.',
      customer_actionable: false,
      retryable: true,
    });

    mockFetch.mockResolvedValue(
      ok({ mode: 'manual', status: 'closed', error_event: { code: 'x', severity: 'critical' } }),
    );
    expect((await getAgentSession('agt_1')).errorEvent).toBeUndefined();
  });

  it('getAgentSession refreshes the exact pair controller heartbeat after a human-driving read', async () => {
    mockFetch
      .mockResolvedValueOnce(
        ok({ mode: 'pair', pair_mode_state: { kind: 'human-driving' }, status: 'active' }),
      )
      .mockResolvedValueOnce(ok({ kind: 'forwarded', duration_ms: 0 }));

    const state = await getAgentSession('agt_1', null, { heartbeatClientId: 'client-9' });
    expect(state.pairKind).toBe('human-driving');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/v1/agent-sessions/agt_1/input-event');
    expect(JSON.parse(init.body as string)).toMatchObject({
      event: { type: 'ping' },
      client_id: 'client-9',
    });
  });

  // P1a — terminal-end detection: the session lifecycle status going 'closed' (or a
  // closed_at / closed_reason being set) reads as terminal so the simulator stops
  // reconnecting against a session that's gone.
  it('getAgentSession reports terminal=true when status is closed (+ surfaces the close reason)', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        pair_mode_state: null,
        status: 'closed',
        closed_reason: 'idle_timeout',
        closed_at: '2026-06-25T00:00:00.000Z',
      }),
    );
    expect(await getAgentSession('agt_1')).toEqual({
      mode: 'manual',
      pairKind: null,
      terminal: true,
      status: 'closed',
      closedReason: 'idle_timeout',
    });
  });

  it('getAgentSession reports terminal=true on closed_at/closed_reason even if status is still active (stale lifecycle row)', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        pair_mode_state: null,
        status: 'active',
        closed_at: '2026-06-25T00:00:00.000Z',
      }),
    );
    const s = await getAgentSession('agt_1');
    expect(s.terminal).toBe(true);
  });

  it('getAgentSession reports terminal=false for a live session AND for an OLD server with NO status field (unknown → trust the binding, never a false ended)', async () => {
    mockFetch.mockResolvedValue(ok({ mode: 'manual', pair_mode_state: null, status: 'active' }));
    expect((await getAgentSession('agt_1')).terminal).toBe(false);
    // Old server / minimal body with no lifecycle fields → NOT terminal.
    mockFetch.mockResolvedValue(ok({ mode: 'manual', pair_mode_state: null }));
    const s = await getAgentSession('agt_1');
    expect(s.terminal).toBe(false);
    expect(s.status).toBe(null);
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

  it('aborts a stalled control request after 15 seconds', async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const pending = getAgentSession('agt_1');
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
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
    expect(loadSettings).not.toHaveBeenCalled();
    expect(loadBaseUrl).toHaveBeenCalledOnce();
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

  it('the control key authorizes without reading the account credential (the separate-app case)', async () => {
    mockFetch.mockResolvedValue(
      ok({ mode: 'pair', pair_mode_state: { kind: 'ai-driving' }, status: 'active' }),
    );
    const s = await getAgentSession('agt_1', { controlKey: 'gck_xyz' });
    expect(s).toEqual({
      mode: 'pair',
      pairKind: 'ai-driving',
      terminal: false,
      status: 'active',
      closedReason: null,
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-driftstack-gui-control-key']).toBe(
      'gck_xyz',
    );
    expect(loadSettings).not.toHaveBeenCalled();
    expect(loadBaseUrl).toHaveBeenCalledOnce();
  });

  it('falls back to the bearer when controlKey is null (in-app window)', async () => {
    mockFetch.mockResolvedValue(ok({ pair_mode_state: { kind: 'ai-driving' } }));
    await handbackSession('agt_1', 'client-9', null);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ds_test');
    expect(headers['x-driftstack-gui-control-key']).toBeUndefined();
    expect(loadSettings).toHaveBeenCalledOnce();
    expect(loadBaseUrl).not.toHaveBeenCalled();
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

  it('mintGuiControlKey aborts after 15 seconds and still degrades to null', async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const pending = mintGuiControlKey('https://api.test', 'ds_test', 'agt_7');
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toBeNull();
  });

  // Founder #48 — live cookie-jar pull (the drawer's Cookies section data source).

  it('getAgentSessionCookies GETs /:id/cookies + returns the ok jar', async () => {
    const jar = [
      { domain: '.example.com', name: 'sid', value: 'abc', httpOnly: true, sameSite: 'Lax' },
    ];
    mockFetch.mockResolvedValue(ok({ status: 'ok', cookies: jar }));
    const res = await getAgentSessionCookies('agt_1');
    expect(res).toEqual({ status: 'ok', cookies: jar });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/agent-sessions/agt_1/cookies');
    expect(init.method).toBe('GET');
  });

  it('getAgentSessionCookies passes through an inert discriminated body ({status,reason}, cookies:null)', async () => {
    mockFetch.mockResolvedValue(
      ok({ status: 'unavailable', cookies: null, reason: 'session node is not connected' }),
    );
    const res = await getAgentSessionCookies('agt_1');
    expect(res).toEqual({
      status: 'unavailable',
      cookies: null,
      reason: 'session node is not connected',
    });
  });

  it('ControlAuth.baseUrl overrides the store baseUrl (separate app targets the handed-off host, not localhost)', async () => {
    mockFetch.mockResolvedValue(ok({ status: 'ok', cookies: [] }));
    // The separate app's store would default to localhost; the launch hands off
    // the real host on ControlAuth so the request targets it (race-free).
    await getAgentSessionCookies('agt_1', { controlKey: 'gck_x', baseUrl: 'https://real.host' });
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://real.host/v1/agent-sessions/agt_1/cookies');
    expect(loadSettings).not.toHaveBeenCalled();
    expect(loadBaseUrl).not.toHaveBeenCalled();
  });

  it('getAgentSessionCookies sends the control-key header (separate Simulator app)', async () => {
    mockFetch.mockResolvedValue(ok({ status: 'timeout', cookies: null }));
    const res = await getAgentSessionCookies('agt_1', { controlKey: 'gck_cook' });
    expect(res).toEqual({ status: 'timeout', cookies: null });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-driftstack-gui-control-key']).toBe('gck_cook');
    expect(headers.Authorization).toBeUndefined();
  });

  it('fetchAgentSessionDownload opts into binary and keeps the response body streaming', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'application/octet-stream' },
    });
    mockFetch.mockResolvedValue(response);

    const result = await fetchAgentSessionDownload('agt_1', 'report.pdf', {
      controlKey: 'gck_download',
      baseUrl: 'https://real.host',
    });

    expect(result).toEqual({ status: 'ok', file: { name: 'report.pdf', response } });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://real.host/v1/agent-sessions/agt_1/downloads/content?name=report.pdf&format=binary',
    );
    expect((init.headers as Record<string, string>).Accept).toBe(
      'application/octet-stream, application/json',
    );
    expect((init.headers as Record<string, string>)['x-driftstack-gui-control-key']).toBe(
      'gck_download',
    );
    expect(response.bodyUsed).toBe(false);
  });

  it('fetchAgentSessionDownload preserves a small JSON unavailable outcome', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'unavailable',
          file: null,
          reason: 'session node is not connected',
        }),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      ),
    );

    await expect(fetchAgentSessionDownload('agt_1', 'report.pdf')).resolves.toEqual({
      status: 'unavailable',
      file: null,
      reason: 'session node is not connected',
    });
  });

  it('keeps the download request alive through the server relay window, then aborts at 45 seconds', async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    mockFetch.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted();
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const pending = fetchAgentSessionDownload('agt_1', 'large.bin');
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(aborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(aborted).toHaveBeenCalledOnce();
  });

  // W2679 — the GUI-side page-state probe (getPageState) is GONE: the server now
  // reports per-session `liveness` (state + fresh) inline on the agent-session
  // list/get, so boundSession reads liveness off the list entry directly. No
  // page-state transport remains in this module.
});

describe('reportTransport (#60 transport telemetry)', () => {
  it('POSTs the report to /transport-report with the control-key header (best-effort)', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204, json: () => Promise.resolve({}) });
    await reportTransport(
      'agt_1',
      { transport: 'tcp', relayed: true, rtt_ms: 844, packet_loss_recent_pct: 2 },
      { controlKey: 'ck-9', baseUrl: 'https://api.test' },
    );
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/agent-sessions/agt_1/transport-report');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      transport: 'tcp',
      relayed: true,
      rtt_ms: 844,
      packet_loss_recent_pct: 2,
    });
    expect((init.headers as Record<string, string>)['x-driftstack-gui-control-key']).toBe('ck-9');
  });

  it('is best-effort: a rejected fetch does NOT throw', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(
      reportTransport('agt_1', {
        transport: 'udp',
        relayed: false,
        rtt_ms: null,
        packet_loss_recent_pct: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('is best-effort: a non-2xx response does NOT throw', async () => {
    mockFetch.mockResolvedValue(fail(404, 'about:blank', 'not found'));
    await expect(
      reportTransport('agt_1', {
        transport: 'udp',
        relayed: false,
        rtt_ms: 10,
        packet_loss_recent_pct: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('no-ops on an empty session id (no fetch)', async () => {
    await reportTransport('', {
      transport: 'udp',
      relayed: false,
      rtt_ms: null,
      packet_loss_recent_pct: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
