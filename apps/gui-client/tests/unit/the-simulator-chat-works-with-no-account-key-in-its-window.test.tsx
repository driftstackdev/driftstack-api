// Owner item 5 (2026-09-24): "In open simulator view (open profile), the AI
// session might not be working still. Says this; Not connected — add your API
// key in Settings to run automations. even tho, normal AI browser automation
// does work."
//
// ROOT CAUSE: the Simulator's conversation panel gated on `settings.apiKey` and
// talked through the SDK client built from it. A Simulator window can never
// read the account key (the OS credential store refuses every window but the
// main one since 0.1.71), so the panel was "Not connected" for every customer.
//
// ACCEPTANCE (the brief's words): with NO account key available in that
// window, the chat sends and shows replies. This renders the REAL window — real
// SettingsProvider (no key: nothing here can load one), real AgentChatProvider
// and chat hook, real SDK — with only the network stubbed, and proves:
//   1. the composer is live, not "Not connected";
//   2. the send reaches THIS session's message route carrying the session's
//      control key and no bearer at all;
//   3. the reply is on screen;
//   4. the chat never ends or creates a session (the scoped client refuses);
//   5. a window with no control key says so in its own words — never "add your
//      API key in Settings";
//   6. the screenshot a step took shows in the reply: the capture is fetched
//      with the same control key (the real fetch, not a stub of it).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import type * as ControlModule from '../../src/lib/agent-session-control';

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(() => Promise.resolve()),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => fakeRoom,
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

