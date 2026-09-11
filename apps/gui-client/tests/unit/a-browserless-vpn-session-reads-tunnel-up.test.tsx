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
  provisioningDetail?: string | null;
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

// (h) — the in-place relaunch listener and the Dock tile are Tauri-only; both
// are captured here so the swap and the flag source can be driven in jsdom.
const tauriListeners = new Map<string, (event: { payload: string }) => void>();
const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve());
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (event: { payload: string }) => void) => {
    tauriListeners.set(name, cb);
    return Promise.resolve(() => tauriListeners.delete(name));
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
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
  AgentSessionControlError: class extends Error {
    status?: number;
  },
}));

const {
  SimulatorWindow,
  vpnTunnelUpNotice,
  vpnTunnelUpCaption,
  vpnTunnelIsUp,
  vpnTunnelChipText,
  vpnAddressPlaceholder,
  nextEverLiveLatch,
} = await import('../../src/views/SimulatorWindow');
const { AgentSessionControlError } = await import('../../src/lib/agent-session-control');
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
      vpn: true,
    });
    expect(
      vpnTunnelUpNotice(report({ proxy_kind: 'wireguard', exit_ip: '203.0.113.7' }), {
        streamLive: false,
        everLive: false,
        ended: false,
      }),
    ).toEqual({ ip: '203.0.113.7', timezone: null, source: 'report', vpn: true });
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
      step: 'vpn_egress_active',
      vpn: true,
    });
    expect(vpnTunnelUpNotice(vpn, { ...quiet, provisioningDetail: 'vpn_egress_active' })).toEqual({
      ip: '203.0.113.7',
      timezone: 'Europe/Amsterdam',
      source: 'detail',
      step: 'vpn_egress_active',
      vpn: true,
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
    // (f) — the harness's three steps, each with its own caption; the browser step is
    // announced by its OWN token (browser_spawning). Until the harness emits it,
    // vpn_egress_active is the LAST thing a VPN session says before its launch timeout,
    // so that caption states the limit instead of promising progress that is not coming.
    for (const step of [
      'vpn_egress_bringing_up',
      'egress_geo_resolving',
      'browser_spawning',
    ] as const) {
      expect(vpnTunnelUpNotice(null, { ...quiet, provisioningDetail: step })?.step, step).toBe(
        step,
      );
    }
    expect(
      vpnTunnelUpNotice(null, { ...quiet, provisioningDetail: 'vpn_egress_activex' }),
    ).toBeNull();
    expect(
      vpnTunnelUpCaption({
        ip: null,
        timezone: null,
        source: 'detail',
        step: 'vpn_egress_bringing_up',
        vpn: true,
      }),
    ).toBe('Starting the VPN tunnel…');
    expect(
      vpnTunnelUpCaption({
        ip: null,
        timezone: null,
        source: 'detail',
        step: 'egress_geo_resolving',
        vpn: true,
      }),
    ).toBe('Resolving the exit location…');
    expect(
      vpnTunnelUpCaption({
        ip: null,
        timezone: null,
        source: 'detail',
        step: 'browser_spawning',
        vpn: true,
      }),
    ).toBe('VPN tunnel connected — starting the browser…');
    expect(
      vpnTunnelUpCaption({
        ip: null,
        timezone: null,
        source: 'detail',
        step: 'vpn_egress_active',
        vpn: true,
      }),
    ).toBe('VPN tunnel connected — the browser step isn’t available for VPN sessions yet');
    expect(
      vpnTunnelUpCaption({
        ip: '203.0.113.7',
        timezone: 'Europe/Amsterdam',
        source: 'detail',
        step: 'browser_spawning',
        vpn: true,
      }),
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
      vpnTunnelUpCaption({
        ip: '203.0.113.7',
        timezone: 'Europe/Amsterdam',
        source: 'report',
        vpn: true,
      }),
    ).toBe(TUNNEL_UP_SENTENCE);
    expect(
      vpnTunnelUpCaption({ ip: '203.0.113.7', timezone: null, source: 'report', vpn: true }),
    ).toBe('VPN tunnel is up (exit 203.0.113.7) — the browser has not attached yet');
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

// (h) VPN surfaces audit — findings 3, 7, 8, 14, 18, 29.
const STEP = (step: string, extra: Partial<AgentSessionCapabilityReport> = {}): ControlState => ({
  mode: 'manual',
  pairKind: null,
  terminal: false,
  status: 'active',
  closedReason: null,
  provisioningDetail: step,
  capabilityReport: { manual_input_available: true, proxy_kind: 'openvpn', ...extra },
});
const detail = (
  step:
    | 'vpn_egress_bringing_up'
    | 'vpn_egress_active'
    | 'egress_geo_resolving'
    | 'browser_spawning',
  ip: string | null = null,
) => ({ ip, timezone: null, source: 'detail' as const, step, vpn: true });
const q = (container: HTMLElement, sel: string): Element | null => container.querySelector(sel);
const addressText = (container: HTMLElement): string =>
  q(container, '[data-component="simulator-address"]')?.textContent ?? '';

describe('(h) the pure step helpers — "tunnel up" is never said while the tunnel is coming up', () => {
  it('⛔ REGRESSION PIN — the shared step tokens are emitted for SOCKS5 sessions too: on a SOCKS5 report, or before any report, they never claim a VPN tunnel', () => {
    const quiet = { streamLive: false, everLive: false, ended: false };
    const socks = report({ proxy_kind: 'socks5', exit_ip: '203.0.113.7' });
    const vpnRep = report({ proxy_kind: 'wireguard', exit_ip: '203.0.113.7' });
    const geoOnSocks = vpnTunnelUpNotice(socks, {
      ...quiet,
      provisioningDetail: 'egress_geo_resolving',
    });
    expect(geoOnSocks?.vpn).toBe(false);
    expect(vpnTunnelIsUp(geoOnSocks!)).toBe(false);
    expect(vpnTunnelUpCaption(geoOnSocks!)).toMatch(/^Resolving the exit location/);
    expect(vpnTunnelUpCaption(geoOnSocks!)).not.toMatch(/VPN|tunnel/);
    expect(vpnTunnelChipText(geoOnSocks!)).toBe('Resolving the exit…');
    expect(vpnAddressPlaceholder(geoOnSocks!)).not.toMatch(/VPN|tunnel/);
    const geoNoReport = vpnTunnelUpNotice(null, {
      ...quiet,
      provisioningDetail: 'egress_geo_resolving',
    });
    expect(geoNoReport?.vpn).toBe(false);
    expect(vpnTunnelChipText(geoNoReport!)).not.toMatch(/VPN|tunnel/);
    const spawnOnSocks = vpnTunnelUpNotice(socks, {
      ...quiet,
      provisioningDetail: 'browser_spawning',
    });
    expect(spawnOnSocks?.vpn).toBe(false);
    expect(vpnTunnelUpCaption(spawnOnSocks!)).toBe('Starting the browser…');
    // A vpn_ token is proof by itself (only the VPN tail emits it), and a VPN report
    // kind makes the shared tokens VPN steps.
    expect(
      vpnTunnelUpNotice(null, { ...quiet, provisioningDetail: 'vpn_egress_active' })?.vpn,
    ).toBe(true);
    expect(
      vpnTunnelUpNotice(socks, { ...quiet, provisioningDetail: 'vpn_egress_active' })?.vpn,
    ).toBe(true);
    const geoOnVpn = vpnTunnelUpNotice(vpnRep, {
      ...quiet,
      provisioningDetail: 'egress_geo_resolving',
    });
    expect(geoOnVpn?.vpn).toBe(true);
    expect(vpnTunnelIsUp(geoOnVpn!)).toBe(true);
    // The terminal VPN caption predicts nothing (a state, not a forecast).
    expect(
      vpnTunnelUpCaption({
        ip: null,
        timezone: null,
        source: 'detail',
        step: 'vpn_egress_active',
        vpn: true,
      }),
    ).not.toMatch(/time out|timeout/);
  });

  it('vpnTunnelIsUp is false ONLY for vpn_egress_bringing_up', () => {
    expect(vpnTunnelIsUp(detail('vpn_egress_bringing_up'))).toBe(false);
    expect(vpnTunnelIsUp(detail('vpn_egress_bringing_up', '203.0.113.7'))).toBe(false);
    for (const step of ['vpn_egress_active', 'egress_geo_resolving', 'browser_spawning'] as const)
      expect(vpnTunnelIsUp(detail(step)), step).toBe(true);
    expect(vpnTunnelIsUp({ ip: '203.0.113.7', timezone: null, source: 'report', vpn: true })).toBe(
      true,
    );
  });

  it('the chip text follows the STEP, handles ip === null, and never dangles "· exit "', () => {
    expect(vpnTunnelChipText(detail('vpn_egress_bringing_up'))).toBe('Starting the VPN tunnel…');
    // Even with an exit already observed on the report, bringing-up is not up.
    expect(vpnTunnelChipText(detail('vpn_egress_bringing_up', '203.0.113.7'))).toBe(
      'Starting the VPN tunnel…',
    );
    expect(vpnTunnelChipText(detail('vpn_egress_active'))).toBe(
      'VPN tunnel up · browser attach isn’t available yet',
    );
    expect(vpnTunnelChipText(detail('vpn_egress_active', '203.0.113.7'))).toBe(
      'VPN tunnel up · exit 203.0.113.7',
    );
    expect(vpnTunnelChipText(detail('egress_geo_resolving'))).toBe(
      'VPN tunnel up · resolving the exit…',
    );
    expect(vpnTunnelChipText(detail('browser_spawning'))).toBe(
      'VPN tunnel up · starting the browser…',
    );
    expect(
      vpnTunnelChipText({ ip: '203.0.113.7', timezone: null, source: 'report', vpn: true }),
    ).toBe('VPN tunnel up · exit 203.0.113.7');
    for (const t of [
      detail('vpn_egress_bringing_up'),
      detail('vpn_egress_active'),
      detail('egress_geo_resolving'),
      detail('browser_spawning'),
    ])
      expect(vpnTunnelChipText(t)).not.toMatch(/exit\s*$/);
  });

  it('the placeholder promises only what the step can deliver', () => {
    expect(vpnAddressPlaceholder(detail('vpn_egress_bringing_up'))).toBe(
      'Starting the VPN tunnel… — the address bar unlocks once the device is live',
    );
    expect(vpnAddressPlaceholder(detail('vpn_egress_active'))).toBe(
      'VPN tunnel is up — browser attach isn’t available for VPN sessions yet',
    );
    expect(vpnAddressPlaceholder(detail('browser_spawning'))).toBe(
      'VPN tunnel is up — the address bar unlocks once the browser attaches',
    );
    expect(
      vpnAddressPlaceholder({ ip: '203.0.113.7', timezone: null, source: 'report', vpn: true }),
    ).toBe('VPN tunnel is up — the address bar unlocks once the browser attaches');
  });

  it('the vpn_egress_active caption states the limit as a state, not a prediction of a timeout the client cannot see', () => {
    expect(vpnTunnelUpCaption(detail('vpn_egress_active', '203.0.113.7'))).toBe(
      'VPN tunnel connected (exit 203.0.113.7) — the browser step isn’t available for VPN sessions yet',
    );
    expect(vpnTunnelUpCaption(detail('vpn_egress_active'))).not.toMatch(/will time out$/);
  });

  it('nextEverLiveLatch is per session: latches, holds, and resets on a swap', () => {
    const a0 = { sessionId: 'agt_a', everLive: false };
    const a1 = nextEverLiveLatch(a0, 'agt_a', true);
    expect(a1).toEqual({ sessionId: 'agt_a', everLive: true });
    // Holds after the stream drops (a drop is "reconnecting").
    expect(nextEverLiveLatch(a1, 'agt_a', false)).toBe(a1);
    // A new session starts un-latched — MUTATION: return `prev` regardless of
    // sessionId (the old `useRef(false)`) and this reds.
    expect(nextEverLiveLatch(a1, 'agt_b', false)).toEqual({ sessionId: 'agt_b', everLive: false });
    expect(nextEverLiveLatch(a1, 'agt_b', true)).toEqual({ sessionId: 'agt_b', everLive: true });
  });
});

describe('(h) SimulatorWindow — the address bars during bring-up and the browserless active state', () => {
  it('CRITICAL while the harness is bringing the tunnel up, nothing says "tunnel up": chip, placeholder and notice all say "Starting the VPN tunnel…"', () => {
    manualControlState = STEP('vpn_egress_bringing_up');
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    const chip = q(container, '[data-component="simulator-address-vpn-tunnel-up"]');
    expect(chip?.textContent).toContain('Starting the VPN tunnel…');
    expect(addressText(container)).not.toMatch(/tunnel up/i);
    expect(addressText(container)).not.toMatch(/tunnel is up/i);
    const input = q(container, '[aria-label="Address bar"]') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toMatch(/^Starting the VPN tunnel…/);
    const notice = q(container, '[data-component="simulator-vpn-tunnel-up-notice"]');
    expect(notice?.textContent).toBe('Starting the VPN tunnel…');
    expect(notice?.getAttribute('data-tone')).toBe('neutral');
  });

  it('the browser-mode bar during bring-up: no "tunnel up", no dangling "· exit "', () => {
    localStore.set('ds-sim-browser-mode', '1');
    manualControlState = STEP('vpn_egress_bringing_up');
    const { container } = renderSim();
    const cue = q(container, '[data-component="simulator-address-bar-vpn-tunnel-up"]');
    expect(cue?.textContent?.trim()).toBe('Starting the VPN tunnel…');
    expect(cue?.textContent).not.toMatch(/exit/);
  });

  it('CRITICAL at vpn_egress_active with no browser step, nothing promises the browser: chip and placeholder say attach isn’t available, the notice is not a green success box', () => {
    manualControlState = STEP('vpn_egress_active');
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    const chip = q(container, '[data-component="simulator-address-vpn-tunnel-up"]');
    expect(chip?.textContent).toContain('browser attach isn’t available yet');
    expect(addressText(container)).not.toMatch(/starting the browser/i);
    expect(addressText(container)).not.toMatch(/unlocks once the browser attaches/i);
    const input = q(container, '[aria-label="Address bar"]') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toBe(
      'VPN tunnel is up — browser attach isn’t available for VPN sessions yet',
    );
    const notice = q(container, '[data-component="simulator-vpn-tunnel-up-notice"]');
    expect(notice?.textContent).toBe(
      'VPN tunnel connected — the browser step isn’t available for VPN sessions yet',
    );
    expect(notice?.getAttribute('data-tone')).toBe('neutral');
  });

  it('CONTROL — browser_spawning keeps the green tone and the "starting the browser…" chip', () => {
    manualControlState = STEP('browser_spawning');
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(
      q(container, '[data-component="simulator-address-vpn-tunnel-up"]')?.textContent,
    ).toContain('starting the browser…');
    expect(
      q(container, '[data-component="simulator-vpn-tunnel-up-notice"]')?.getAttribute('data-tone'),
    ).toBe('ready');
  });
});

describe('(h) SimulatorWindow — the control poll’s transient errors keep the harness step', () => {
  // Finding 18: the error path nulled provisioningDetail on ANY error, so one
  // 5xx flipped the notice from "Starting the VPN tunnel…" to the generic
  // "connecting…" for a tick. MUTATION: put `provisioningDetail: null` back in
  // the transient patch → the CRITICAL arm reds; the auth CONTROL stays green.
  async function pollThenFail(err: Error): Promise<{ container: HTMLElement }> {
    let failing = false;
    getAgentSession.mockImplementation(() =>
      failing ? Promise.reject(err) : immediateControl(STEP('vpn_egress_bringing_up')),
    );
    const rendered = renderSim();
    fireEvent.click(q(rendered.container, '[data-component="sim-rail-controls"]') as Element);
    expect(
      q(rendered.container, '[data-component="simulator-vpn-tunnel-up-notice"]')?.textContent,
    ).toBe('Starting the VPN tunnel…');
    failing = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    return rendered;
  }

  it('CRITICAL a non-auth error (5xx / network) keeps the previous step caption', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = await pollThenFail(new Error('502 Bad Gateway'));
      expect(getAgentSession.mock.calls.length).toBeGreaterThan(1);
      expect(q(container, '[data-component="simulator-vpn-tunnel-up-notice"]')?.textContent).toBe(
        'Starting the VPN tunnel…',
      );
      expect(q(container, '[data-component="simulator-address-connecting"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CONTROL — an auth failure (401) blanks it: the generic "connecting…" returns', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The mocked class takes only a message; the predicate reads `.status`.
      const err = new (AgentSessionControlError as unknown as new (m: string) => Error)(
        'expired',
      ) as Error & { status?: number };
      err.status = 401;
      const { container } = await pollThenFail(err);
      expect(q(container, '[data-component="simulator-vpn-tunnel-up-notice"]')).toBeNull();
      expect(q(container, '[data-component="simulator-address-connecting"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('(h) SimulatorWindow — Tauri-only: the in-place session swap and the Dock flag', () => {
  beforeEach(() => {
    // The real `@tauri-apps/api/core` reaches `window.__TAURI_INTERNALS__.invoke`;
    // the same spy sits behind both the module mock and the internals, so every
    // Dock-tile call is seen whichever path the dynamic import resolves to.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
    };
    tauriListeners.clear();
    invoke.mockClear();
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  // Finding 3: everLiveRef was never reset on a ds-session relaunch, so after any
  // session that once streamed, the relaunched VPN session never showed its
  // tunnel-up captions. MUTATION: replace nextEverLiveLatch with the old
  // `if (streamLiveNow) ref.current = true` → the notice stays null after the
  // swap → red.
  it('CRITICAL after a session that streamed, a relaunched VPN session in the same window shows its tunnel-up notice again', async () => {
    manualControlState = STEP('vpn_egress_active', { exit_ip: '203.0.113.7' });
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(q(container, '[data-component="simulator-vpn-tunnel-up-notice"]')).not.toBeNull();
    goLive();
    expect(q(container, '[data-component="simulator-vpn-tunnel-up-notice"]')).toBeNull();
    // The stream drops: with the latch held this is "reconnecting", no notice.
    act(() => {
      panelCbs.onStateChange?.({ kind: 'reconnecting' }, fakeRoom);
    });
    expect(q(container, '[data-component="simulator-vpn-tunnel-up-notice"]')).toBeNull();
    // In-place relaunch to another session (the Rust side emits ds-session).
    const onSession = await vi.waitFor(() => {
      const cb = tauriListeners.get('ds-session');
      expect(cb).toBeDefined();
      return cb as (event: { payload: string }) => void;
    });
    await act(async () => {
      onSession({ payload: btoa('?window=simulator&ws=wss://lk&token=tok2&session=agt_y') });
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        q(container, '[data-component="simulator-vpn-tunnel-up-notice"]')?.textContent,
      ).toContain('VPN tunnel connected'),
    );
  });

  // Finding 16 (Dock half): the flag keyed only on the launch's cached `cc`.
  // The mount resets the control state after the first poll applied it, so the
  // report is re-read by the next 5s tick — advance past it before reading.
  async function renderWithCcAndPoll(): Promise<Array<{ countryCode: string }>> {
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=tok&session=agt_x&cc=US',
    );
    render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    return invoke.mock.calls
      .filter((c) => c[0] === 'set_dock_tile')
      .map((c) => c[1] as { countryCode: string });
  }

  it('CRITICAL the Dock flag follows the capability report’s exit_country when it arrives; the launch cc is only the fallback', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      manualControlState = STEP('vpn_egress_active', {
        exit_ip: '203.0.113.7',
        exit_country: 'NL',
      });
      const tiles = await renderWithCcAndPoll();
      expect(tiles.length).toBeGreaterThan(0);
      expect(tiles[tiles.length - 1]).toMatchObject({ countryCode: 'NL' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('CONTROL — without exit_country on the report the launch cc drives the flag', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      manualControlState = STEP('vpn_egress_active', { exit_ip: '203.0.113.7' });
      const tiles = await renderWithCcAndPoll();
      expect(tiles.length).toBeGreaterThan(0);
      expect(tiles[tiles.length - 1]).toMatchObject({ countryCode: 'US' });
    } finally {
      vi.useRealTimers();
    }
  });
});
