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
  cleanCookieJar,
  COOKIE_JAR_CAP,
  fetchAgentSessionDownload,
  reportTransport,
  AgentSessionControlError,
  type AgentSessionCapabilityReport,
} from '../../src/lib/agent-session-control';
import { capabilityReportsEqual } from '../../src/lib/capability-report-equal';

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

  // T-26 (owner #12) — the live exit-identity fields on capability_report.
  it('getAgentSession parses the T-26 exit-identity fields when the report carries them', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'active',
        capability_report: {
          manual_input_available: true,
          streaming_state: 'live',
          egress_state: 'live',
          exit_ip: '203.0.113.7',
          exit_country: 'US',
          exit_timezone: 'America/New_York',
          // A non-string and an empty string are dropped; real IPs are kept.
          webrtc_candidate_ips: ['203.0.113.7', 42, '', '198.51.100.4'],
          observed_at: '2026-09-07T12:00:00.000Z',
        },
      }),
    );
    expect((await getAgentSession('agt_1')).capabilityReport).toMatchObject({
      exit_ip: '203.0.113.7',
      exit_country: 'US',
      exit_timezone: 'America/New_York',
      webrtc_candidate_ips: ['203.0.113.7', '198.51.100.4'],
      observed_at: '2026-09-07T12:00:00.000Z',
    });
  });

  it('getAgentSession omits the exit-identity fields when absent or wrong-typed (vacuity)', async () => {
    // Vacuity 1 — no capability_report at all → no report (so no exit fields).
    mockFetch.mockResolvedValue(ok({ mode: 'manual', status: 'active' }));
    expect((await getAgentSession('agt_1')).capabilityReport).toBeUndefined();

    // Vacuity 2 — a report carrying ONLY the h3 signal: h3 is present, and every
    // exit field is absent (the live state today, until A3 emits them). This is
    // the control that proves the "parses exit_ip" arm above is not vacuous — a
    // report without exit_ip must NOT grow one.
    mockFetch.mockResolvedValue(
      ok({ mode: 'manual', status: 'active', capability_report: { h3_connection_observed: true } }),
    );
    const h3Only = (await getAgentSession('agt_1')).capabilityReport;
    expect(h3Only?.h3_connection_observed).toBe(true);
    expect(h3Only?.exit_ip).toBeUndefined();
    expect(h3Only?.exit_country).toBeUndefined();
    expect(h3Only?.exit_timezone).toBeUndefined();
    expect(h3Only?.webrtc_candidate_ips).toBeUndefined();
    expect(h3Only?.observed_at).toBeUndefined();

    // Vacuity 3 — present but wrong-typed exit fields degrade to omitted, never
    // coerced (a number IP / non-array webrtc / empty exit_ip are dropped).
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'active',
        capability_report: {
          exit_ip: '',
          exit_country: 7,
          webrtc_candidate_ips: 'not-an-array',
          observed_at: null,
        },
      }),
    );
    const bad = (await getAgentSession('agt_1')).capabilityReport;
    expect(bad?.exit_ip).toBeUndefined();
    expect(bad?.exit_country).toBeUndefined();
    expect(bad?.webrtc_candidate_ips).toBeUndefined();
    expect(bad?.observed_at).toBeUndefined();
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

  it('uses the bearer only when the entire ControlAuth value is null (deliberate in-app path)', async () => {
    mockFetch.mockResolvedValue(ok({ pair_mode_state: { kind: 'ai-driving' } }));
    await handbackSession('agt_1', 'client-9', null);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ds_test');
    expect(headers['x-driftstack-gui-control-key']).toBeUndefined();
    expect(loadSettings).toHaveBeenCalledOnce();
    expect(loadBaseUrl).not.toHaveBeenCalled();
  });

  it.each([{ controlKey: null }, { controlKey: '' }])(
    'a non-null missing control credential fails closed without reading or sending the account key: %j',
    async (auth) => {
      await expect(getAgentSession('agt_1', auth)).rejects.toMatchObject({
        kind: 'auth_missing',
        status: 0,
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(loadSettings).not.toHaveBeenCalled();
      expect(loadBaseUrl).not.toHaveBeenCalled();
    },
  );

  it('mintGuiControlKey GETs /:id/gui-control-key and preserves the strict key + future API expiry', async () => {
    const expiresAt = '2099-07-17T12:34:56.789Z';
    const key = `gck_${'a'.repeat(32)}`;
    mockFetch.mockResolvedValue(ok({ gui_control_key: key, expires_at: expiresAt, minted: true }));
    const credential = await mintGuiControlKey('https://api.test', 'ds_test', 'agt_7');
    expect(credential).toEqual({ key, expiresAt });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/agent-sessions/agt_7/gui-control-key');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ds_test');
  });

  it.each([
    { gui_control_key: `gck_${'a'.repeat(32)}` },
    { gui_control_key: 'gck_short', expires_at: '2099-07-17T12:34:56.789Z' },
    { gui_control_key: `gck_${'0'.repeat(32)}`, expires_at: '2099-07-17T12:34:56.789Z' },
    { gui_control_key: `gck_${'a'.repeat(32)}`, expires_at: 'not-a-date' },
    { gui_control_key: `gck_${'a'.repeat(32)}`, expires_at: '2000-01-01T00:00:00.000Z' },
    { gui_control_key: `gck_${'a'.repeat(32)}`, expires_at: '2099-07-17T12:34:56Z' },
  ])('mintGuiControlKey rejects malformed or non-future credentials: %j', async (body) => {
    mockFetch.mockResolvedValue(ok(body));
    await expect(mintGuiControlKey('https://api.test', 'ds_test', 'agt_7')).resolves.toBeNull();
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

// #12 (T-26/T-27) — capabilityReportsEqual is the change-detector behind the
// simulator's manual-input snapshot. The bug: it compared ONLY the health triple
// (manual_input_available / streaming_state / egress_state), so a later report that
// changed only a live exit-identity or QUIC field was judged "unchanged" and dropped
// — the ExitIpChip and QUIC readout froze in steady state once a session had any
// report. Each arm below flips exactly one added field and asserts CHANGED; the
// vacuity arm proves byte-identical reports are still UNCHANGED (no spurious churn).
describe('capabilityReportsEqual (#12 — exit-identity / QUIC change-detection)', () => {
  // A fully-populated baseline so every field participates in the compare.
  const base: AgentSessionCapabilityReport = {
    manual_input_available: true,
    streaming_state: 'live',
    egress_state: 'live',
    exit_ip: '203.0.113.7',
    exit_country: 'US',
    exit_timezone: 'America/New_York',
    observed_at: '2026-09-07T12:00:00.000Z',
    h3_connection_observed: true,
    h3_connection_count: 3,
    reported_at: 1_700_000_000_000,
    webrtc_candidate_ips: ['203.0.113.7', '198.51.100.4'],
  };
  const withField = (
    over: Partial<AgentSessionCapabilityReport>,
  ): AgentSessionCapabilityReport => ({
    ...base,
    ...over,
  });

  it('GUARD — a report that changes only exit_ip is CHANGED (the reported bug)', () => {
    // Two DISTINCT objects that differ ONLY in exit_ip must not be judged equal.
    // Mutation: drop `a.exit_ip === b.exit_ip` from the compare → this reds.
    expect(capabilityReportsEqual(base, withField({ exit_ip: '198.51.100.9' }))).toBe(false);
  });

  it('GUARD — each other added field, changed alone, is CHANGED', () => {
    expect(capabilityReportsEqual(base, withField({ exit_country: 'CA' }))).toBe(false);
    expect(capabilityReportsEqual(base, withField({ exit_timezone: 'Europe/Paris' }))).toBe(false);
    expect(
      capabilityReportsEqual(base, withField({ observed_at: '2026-09-07T12:00:05.000Z' })),
    ).toBe(false);
    expect(capabilityReportsEqual(base, withField({ h3_connection_count: 4 }))).toBe(false);
    expect(capabilityReportsEqual(base, withField({ reported_at: 1_700_000_000_001 }))).toBe(false);
    // h3 flips from observed → absent (the parser omits it when unset).
    const noH3 = { ...base };
    delete noH3.h3_connection_observed;
    expect(capabilityReportsEqual(base, noH3)).toBe(false);
  });

  it('GUARD — webrtc_candidate_ips is compared ELEMENT-WISE (a changed leak candidate is CHANGED)', () => {
    // Same length, one element differs.
    expect(
      capabilityReportsEqual(
        base,
        withField({ webrtc_candidate_ips: ['203.0.113.7', '10.0.0.9'] }),
      ),
    ).toBe(false);
    // Different length.
    expect(capabilityReportsEqual(base, withField({ webrtc_candidate_ips: ['203.0.113.7'] }))).toBe(
      false,
    );
    // Present vs absent.
    const noIps = { ...base };
    delete noIps.webrtc_candidate_ips;
    expect(capabilityReportsEqual(base, noIps)).toBe(false);
  });

  it('VACUITY — two byte-identical (but distinct-object) reports are UNCHANGED', () => {
    // A deep clone: every field equal, different reference. Must be judged equal, so a
    // report that genuinely did not move never forces a spurious snapshot bump.
    const clone: AgentSessionCapabilityReport = {
      ...base,
      webrtc_candidate_ips: [...(base.webrtc_candidate_ips ?? [])],
    };
    expect(base).not.toBe(clone);
    expect(capabilityReportsEqual(base, clone)).toBe(true);
    // Same reference and both-null short-circuits stay true.
    expect(capabilityReportsEqual(base, base)).toBe(true);
    expect(capabilityReportsEqual(null, null)).toBe(true);
    // One null and one present is a change (the first report arriving).
    expect(capabilityReportsEqual(null, base)).toBe(false);
    expect(capabilityReportsEqual(base, null)).toBe(false);
  });
});

describe('cleanCookieJar — the jar is untrusted (page/node-supplied); sanitize at the boundary', () => {
  it('POSITIVE CONTROL a well-formed jar passes through unchanged (a sanitizer that dropped everything would satisfy the crash arms while breaking the pane)', () => {
    const jar = [
      {
        domain: '.example.com',
        name: 'sid',
        value: 'abc',
        httpOnly: true,
        sameSite: 'Lax' as const,
      },
      { domain: 'x.test', name: 'k', value: 'v', path: '/', expires: 123, secure: false },
    ];
    expect(cleanCookieJar(jar)).toEqual(jar);
  });

  it('CRITICAL drops an entry whose domain/name/value is not a string — the render calls charAt/toLowerCase/display on them, so a non-string CRASHES the Cookies pane (audit #4)', () => {
    // The exact crash inputs a compromised/buggy node can send.
    expect(cleanCookieJar([{ domain: null, name: 'a', value: 'b' }])).toEqual([]);
    expect(cleanCookieJar([{ domain: 123, name: 'a', value: 'b' }])).toEqual([]);
    expect(cleanCookieJar([{ domain: 'x', name: 456, value: 'b' }])).toEqual([]);
    expect(cleanCookieJar([{ domain: 'x', name: 'a', value: {} }])).toEqual([]);
    expect(cleanCookieJar([null, 'not-an-object', 42])).toEqual([]);
    // A good entry alongside bad ones survives; only the malformed are dropped.
    expect(
      cleanCookieJar([
        { domain: 123, name: 'a', value: 'b' },
        { domain: 'ok.test', name: 'n', value: 'v' },
      ]),
    ).toEqual([{ domain: 'ok.test', name: 'n', value: 'v' }]);
  });

  it('keeps optional fields only when well-typed — a wrong-typed optional is dropped, not carried', () => {
    const [c] = cleanCookieJar([
      {
        domain: 'x',
        name: 'n',
        value: 'v',
        path: 5,
        expires: 'soon',
        httpOnly: 'yes',
        sameSite: 'Bogus',
      },
    ])!;
    expect(c).toEqual({ domain: 'x', name: 'n', value: 'v' });
  });

  it('CRITICAL caps the jar at COOKIE_JAR_CAP so an unbounded node response cannot hang the pane (audit #4 DoS)', () => {
    const huge = Array.from({ length: COOKIE_JAR_CAP + 500 }, (_, i) => ({
      domain: 'x.test',
      name: `c${i}`,
      value: 'v',
    }));
    expect(cleanCookieJar(huge)).toHaveLength(COOKIE_JAR_CAP);
  });

  it('returns null for a non-array (the "no jar" state), distinct from an empty array', () => {
    expect(cleanCookieJar(null)).toBeNull();
    expect(cleanCookieJar(undefined)).toBeNull();
    expect(cleanCookieJar('nope')).toBeNull();
    expect(cleanCookieJar([])).toEqual([]);
  });
});