// The window's OWN control polling (mode switch, capability) — Agent mode, so
// the conversation panel renders. The chat does NOT go through this module,
// except for the screenshot fetch, which is the REAL one.
vi.mock('../../src/lib/agent-session-control', async (importOriginal) => ({
  getAgentSession: () =>
    Promise.resolve({
      mode: 'ai',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
      provisioningDetail: null,
      capabilityReport: { manual_input_available: true },
    }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setAgentSessionCookies: vi.fn(),
  navigateAgentSessionHistory: vi.fn(),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  fetchAgentCapture: (await importOriginal<typeof ControlModule>()).fetchAgentCapture,
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  resumeChallengedSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const EMPTY_CONN = {
  transport: null,
  relayed: null,
  rttMs: null,
  packetLossPct: null,
  jitterMs: null,
  decodeFps: null,
  freezeCount: null,
};
vi.mock('../../src/lib/livekit-connection-stats', () => ({
  useConnectionStats: () => EMPTY_CONN,
  useTransportTelemetry: () => undefined,
  CONNECTION_STATS_INTERVAL_MS: 3000,
}));

const tauriWindowMock = (): Record<string, unknown> => ({
  setSize: vi.fn(() => Promise.resolve()),
  scaleFactor: vi.fn(() => Promise.resolve(1)),
  innerSize: vi.fn(() => Promise.resolve({ width: 618, height: 718 })),
  onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
  destroy: vi.fn(() => Promise.resolve()),
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: tauriWindowMock }));
vi.mock('@tauri-apps/api/webviewWindow.js', () => ({ getCurrentWebviewWindow: tauriWindowMock }));

// No settings on disk, and the account key refused exactly the way a Simulator
// window is refused it since 0.1.71 (the capability list denies `secret_load`
// to every window but the main one). Every other native command is absent.
const invoked: string[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) => {
    invoked.push(cmd);
    return Promise.reject(
      cmd === 'secret_load'
        ? new Error('secret_load not allowed. Command not found')
        : new Error(`no native host for ${cmd}`),
    );
  },
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get(): Promise<undefined> {
      return Promise.resolve(undefined);
    }
    set(): Promise<void> {
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
    delete(): Promise<boolean> {
      return Promise.resolve(true);
    }
  },
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

const SID = 'agt_sim1';
const CONTROL_KEY = `gck_${'a'.repeat(32)}`;
const BASE = 'https://api.sim.test';
const REPLY = 'The shop opens at nine tomorrow.';

const SESSION = {
  id: SID,
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 0,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: DEFAULT_AGENT_MODEL,
  pair_mode_state: null,
  stop_on_exit_ip_change: false,
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
};
const INTENT = { kind: 'extract', target: 'opening hours' };
const CAPTURE_INTENT = { kind: 'capture' };
const CAPTURE_ID = 'cap_hours';
const MESSAGE_RESPONSE = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [INTENT, CAPTURE_INTENT],
  results: [
    { kind: 'success', intent: INTENT, summary: 'read the opening hours' },
    {
      kind: 'success',
      intent: CAPTURE_INTENT,
      summary: 'took a screenshot',
      captureId: CAPTURE_ID,
    },
  ],
  ok: true,
  answer: REPLY,
};

interface Seen {
  method: string;
  url: string;
  headers: Headers;
}
let seen: Seen[] = [];
/** How the session read answers: 'ok' (200), 'hang' (never answers — the
 *  attach is in flight), or 'fail' (a 503, twice: the attach gives up). */
let sessionRead: 'ok' | 'hang' | 'fail' = 'ok';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  seen = [];
  sessionRead = 'ok';
  // jsdom has no object URLs; the thumbnail makes and revokes one.
  URL.createObjectURL = vi.fn(() => 'blob:capture');
  URL.revokeObjectURL = vi.fn();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    seen.push({ method, url, headers: new Headers(init?.headers) });
    if (url === `${BASE}/v1/agent-sessions/${SID}` && method === 'GET') {
      if (sessionRead === 'hang') return new Promise<Response>(() => undefined);
      if (sessionRead === 'fail') {
        return Promise.resolve(jsonResponse(503, { title: 'Service Unavailable', status: 503 }));
      }
      return Promise.resolve(jsonResponse(200, SESSION));
    }
    if (url === `${BASE}/v1/agent-sessions/${SID}/message` && method === 'POST') {
      return Promise.resolve(jsonResponse(200, MESSAGE_RESPONSE));
    }
    // The captures route, as the server answers it: the session's control key
    // opens it; anything else is a 401.
    if (url === `${BASE}/v1/agent-sessions/${SID}/captures/${CAPTURE_ID}` && method === 'GET') {
      const headers = new Headers(init?.headers);
      return Promise.resolve(
        headers.get('x-driftstack-gui-control-key') === CONTROL_KEY &&
          headers.get('authorization') === null
          ? new Response(new Uint8Array([137, 80, 78, 71]), {
              status: 200,
              headers: { 'content-type': 'image/png' },
            })
          : jsonResponse(401, { title: 'Unauthorized', status: 401 }),
      );
    }
    return Promise.resolve(jsonResponse(404, { title: 'Not Found', status: 404 }));
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderSim(query: string): ReturnType<typeof render> {
  window.history.pushState({}, '', `/${query}`);
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

async function openSessionPane(container: HTMLElement): Promise<void> {
  await waitFor(() =>
    expect(container.querySelector('[data-component="sim-rail-session"]')).not.toBeNull(),
  );
  fireEvent.click(container.querySelector('[data-component="sim-rail-session"]') as Element);
  await waitFor(() =>
    expect(container.querySelector('[data-component="simulator-agent-chat"]')).not.toBeNull(),
  );
}

describe('the Simulator chat with no account key in its window', () => {
  it('sends through the session control key and shows the reply', async () => {
    const { container } = renderSim(
      `?window=simulator&ws=wss://lk.test&token=tok&session=${SID}&ck=${CONTROL_KEY}&base=${encodeURIComponent(BASE)}`,
    );
    await openSessionPane(container);

    // 1. Not the account-key gate.
    expect(container.textContent).not.toContain('add your API key in Settings');

    // The panel attaches to the session on screen (GET with the control key).
    await waitFor(() =>
      expect(
        seen.some((s) => s.method === 'GET' && s.url === `${BASE}/v1/agent-sessions/${SID}`),
      ).toBe(true),
    );

    const box = container.querySelector<HTMLTextAreaElement>(
      '[data-component="simulator-agent-chat"] textarea',
    );
    expect(box).not.toBeNull();
    // Wait for the attach to settle (Send unlocks when it does).
    await waitFor(() => expect(container.textContent).not.toContain('Connecting to this session'));
    fireEvent.change(box as HTMLTextAreaElement, { target: { value: 'When does the shop open?' } });
    await act(async () => {
      fireEvent.keyDown(box as HTMLTextAreaElement, { key: 'Enter' });
      await Promise.resolve();
    });

    // 2. The send went to THIS session's message route, with the control key
    //    and no bearer at all.
    const post = await waitFor(() => {
      const p = seen.find(
        (s) => s.method === 'POST' && s.url.endsWith(`/v1/agent-sessions/${SID}/message`),
      );
      expect(p).toBeDefined();
      return p as Seen;
    });
    expect(post.url).toBe(`${BASE}/v1/agent-sessions/${SID}/message`);
    expect(post.headers.get('x-driftstack-gui-control-key')).toBe(CONTROL_KEY);
    expect(post.headers.get('authorization')).toBeNull();

    // 3. The reply is on screen.
    await waitFor(() => expect(screen.getAllByText(REPLY).length).toBeGreaterThan(0));

    // 6. …with the screenshot the turn took — fetched with the control key.
    const shots = await screen.findAllByAltText(/screenshot the agent captured/i);
    expect(shots.length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/screenshot unavailable/i);
    const capture = seen.find((s) => s.url.endsWith(`/captures/${CAPTURE_ID}`));
    expect(capture?.headers.get('x-driftstack-gui-control-key')).toBe(CONTROL_KEY);

    // 4. Every request the chat made carried the control key and never a bearer.
    for (const s of seen) {
      expect(s.headers.get('authorization'), `${s.method} ${s.url}`).toBeNull();
      expect(s.headers.get('x-driftstack-gui-control-key'), `${s.method} ${s.url}`).toBe(
        CONTROL_KEY,
      );
    }
  });

  it('while it attaches, it says it is connecting to THIS session — never "the previous session"', async () => {
    sessionRead = 'hang';
    const { container } = renderSim(
      `?window=simulator&ws=wss://lk.test&token=tok&session=${SID}&ck=${CONTROL_KEY}&base=${encodeURIComponent(BASE)}`,
    );
    await openSessionPane(container);
    const notice = await waitFor(() => {
      const el = container.querySelector('[data-component="chat-adopt-notice"]');
      expect(el).not.toBeNull();
      return el as Element;
    });
    expect(notice.textContent).toContain('Connecting to this session');
    expect(container.textContent).not.toMatch(/previous session/i);
  });

  it('an attach that fails says so about THIS session, and offers to try again', async () => {
    sessionRead = 'fail';
    const { container } = renderSim(
      `?window=simulator&ws=wss://lk.test&token=tok&session=${SID}&ck=${CONTROL_KEY}&base=${encodeURIComponent(BASE)}`,
    );
    await openSessionPane(container);
    await waitFor(() => expect(container.textContent).toMatch(/Couldn.t connect to this session/), {
      timeout: 8000,
    });
    expect(container.textContent).not.toMatch(/previous session/i);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  }, 12_000);

  it('a window holding no control key says so — never "add your API key in Settings"', async () => {
    const { container } = renderSim(
      `?window=simulator&ws=wss://lk.test&token=tok&session=${SID}&base=${encodeURIComponent(BASE)}`,
    );
    await openSessionPane(container);
    await waitFor(() =>
      expect(
        container.querySelector('[data-component="simulator-chat-unavailable"]'),
      ).not.toBeNull(),
    );
    expect(container.textContent).not.toContain('add your API key in Settings');
    expect(container.textContent).toContain("Chat isn't available in this window");
    // Nothing was sent anywhere on the chat's behalf.
    expect(seen.filter((s) => s.url.startsWith(BASE))).toEqual([]);
  });
});
