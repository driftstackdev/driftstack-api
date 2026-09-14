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
//   • (W1, contract 2026-09-14) A3's seven BARE bring-up phases are accepted
//     exactly as spelled — whole-string, no prefix matching — each with its own
//     caption; a token outside the set stays the generic caption. `up` is
//     CONCEPTUAL (settled with A3 later that day), never emitted:
//     `vpn_egress_active` stays the tunnel-up token and a bare `up` is unknown.
//   • (W2) the two terminal reads hand the panel {reason, summary, lastPhase}:
//     A3's host-free summary verbatim, and a DERIVED last phase (the last
//     provisioning_detail this window observed before the terminal frame), kept
//     in a PER-SESSION record that only a non-empty detail can write — so no
//     relay-cleared terminal read, terminal mutation body, or failed read blanks
//     it between the observation and the derivation.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';
import type { VpnProvisioningStep } from '../../src/views/SimulatorWindow';
import type * as ControlModule from '../../src/lib/agent-session-control';
import type * as SettingsModule from '../../src/lib/settings';

const sendNavigate = vi.fn(() => Promise.resolve());
const getAgentSession = vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {}));
type ControlState = {
  mode: 'manual';
  pairKind: null;
  terminal: boolean;
  status: string;
  closedReason: string | null;
  provisioningDetail?: string | null;
  capabilityReport: Partial<AgentSessionCapabilityReport>;
  errorEvent?: {
    code: string;
    severity: 'error';
    summary: string;
    customer_actionable: boolean;
    retryable: boolean;
  };
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
  panelCbs.sessionEnded = undefined;
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
  /** (W2) the last `sessionEnded` prop the window handed the panel. */
  sessionEnded?: unknown;
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
    sessionEnded?: unknown;
  }) => {
    panelCbs.onRoom = props.onRoom;
    panelCbs.onStateChange = props.onStateChange;
    panelCbs.onPublisher = props.onPublisher;
    panelCbs.sessionEnded = props.sessionEnded;
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
  derivedLastPhase,
  nextObservedPhase,
} = await import('../../src/views/SimulatorWindow');
const { AgentSessionControlError, setSessionMode } =
  await import('../../src/lib/agent-session-control');
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
    ).toBe('VPN tunnel connected — browser not attached');
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
const detail = (step: VpnProvisioningStep, ip: string | null = null) => ({
  ip,
  timezone: null,
  source: 'detail' as const,
  step,
  vpn: true,
});
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

  it('vpnTunnelIsUp is false ONLY for vpn_egress_bringing_up and (W1) A3’s seven pre-up phases', () => {
    expect(vpnTunnelIsUp(detail('vpn_egress_bringing_up'))).toBe(false);
    expect(vpnTunnelIsUp(detail('vpn_egress_bringing_up', '203.0.113.7'))).toBe(false);
    for (const phase of BRINGUP_PHASES) {
      expect(vpnTunnelIsUp(detail(phase)), phase).toBe(false);
      expect(vpnTunnelIsUp(detail(phase, '203.0.113.7')), phase).toBe(false);
    }
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
      'VPN tunnel up · browser not attached',
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
    // (m) M6 — the same line as every other tunnel-up step: a condition, not
    // an availability claim (the old branch said attach "isn’t available for
    // VPN sessions yet", which the client cannot know).
    expect(vpnAddressPlaceholder(detail('vpn_egress_active'))).toBe(
      'VPN tunnel is up — the address bar unlocks once the browser attaches',
    );
    expect(vpnAddressPlaceholder(detail('browser_spawning'))).toBe(
      'VPN tunnel is up — the address bar unlocks once the browser attaches',
    );
    expect(
      vpnAddressPlaceholder({ ip: '203.0.113.7', timezone: null, source: 'report', vpn: true }),
    ).toBe('VPN tunnel is up — the address bar unlocks once the browser attaches');
  });

  it('the vpn_egress_active caption is a state — tunnel up, browser not attached — with no prediction of a timeout and no claim about availability, neither of which the client can see', () => {
    expect(vpnTunnelUpCaption(detail('vpn_egress_active', '203.0.113.7'))).toBe(
      'VPN tunnel connected (exit 203.0.113.7) — browser not attached',
    );
    expect(vpnTunnelUpCaption(detail('vpn_egress_active'))).not.toMatch(/will time out$/);
    // (m) M6 — "isn’t available for VPN sessions yet" was an availability claim
    // the client cannot make; none of the three surfaces may make one now.
    for (const s of [
      vpnTunnelUpCaption(detail('vpn_egress_active')),
      vpnTunnelUpCaption(detail('vpn_egress_active', '203.0.113.7')),
      vpnTunnelChipText(detail('vpn_egress_active')),
      vpnAddressPlaceholder(detail('vpn_egress_active')),
    ])
      expect(s).not.toMatch(/available|not yet|isn’t|isn't/i);
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

  it('CRITICAL at vpn_egress_active with no browser step, nothing promises the browser and nothing claims it is unavailable: chip, placeholder and notice say the tunnel is up and the browser is not attached; the notice is not a green success box', () => {
    manualControlState = STEP('vpn_egress_active');
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    const chip = q(container, '[data-component="simulator-address-vpn-tunnel-up"]');
    expect(chip?.textContent).toContain('browser not attached');
    expect(addressText(container)).not.toMatch(/starting the browser/i);
    // (m) M6 — no availability claim either way, on any of the three surfaces.
    expect(addressText(container)).not.toMatch(/available/i);
    const input = q(container, '[aria-label="Address bar"]') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toBe(
      'VPN tunnel is up — the address bar unlocks once the browser attaches',
    );
    expect(input.getAttribute('placeholder')).not.toMatch(/available/i);
    const notice = q(container, '[data-component="simulator-vpn-tunnel-up-notice"]');
    expect(notice?.textContent).toBe('VPN tunnel connected — browser not attached');
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

// W1 — A3's bare bring-up phases (contract 2026-09-14), exactly as given: the
// seven phases are a tunnel that is NOT up. `up` is CONCEPTUAL (settled with A3
// later the same day) — never an emitted token; `vpn_egress_active` remains the
// tunnel-up signal, and a bare `up` is OUTSIDE the set. Accepted whole-string
// only, no prefix matching.
const BRINGUP_PHASES = [
  'resolving',
  'connecting',
  'handshaking',
  'assigning_address',
  'configuring_routes',
  'starting_proxy',
  'verifying',
] as const;
const NOTICE = '[data-component="simulator-vpn-tunnel-up-notice"]';
const CHIP = '[data-component="simulator-address-vpn-tunnel-up"]';
const CONNECTING = '[data-component="simulator-address-connecting"]';

describe('(W1) the pure helpers — A3’s bare phases, accepted exactly as spelled, each with its own caption', () => {
  const quiet = { streamLive: false, everLive: false, ended: false };
  const vpnRep = report({ proxy_kind: 'openvpn' });

  it('CRITICAL every phase is a known step on a VPN report and every one is "not up"; a bare `up` is NOT a step — conceptual, never emitted — so it claims no tunnel on any surface (MUTATION: put `up` back into VPN_STEPS → red)', () => {
    for (const phase of BRINGUP_PHASES) {
      const t = vpnTunnelUpNotice(vpnRep, { ...quiet, provisioningDetail: phase });
      expect(t?.step, phase).toBe(phase);
      expect(t?.vpn, phase).toBe(true);
      expect(t?.source, phase).toBe('detail');
      expect(vpnTunnelIsUp(t!), phase).toBe(false);
    }
    // `up` is outside the set: unknown → null → the generic caption, on a VPN
    // report and before any report alike. The tunnel-up token is, and stays,
    // vpn_egress_active — the POSITIVE CONTROL in the same breath.
    expect(vpnTunnelUpNotice(vpnRep, { ...quiet, provisioningDetail: 'up' })).toBeNull();
    expect(vpnTunnelUpNotice(null, { ...quiet, provisioningDetail: 'up' })).toBeNull();
    const active = vpnTunnelUpNotice(vpnRep, { ...quiet, provisioningDetail: 'vpn_egress_active' });
    expect(active?.step).toBe('vpn_egress_active');
    expect(vpnTunnelIsUp(active!)).toBe(true);
    expect(vpnTunnelUpCaption(active!)).toBe('VPN tunnel connected — browser not attached');
  });

  it('CRITICAL each of the seven phases renders its own caption and no two share one, and none of them claims the tunnel is up', () => {
    const captions = BRINGUP_PHASES.map((p) => vpnTunnelUpCaption(detail(p)));
    expect(new Set(captions).size).toBe(BRINGUP_PHASES.length);
    const existing = (
      ['vpn_egress_bringing_up', 'egress_geo_resolving', 'browser_spawning'] as const
    ).map((s) => vpnTunnelUpCaption(detail(s)));
    for (const phase of BRINGUP_PHASES) {
      const caption = vpnTunnelUpCaption(detail(phase));
      expect(caption, phase).not.toBe('connecting…');
      expect(caption, phase).toMatch(/…$/);
      expect(caption, phase).not.toMatch(/tunnel (is )?up|connected|not attached/i);
      expect(existing, phase).not.toContain(caption);
      // An exit is never named before `up`: none is observed yet.
      expect(vpnTunnelUpCaption(detail(phase, '203.0.113.7')), phase).toBe(caption);
      // The chip names the phase under the bring-up prefix and never dangles.
      const chip = vpnTunnelChipText(detail(phase));
      expect(chip, phase).toMatch(/^Starting the VPN tunnel · .+…$/);
      expect(chip, phase).not.toMatch(/tunnel up|exit\s*$/i);
      expect(vpnAddressPlaceholder(detail(phase)), phase).toBe(
        'Starting the VPN tunnel… — the address bar unlocks once the device is live',
      );
    }
    expect(new Set(BRINGUP_PHASES.map((p) => vpnTunnelChipText(detail(p)))).size).toBe(
      BRINGUP_PHASES.length,
    );
    // The words, pinned: the provider phases say what the far end is doing, the
    // config phase names the handshake, the four "ours" phases say what we set up.
    expect(vpnTunnelUpCaption(detail('resolving'))).toBe('Finding the proxy endpoint…');
    expect(vpnTunnelUpCaption(detail('connecting'))).toBe('Connecting to the proxy endpoint…');
    expect(vpnTunnelUpCaption(detail('handshaking'))).toBe('Completing the VPN handshake…');
    expect(vpnTunnelUpCaption(detail('assigning_address'))).toBe('Assigning the tunnel address…');
    expect(vpnTunnelUpCaption(detail('configuring_routes'))).toBe('Setting up the tunnel routes…');
    expect(vpnTunnelUpCaption(detail('starting_proxy'))).toBe('Starting the tunnel proxy…');
    expect(vpnTunnelUpCaption(detail('verifying'))).toBe('Verifying the tunnel…');
  });

  it('CRITICAL a bare token NOT in the set is unknown — null, hence the generic caption — even when it starts with, ends with, contains, or re-cases a phase, and `up` itself (conceptual, never emitted) is outside the set (MUTATION: `startsWith` / `includes` / lowercasing in vpnStepOf → red)', () => {
    for (const tok of [
      'up',
      'upstream',
      'up_',
      'vpn_up',
      'xupx',
      'connecting_x',
      'resolvingx',
      'handshake',
      'verify',
      'assigning_address_v2',
      'UP',
      'Resolving',
      ' up',
      'up ',
    ]) {
      expect(vpnTunnelUpNotice(vpnRep, { ...quiet, provisioningDetail: tok }), tok).toBeNull();
      expect(vpnTunnelUpNotice(null, { ...quiet, provisioningDetail: tok }), tok).toBeNull();
    }
    // POSITIVE CONTROL in the same breath: the exact spellings ARE known.
    expect(vpnTunnelUpNotice(vpnRep, { ...quiet, provisioningDetail: 'verifying' })?.step).toBe(
      'verifying',
    );
    expect(vpnTunnelUpNotice(vpnRep, { ...quiet, provisioningDetail: 'connecting' })?.step).toBe(
      'connecting',
    );
  });

  it('⛔ REGRESSION PIN — a bare phase is not proof of a VPN session: on a SOCKS5 report, or before any report, it claims no tunnel on any surface', () => {
    const socks = report({ proxy_kind: 'socks5', exit_ip: '203.0.113.7' });
    for (const phase of BRINGUP_PHASES) {
      for (const rep of [socks, null]) {
        const t = vpnTunnelUpNotice(rep, { ...quiet, provisioningDetail: phase });
        expect(t?.step, phase).toBe(phase);
        expect(t?.vpn, phase).toBe(false);
        expect(vpnTunnelIsUp(t!), phase).toBe(false);
        for (const s of [vpnTunnelUpCaption(t!), vpnTunnelChipText(t!), vpnAddressPlaceholder(t!)])
          expect(s, phase).not.toMatch(/VPN|tunnel/);
      }
    }
  });
});

describe('(W1) SimulatorWindow — the address bars during A3’s bring-up phases', () => {
  it('CRITICAL at `handshaking` the chip, placeholder and notice say the tunnel is coming up and name the phase; nothing says "tunnel up"', () => {
    manualControlState = STEP('handshaking');
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    const chip = q(container, CHIP);
    expect(chip?.textContent).toContain('Starting the VPN tunnel · handshaking…');
    expect(chip?.getAttribute('title')).toBe('Completing the VPN handshake…');
    expect(addressText(container)).not.toMatch(/tunnel up|tunnel is up/i);
    const input = q(container, '[aria-label="Address bar"]') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toMatch(/^Starting the VPN tunnel…/);
    const notice = q(container, NOTICE);
    expect(notice?.textContent).toBe('Completing the VPN handshake…');
    expect(notice?.getAttribute('data-tone')).toBe('neutral');
    expect(q(container, CONNECTING)).toBeNull();
  });

  it('every pre-up phase renders its own notice text in the window, none of them shared', () => {
    const seen = new Set<string>();
    for (const phase of BRINGUP_PHASES) {
      manualControlState = STEP(phase);
      const { container, unmount } = renderSim();
      fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
      const text = q(container, NOTICE)?.textContent ?? '';
      expect(text, phase).toBe(vpnTunnelUpCaption(detail(phase)));
      expect(q(container, NOTICE)?.getAttribute('data-tone'), phase).toBe('neutral');
      seen.add(text);
      unmount();
    }
    expect(seen.size).toBe(BRINGUP_PHASES.length);
  });

  it('CONTROL — a bare `up` (conceptual, never emitted) renders the generic "connecting…" in the window and claims no tunnel; the tunnel-up state is still vpn_egress_active’s (MUTATION: accept `up` as a step → red)', () => {
    manualControlState = STEP('up');
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(q(container, CONNECTING)).not.toBeNull();
    expect(q(container, NOTICE)).toBeNull();
    expect(q(container, CHIP)).toBeNull();
    expect(addressText(container)).not.toMatch(/tunnel/i);
    expect(q(container, '[aria-label="Address bar"]')?.getAttribute('placeholder')).not.toMatch(
      /tunnel/i,
    );
  });

  it('CONTROL — an unknown bare token that merely starts with a phase renders the generic "connecting…" in the window (MUTATION: startsWith matching → red)', () => {
    manualControlState = STEP('upstream');
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(q(container, CONNECTING)).not.toBeNull();
    expect(q(container, NOTICE)).toBeNull();
    expect(q(container, CHIP)).toBeNull();
  });
});

// W2 — the two terminal reads. The 5s poll passes `{ heartbeatClientId }` as its
// third argument; refreshControl (the mount / pane-open read) passes none — the
// one thing that tells the two call sites apart from inside the mock.
const SUMMARY = 'The tunnel never finished coming up within 60s.';
const ENDED = (summary: string | null, over: Partial<ControlState> = {}): ControlState => ({
  mode: 'manual',
  pairKind: null,
  terminal: true,
  status: 'closed',
  closedReason: 'tunnel_setup_timeout',
  // The server's relay clears provisioning_detail on a terminal frame.
  provisioningDetail: null,
  // An observed EXIT on the report is a different address from the endpoint and
  // must never be spliced into the summary as if it were the host.
  capabilityReport: { manual_input_available: true, proxy_kind: 'openvpn', exit_ip: '203.0.113.7' },
  ...(summary === null
    ? {}
    : {
        errorEvent: {
          code: 'proxy_connection_failed',
          severity: 'error' as const,
          summary,
          customer_actionable: true,
          retryable: true,
        },
      }),
  ...over,
});
const isPollRead = (args: unknown[]): boolean => {
  const opts = args[2];
  return typeof opts === 'object' && opts !== null && 'heartbeatClientId' in opts;
};

describe('(W2) SimulatorWindow — both terminal reads hand the panel {reason, summary, lastPhase}', () => {
  it('derivedLastPhase — the terminal read’s own detail wins, else the last observed one, else null (never a guess)', () => {
    expect(derivedLastPhase(null, 'handshaking')).toBe('handshaking');
    expect(derivedLastPhase(undefined, 'handshaking')).toBe('handshaking');
    expect(derivedLastPhase('verifying', 'handshaking')).toBe('verifying');
    expect(derivedLastPhase('verifying', null)).toBe('verifying');
    expect(derivedLastPhase(null, null)).toBeNull();
    expect(derivedLastPhase(undefined, undefined)).toBeNull();
    expect(derivedLastPhase('', '')).toBeNull();
    // The settled NEW ROUTING CASE token (tunnel up, browser never came) is
    // handed through unfiltered — the panel routes it, this window never drops it.
    expect(derivedLastPhase(null, 'vpn_egress_active')).toBe('vpn_egress_active');
  });

  it('nextObservedPhase — per session: a non-empty detail writes the record, a blank never erases it, another session starts fresh', () => {
    const a0 = { sessionId: 'agt_a', detail: null };
    const a1 = nextObservedPhase(a0, 'agt_a', 'handshaking');
    expect(a1).toEqual({ sessionId: 'agt_a', detail: 'handshaking' });
    // A relay-cleared terminal read, a terminal mutation body, a failed read,
    // the swap reset's clean slate: all null — none may blank the observation.
    expect(nextObservedPhase(a1, 'agt_a', null)).toBe(a1);
    expect(nextObservedPhase(a1, 'agt_a', '')).toBe(a1);
    // A later phase replaces it (phases only advance).
    expect(nextObservedPhase(a1, 'agt_a', 'verifying')).toEqual({
      sessionId: 'agt_a',
      detail: 'verifying',
    });
    // A different session never inherits it — MUTATION: return `prev` regardless
    // of sessionId → the swap arm below reds.
    expect(nextObservedPhase(a1, 'agt_b', null)).toEqual({ sessionId: 'agt_b', detail: null });
    expect(nextObservedPhase(a1, 'agt_b', 'resolving')).toEqual({
      sessionId: 'agt_b',
      detail: 'resolving',
    });
  });

  it('CRITICAL site 1 — the 5s terminal poll: after observing `verifying`, a server-cleared terminal read hands the panel the summary verbatim and lastPhase "verifying" (MUTATION: drop `summary:` or `lastPhase:` at the poll site → red)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let ended = false;
      getAgentSession.mockImplementation((...args: unknown[]) =>
        immediateControl(ended && isPollRead(args) ? ENDED(SUMMARY) : STEP('verifying')),
      );
      const { container } = renderSim();
      fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
      expect(q(container, NOTICE)?.textContent).toBe('Verifying the tunnel…');
      expect(panelCbs.sessionEnded).toBeNull();
      ended = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(panelCbs.sessionEnded).toStrictEqual({
        reason: 'tunnel_setup_timeout',
        summary: SUMMARY,
        lastPhase: 'verifying',
      });
      // It was the poll that ended it: only a heartbeat read returned terminal.
      expect(getAgentSession.mock.calls.filter(isPollRead).length).toBeGreaterThan(1);
      // Ended: the bring-up notice is gone (nothing is attaching any more).
      expect(q(container, NOTICE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The mount runs the poll, then the session-switch reset, then refreshControl.
  // The observed-phase record is PER SESSION (nextObservedPhase): the reset's
  // clean slate starts a fresh record only for a DIFFERENT session, so this
  // session's first-poll observation survives it (the mount-order arm below); a
  // window whose every read is terminal observed nothing (the CONTROL below).
  // This arm drives refreshControl's pane-open re-read.
  it('CRITICAL site 2 — refreshControl (the pane-open read, no heartbeat option): a terminal read after the poll observed `connecting` hands the panel the summary and lastPhase "connecting" (MUTATION: drop `summary:` at the refreshControl site → red)', () => {
    let ended = false;
    getAgentSession.mockImplementation((...args: unknown[]) =>
      immediateControl(ended && !isPollRead(args) ? ENDED(SUMMARY) : STEP('connecting')),
    );
    const { container } = renderSim();
    expect(panelCbs.sessionEnded).toBeNull();
    const before = getAgentSession.mock.calls.length;
    ended = true;
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(panelCbs.sessionEnded).toStrictEqual({
      reason: 'tunnel_setup_timeout',
      summary: SUMMARY,
      lastPhase: 'connecting',
    });
    // It was refreshControl: the pane open issued a non-poll read, and no poll
    // read ever answered terminal.
    const after = getAgentSession.mock.calls.slice(before);
    expect(after.some((c) => !isPollRead(c))).toBe(true);
    expect(after.some(isPollRead)).toBe(false);
  });

  it('CONTROL — when the terminal read still carries a detail, that later observation wins over the phase the poll observed (MUTATION: prefer the observed one → red)', () => {
    let ended = false;
    getAgentSession.mockImplementation((...args: unknown[]) =>
      immediateControl(
        ended && !isPollRead(args)
          ? ENDED(SUMMARY, { provisioningDetail: 'starting_proxy' })
          : STEP('connecting'),
      ),
    );
    const { container } = renderSim();
    expect(panelCbs.sessionEnded).toBeNull();
    ended = true;
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(panelCbs.sessionEnded).toStrictEqual({
      reason: 'tunnel_setup_timeout',
      summary: SUMMARY,
      lastPhase: 'starting_proxy',
    });
  });

  it('CRITICAL the settled NEW ROUTING CASE token is handed through: after the poll observed `vpn_egress_active` (tunnel up, browser never came), the pane-open terminal read hands lastPhase "vpn_egress_active" unfiltered, for the panel to route → ours (MUTATION: filter to bare phases → red)', () => {
    let ended = false;
    getAgentSession.mockImplementation((...args: unknown[]) =>
      immediateControl(ended && !isPollRead(args) ? ENDED(SUMMARY) : STEP('vpn_egress_active')),
    );
    const { container } = renderSim();
    expect(panelCbs.sessionEnded).toBeNull();
    ended = true;
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(panelCbs.sessionEnded).toStrictEqual({
      reason: 'tunnel_setup_timeout',
      summary: SUMMARY,
      lastPhase: 'vpn_egress_active',
    });
  });

  // GATES finding 1 (2026-09-14), proven by execution before the fix: a mode
  // mutation whose response body is already terminal carries the relay-cleared
  // `provisioningDetail: null`; that write blanked the snapshot's detail BEFORE
  // the `.finally` refreshControl derived lastPhase, so the panel got null for a
  // phase this window had observed. The phase now lives in a per-session record
  // only a non-empty detail can write (MUTATION: derive from
  // manualInputControlRef.current.provisioningDetail again → red).
  async function observeThenMutate(mutationBody: ControlState): Promise<void> {
    let ended = false;
    getAgentSession.mockImplementation((...args: unknown[]) =>
      immediateControl(ended && !isPollRead(args) ? ENDED(SUMMARY) : STEP('handshaking')),
    );
    vi.mocked(setSessionMode).mockImplementation(
      () => immediateControl(mutationBody) as unknown as ReturnType<typeof setSessionMode>,
    );
    const { container } = renderSim();
    // ⛔ The mode radios live in the SESSION pane (`activePane === 'session'`),
    // not the Controls pane. The first draft clicked the Controls rail entry and
    // then asserted a radio that was never rendered — both arms failed on
    // `expect(other).not.toBeNull()` before any mutation happened, and the
    // failure read as a latch bug. It was the wrong rail button. (The rail's
    // data-component is templated, `sim-rail-${pane}`: the runtime attribute is
    // what matters, not a literal a source grep would find.)
    // The step notice is asserted with the Controls pane open, exactly as the
    // first draft did (it is not rendered under the Session pane); the Session
    // pane is then opened for the mode radios the mutation needs.
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(q(container, NOTICE)?.textContent).toBe('Completing the VPN handshake…');
    expect(panelCbs.sessionEnded).toBeNull();
    fireEvent.click(q(container, '[data-component="sim-rail-session"]') as Element);
    ended = true;
    const other = q(container, '[role="radio"][aria-label$=" mode"]:not([aria-checked="true"])');
    expect(other).not.toBeNull();
    expect((other as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(other as Element);
      await Promise.resolve();
    });
    expect(vi.mocked(setSessionMode)).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(panelCbs.sessionEnded).not.toBeNull());
  }

  it('CRITICAL a mode mutation whose body is already terminal (detail null) does not erase the phase the poll observed: the .finally refreshControl still hands the panel lastPhase "handshaking"', async () => {
    try {
      await observeThenMutate(ENDED(SUMMARY));
      expect(panelCbs.sessionEnded).toStrictEqual({
        reason: 'tunnel_setup_timeout',
        summary: SUMMARY,
        lastPhase: 'handshaking',
      });
    } finally {
      vi.mocked(setSessionMode).mockReset();
    }
  });

  it('CONTROL — the same click with a NON-terminal mutation body also hands lastPhase "handshaking": the mechanism was the terminal body’s null write, not the click', async () => {
    try {
      await observeThenMutate(STEP('handshaking'));
      expect(panelCbs.sessionEnded).toStrictEqual({
        reason: 'tunnel_setup_timeout',
        summary: SUMMARY,
        lastPhase: 'handshaking',
      });
    } finally {
      vi.mocked(setSessionMode).mockReset();
    }
  });

  it('CRITICAL a SECOND terminal read (the pane toggle’s refreshControl, after the poll already latched) keeps lastPhase "handshaking" — the latch is never overwritten with null', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let ended = false;
      getAgentSession.mockImplementation(() =>
        immediateControl(ended ? ENDED(SUMMARY) : STEP('handshaking')),
      );
      const { container } = renderSim();
      fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
      expect(q(container, NOTICE)?.textContent).toBe('Completing the VPN handshake…');
      ended = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      const latched = {
        reason: 'tunnel_setup_timeout',
        summary: SUMMARY,
        lastPhase: 'handshaking',
      };
      expect(panelCbs.sessionEnded).toStrictEqual(latched);
      const before = getAgentSession.mock.calls.length;
      // Toggle the pane: a fresh non-poll read answers terminal a second time.
      fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
      const after = getAgentSession.mock.calls.slice(before);
      expect(after.some((c) => !isPollRead(c))).toBe(true);
      expect(panelCbs.sessionEnded).toStrictEqual(latched);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL mount order — the first poll observes `handshaking` and the seed refreshControl read is terminal: the same session’s observation survives the mount reset → lastPhase "handshaking"', () => {
    getAgentSession.mockImplementation((...args: unknown[]) =>
      immediateControl(isPollRead(args) ? STEP('handshaking') : ENDED(SUMMARY)),
    );
    renderSim();
    expect(panelCbs.sessionEnded).toStrictEqual({
      reason: 'tunnel_setup_timeout',
      summary: SUMMARY,
      lastPhase: 'handshaking',
    });
  });

  it('CONTROL — a window whose FIRST read is already terminal observed no phase: lastPhase null (no guessed route); no error event → summary null', () => {
    getAgentSession.mockImplementation(() => immediateControl(ENDED(null)));
    renderSim();
    expect(panelCbs.sessionEnded).toStrictEqual({
      reason: 'tunnel_setup_timeout',
      summary: null,
      lastPhase: null,
    });
  });

  it('HONESTY — the summary reaches the panel byte-for-byte; the report’s exit IP is never spliced in as the endpoint', () => {
    const hostFree = 'Nothing answered at the proxy endpoint.';
    getAgentSession.mockImplementation(() =>
      immediateControl(ENDED(hostFree, { closedReason: 'remote_unreachable' })),
    );
    renderSim();
    const ended = panelCbs.sessionEnded as { reason: string; summary: string; lastPhase: null };
    expect(ended.summary).toBe(hostFree);
    expect(ended.summary).not.toContain('203.0.113.7');
    expect(ended.reason).toBe('remote_unreachable');
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

  it('CRITICAL (W2) the observed phase is PER SESSION: after an in-place relaunch, the new session’s terminal read hands lastPhase null — the old session’s `handshaking` never leaks (MUTATION: nextObservedPhase ignores the session id → red)', async () => {
    getAgentSession.mockImplementation((...args: unknown[]) =>
      immediateControl(args[0] === 'agt_y' ? ENDED(SUMMARY) : STEP('handshaking')),
    );
    const { container } = renderSim();
    fireEvent.click(q(container, '[data-component="sim-rail-controls"]') as Element);
    expect(q(container, NOTICE)?.textContent).toBe('Completing the VPN handshake…');
    expect(panelCbs.sessionEnded).toBeNull();
    const onSession = await vi.waitFor(() => {
      const cb = tauriListeners.get('ds-session');
      expect(cb).toBeDefined();
      return cb as (event: { payload: string }) => void;
    });
    await act(async () => {
      onSession({ payload: btoa('?window=simulator&ws=wss://lk&token=tok2&session=agt_y') });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(panelCbs.sessionEnded).not.toBeNull());
    expect(panelCbs.sessionEnded).toStrictEqual({
      reason: 'tunnel_setup_timeout',
      summary: SUMMARY,
      lastPhase: null,
    });
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
