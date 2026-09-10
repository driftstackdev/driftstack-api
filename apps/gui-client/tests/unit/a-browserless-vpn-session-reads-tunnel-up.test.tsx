// (b) VPN exit parity — a VPN session's honest in-between state.
//
// The harness brings the OpenVPN/WireGuard tunnel up and reports the exit it
// observed (`exit_ip`, `exit_timezone`) on the capability report BEFORE the
// browser attaches to it, so for a while the cockpit holds a measured exit and
// no live stream. The address bars said a generic "connecting…", which
// under-describes that: the tunnel is up; the browser is what has not attached
// (today's harness behaviour, stated as such). With `proxy_kind` on the report
// the bars now say so — and the socks5 path is unchanged (the vacuity control).
//
// Layers:
//   • the parser keeps `proxy_kind` for the three known kinds only;
//   • the pure predicate answers null for a live stream, a non-VPN kind, or a
//     report without an exit IP;
//   • rendered: the Controls-pane address bar and the browser-mode bar each show
//     the tunnel-up caption + notice instead of "connecting…", and drop them the
//     moment the stream is live.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';
import type * as ControlModule from '../../src/lib/agent-session-control';
import type * as SettingsModule from '../../src/lib/settings';

const sendNavigate = vi.fn(() => Promise.resolve());
const getAgentSession = vi.fn((): Promise<unknown> => new Promise(() => {}));
type ControlState = {
  mode: 'manual';
  pairKind: null;
  terminal: false;
  status: 'active';
  closedReason: null;
  capabilityReport: Partial<AgentSessionCapabilityReport>;
};
let manualControlState: ControlState = {
  mode: 'manual',
  pairKind: null,
  terminal: false,
  status: 'active',
  closedReason: null,
  capabilityReport: { manual_input_available: true },
};
function immediateControl<T>(value: T): Promise<T> {
  return {
    then: (onfulfilled: (resolved: T) => unknown) => {
      try {
        return Promise.resolve(onfulfilled(value));
      } catch (err: unknown) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  } as unknown as Promise<T>;
}

const localStore = new Map<string, string>();
beforeEach(() => {
  sendNavigate.mockClear();
  getAgentSession.mockReset();
  getAgentSession.mockImplementation(() => immediateControl(manualControlState));
  localStore.clear();
  localStore.set('ds-sim-browser-mode', '0');
  localStore.set('ds-sim-navigated', '1');
  vi.stubGlobal('localStorage', {
    getItem: (k: string): string | null => localStore.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      localStore.set(k, v);
    },
    removeItem: (k: string): void => {
      localStore.delete(k);
    },
    clear: (): void => localStore.clear(),
    key: (): string | null => null,
    length: 0,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate,
  sendTabListUpdate: vi.fn(() => Promise.resolve()),
  sendActivateTab: vi.fn(() => Promise.resolve('req_test')),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    DataReceived: 'dataReceived',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};

const panelCbs: {
  onRoom?: (room: unknown, ownerRoom: unknown) => void;
  onStateChange?: (s: { kind: string }, room: unknown) => void;
  onPublisher?: (p: string, room: unknown) => void;
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    panelCbs.onRoom = props.onRoom;
    panelCbs.onStateChange = props.onStateChange;
    panelCbs.onPublisher = props.onPublisher;
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// The parser arm below calls the REAL getAgentSession, whose authed fetch reads
// the API key through loadSettings (a Tauri store jsdom cannot open); only the
// two loaders are replaced, every other settings export stays real.
vi.mock('../../src/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsModule>()),
  loadSettings: vi.fn(() => Promise.resolve({ apiKey: 'ds_test', baseUrl: 'https://api.test' })),
  loadBaseUrl: vi.fn(() => Promise.resolve('https://api.test')),
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession,
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow, vpnTunnelUpNotice, vpnTunnelUpCaption } =
  await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

const TUNNEL_UP_SENTENCE =
  'VPN tunnel is up (exit 203.0.113.7, Europe/Amsterdam) — the browser has not attached yet';

function report(extra: Partial<AgentSessionCapabilityReport>): AgentSessionCapabilityReport {
  return { manual_input_available: true, streaming_state: null, egress_state: null, ...extra };
}

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

function goLive(): void {
  act(() => {
    panelCbs.onRoom?.(fakeRoom, fakeRoom);
    panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
    panelCbs.onPublisher?.('publishing', fakeRoom);
  });
}

describe('the capability-report parser — proxy_kind is a closed set', () => {
  it('keeps openvpn / wireguard / socks5 and drops anything else, without touching the other fields', async () => {
    const actual = await vi.importActual<typeof ControlModule>(
      '../../src/lib/agent-session-control',
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ok = (body: unknown): unknown => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    for (const kind of ['openvpn', 'wireguard', 'socks5']) {
      fetchMock.mockResolvedValue(
        ok({
          mode: 'manual',
          status: 'active',
          capability_report: { proxy_kind: kind, exit_ip: '203.0.113.7' },
        }),
      );
      const parsed = await actual.getAgentSession('agt_1');
      expect(parsed.capabilityReport?.proxy_kind).toBe(kind);
      expect(parsed.capabilityReport?.exit_ip).toBe('203.0.113.7');
    }
    for (const bad of ['http', 42, null, '']) {
      fetchMock.mockResolvedValue(
        ok({ mode: 'manual', status: 'active', capability_report: { proxy_kind: bad } }),
      );
      const parsed = await actual.getAgentSession('agt_1');
      expect(parsed.capabilityReport).toBeDefined();
      expect(parsed.capabilityReport !== undefined && 'proxy_kind' in parsed.capabilityReport).toBe(
        false,
      );
    }
  });
});

describe('vpnTunnelUpNotice — the pure predicate', () => {
  it('is non-null only for a VPN kind + an exit IP + a stream that is NOT live', () => {
    const vpn = report({
      proxy_kind: 'openvpn',
      exit_ip: '203.0.113.7',
      exit_timezone: 'Europe/Amsterdam',
    });
    expect(vpnTunnelUpNotice(vpn, { streamLive: false, everLive: false, ended: false })).toEqual({
      ip: '203.0.113.7',
      timezone: 'Europe/Amsterdam',
      source: 'report',
    });
    expect(
      vpnTunnelUpNotice(report({ proxy_kind: 'wireguard', exit_ip: '203.0.113.7' }), {
        streamLive: false,
        everLive: false,
        ended: false,
      }),
    ).toEqual({ ip: '203.0.113.7', timezone: null, source: 'report' });
    // Live stream → the generic state is over; nothing to say.
    expect(vpnTunnelUpNotice(vpn, { streamLive: true, everLive: false, ended: false })).toBeNull();
    // A stream that WAS live and dropped is "reconnecting", and an ended session is
    // attaching nothing — "the browser has not attached yet" would be false in both.
    expect(vpnTunnelUpNotice(vpn, { streamLive: false, everLive: true, ended: false })).toBeNull();
    expect(vpnTunnelUpNotice(vpn, { streamLive: false, everLive: false, ended: true })).toBeNull();
    // (c) — the harness's own provisioning_detail wins, and needs no report at all:
    // the node said the tunnel is up and is deliberately not claiming active yet.
    const quiet = { streamLive: false, everLive: false, ended: false };
    expect(vpnTunnelUpNotice(null, { ...quiet, provisioningDetail: 'vpn_egress_active' })).toEqual({
      ip: null,
      timezone: null,
      source: 'detail',
    });
    expect(vpnTunnelUpNotice(vpn, { ...quiet, provisioningDetail: 'vpn_egress_active' })).toEqual({
      ip: '203.0.113.7',
      timezone: 'Europe/Amsterdam',
      source: 'detail',
    });
    // …but never after the stream was live, or once the session ended, and an
    // unrelated token does not fire it.
    expect(
      vpnTunnelUpNotice(null, {
        ...quiet,
        everLive: true,
        provisioningDetail: 'vpn_egress_active',
      }),
    ).toBeNull();
    expect(
      vpnTunnelUpNotice(null, { ...quiet, ended: true, provisioningDetail: 'vpn_egress_active' }),
    ).toBeNull();
    expect(vpnTunnelUpNotice(null, { ...quiet, provisioningDetail: 'dns_resolving' })).toBeNull();
    expect(vpnTunnelUpCaption({ ip: null, timezone: null, source: 'detail' })).toBe(
      'VPN tunnel connected — starting the browser…',
    );
    expect(
      vpnTunnelUpCaption({ ip: '203.0.113.7', timezone: 'Europe/Amsterdam', source: 'detail' }),
    ).toBe('VPN tunnel connected (exit 203.0.113.7, Europe/Amsterdam) — starting the browser…');
    // A SOCKS5 session, an unknown kind, or no exit yet → generic "connecting…".
    expect(
      vpnTunnelUpNotice(report({ proxy_kind: 'socks5', exit_ip: '203.0.113.7' }), {
        streamLive: false,
        everLive: false,
        ended: false,
      }),
    ).toBeNull();
    expect(
      vpnTunnelUpNotice(report({ exit_ip: '203.0.113.7' }), {
        streamLive: false,
        everLive: false,
        ended: false,
      }),
    ).toBeNull();
    expect(
      vpnTunnelUpNotice(report({ proxy_kind: 'openvpn' }), {
        streamLive: false,
        everLive: false,
        ended: false,
      }),
    ).toBeNull();
    expect(
      vpnTunnelUpNotice(null, { streamLive: false, everLive: false, ended: false }),
    ).toBeNull();
  });

  it('the caption names the exit and the zone, and omits the zone when there is none', () => {
    expect(
      vpnTunnelUpCaption({ ip: '203.0.113.7', timezone: 'Europe/Amsterdam', source: 'report' }),
    ).toBe(TUNNEL_UP_SENTENCE);
    expect(vpnTunnelUpCaption({ ip: '203.0.113.7', timezone: null, source: 'report' })).toBe(
      'VPN tunnel is up (exit 203.0.113.7) — the browser has not attached yet',
    );
  });
});

describe('SimulatorWindow — a VPN session with an observed exit and no stream reads "tunnel up"', () => {
  it('CRITICAL the Controls-pane address bar says the tunnel is up (not "connecting…"), then unlocks when the stream is live', () => {
    manualControlState = {
      ...manualControlState,
      capabilityReport: {
        manual_input_available: true,
        proxy_kind: 'openvpn',
        exit_ip: '203.0.113.7',
        exit_timezone: 'Europe/Amsterdam',
      },
    };
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);

    const caption = container.querySelector('[data-component="simulator-address-vpn-tunnel-up"]');
    expect(caption).not.toBeNull();
    expect(caption?.textContent).toContain('203.0.113.7');
    expect(container.querySelector('[data-component="simulator-address-connecting"]')).toBeNull();
    const notice = container.querySelector('[data-component="simulator-vpn-tunnel-up-notice"]');
    expect(notice?.textContent).toBe(TUNNEL_UP_SENTENCE);
    const input = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    // Still locked — the tunnel being up is not the browser being attached.
    expect(input.disabled).toBe(true);
    expect(input.getAttribute('placeholder')).toContain('VPN tunnel is up');
    expect(input.getAttribute('title')).toBe(TUNNEL_UP_SENTENCE);

    goLive();
    expect(
      (container.querySelector('[aria-label="Address bar"]') as HTMLInputElement).disabled,
    ).toBe(false);
    expect(
      container.querySelector('[data-component="simulator-address-vpn-tunnel-up"]'),
    ).toBeNull();
    expect(container.querySelector('[data-component="simulator-vpn-tunnel-up-notice"]')).toBeNull();
  });

  it('the browser-mode bar carries the same cue and notice', () => {
    localStore.set('ds-sim-browser-mode', '1');
    manualControlState = {
      ...manualControlState,
      capabilityReport: {
        manual_input_available: true,
        proxy_kind: 'wireguard',
        exit_ip: '203.0.113.7',
        exit_timezone: 'Europe/Amsterdam',
      },
    };
    const { container } = renderSim();
    const cue = container.querySelector('[data-component="simulator-address-bar-vpn-tunnel-up"]');
    expect(cue?.textContent).toContain('203.0.113.7');
    expect(cue?.getAttribute('title')).toBe(TUNNEL_UP_SENTENCE);
    expect(
      container.querySelector('[data-component="simulator-address-bar-connecting"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-component="simulator-vpn-tunnel-up-notice"]')?.textContent,
    ).toBe(TUNNEL_UP_SENTENCE);
    goLive();
    expect(
      container.querySelector('[data-component="simulator-address-bar-vpn-tunnel-up"]'),
    ).toBeNull();
    expect(container.querySelector('[data-component="simulator-vpn-tunnel-up-notice"]')).toBeNull();
  });

  it('VACUITY CONTROL — a SOCKS5 session with the same exit fields keeps the generic "connecting…"', () => {
    manualControlState = {
      ...manualControlState,
      capabilityReport: {
        manual_input_available: true,
        proxy_kind: 'socks5',
        exit_ip: '203.0.113.7',
        exit_timezone: 'Europe/Amsterdam',
      },
    };
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);
    expect(
      container.querySelector('[data-component="simulator-address-vpn-tunnel-up"]'),
    ).toBeNull();
    expect(container.querySelector('[data-component="simulator-vpn-tunnel-up-notice"]')).toBeNull();
    expect(
      container.querySelector('[data-component="simulator-address-connecting"]'),
    ).not.toBeNull();
    const input = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toContain('connecting…');
  });

  it('VACUITY CONTROL — a VPN report with no exit yet is still "connecting…" (the tunnel is not known to be up)', () => {
    manualControlState = {
      ...manualControlState,
      capabilityReport: { manual_input_available: true, proxy_kind: 'openvpn' },
    };
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);
    expect(
      container.querySelector('[data-component="simulator-address-vpn-tunnel-up"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-component="simulator-address-connecting"]'),
    ).not.toBeNull();
  });
});
