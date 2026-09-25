// "Session control expired — reopen the session". Right after the server's
// deploy, every existing session control key is refused once (it has no
// recorded minter), so every open Simulator hit this state at the same time.
//
//   1. The words say plainly what to do, and where: open the profile again
//      from the main window. Never "reopen the session", which names nothing a
//      customer can find.
//   2. Doing that recovers the window with no other side effect: the main
//      window mints a fresh key and hands it to the open window, controls come
//      back on the new key, the conversation in the chat panel is still there
//      (a new key for the same session is not a new chat), and the live video
//      is not dropped and re-joined for it.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_AGENT_MODEL } from '@driftstack/api-types';

// ── Tauri host: the handoff listener, a window, a store ──────────────────────
let handoff: ((e: { payload: string }) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, cb: (e: { payload: string }) => void) => {
    if (event === 'ds-session') handoff = cb;
    return Promise.resolve(() => {});
  },
  emitTo: vi.fn(() => Promise.resolve()),
}));
const fakeWindow = (): Record<string, unknown> => ({
  label: 'simulator-agt_sim1',
  setSize: () => Promise.resolve(),
  setPosition: () => Promise.resolve(),
  setTitle: () => Promise.resolve(),
  scaleFactor: () => Promise.resolve(1),
  innerSize: () => Promise.resolve({ width: 618, height: 718 }),
  outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
  setMaximizable: () => Promise.resolve(),
  onResized: () => Promise.resolve(() => {}),
  onMoved: () => Promise.resolve(() => {}),
  onCloseRequested: () => Promise.resolve(() => {}),
  destroy: () => Promise.resolve(),
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: fakeWindow }));
vi.mock('@tauri-apps/api/window', () => ({
  availableMonitors: () => Promise.resolve([]),
  currentMonitor: () => Promise.resolve(null),
  getAllWindows: () => Promise.resolve([]),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.reject(new Error('no native host in this test')),
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
  },
}));

// ── the video (not under test) ───────────────────────────────────────────────
const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => fakeRoom,
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate: vi.fn(() => Promise.resolve()),
  sendTabListUpdate: vi.fn(() => Promise.resolve()),
  sendActivateTab: vi.fn(() => Promise.resolve('req_test')),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DataReceived: 'dataReceived',
  },
}));
const joinTokens: string[] = [];
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    info: { token: string };
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      props.onStateChange?.({ kind: 'connected' }, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
    }, []);
    if (joinTokens[joinTokens.length - 1] !== props.info.token) joinTokens.push(props.info.token);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// ── the server, as it behaves after the deploy ───────────────────────────────
const SID = 'agt_sim1';
const OLD_KEY = `gck_${'a'.repeat(32)}`;
const NEW_KEY = `gck_${'b'.repeat(32)}`;
const BASE = 'https://api.sim.test';
const REPLY = 'The shop opens at nine tomorrow.';
/** Keys the server accepts right now. */
const accepted = new Set<string>([OLD_KEY]);

class ControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: string,
  ) {
    super(message);
  }
}
vi.mock('../../src/lib/agent-session-control', () => ({
  AgentSessionControlError: ControlError,
  getAgentSession: (_id: string, auth: { controlKey?: string | null } | null) =>
    accepted.has(auth?.controlKey ?? '')
      ? Promise.resolve({
          mode: 'ai',
          pairKind: null,
          terminal: false,
          status: 'active',
          closedReason: null,
          provisioningDetail: null,
          capabilityReport: { manual_input_available: true },
        })
      : Promise.reject(
          new ControlError('gui_control_key is missing, expired, or invalid.', 401, 'unauthorized'),
        ),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setAgentSessionCookies: vi.fn(),
  navigateAgentSessionHistory: vi.fn(),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  fetchAgentCapture: vi.fn(() => Promise.resolve(null)),
  mintLivekitToken: vi.fn(() => Promise.reject(new Error('not in this test'))),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  resumeChallengedSession: vi.fn(),
}));

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
const MESSAGE_RESPONSE = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [INTENT],
  results: [{ kind: 'success', intent: INTENT, summary: 'read the opening hours' }],
  ok: true,
  answer: REPLY,
};
const chatKeys: string[] = [];
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

const realFetch = globalThis.fetch;
beforeEach(() => {
  handoff = null;
  accepted.clear();
  accepted.add(OLD_KEY);
  chatKeys.length = 0;
  joinTokens.length = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = new Headers(init?.headers).get('x-driftstack-gui-control-key') ?? '';
    chatKeys.push(key);
    if (!accepted.has(key))
      return Promise.resolve(json(401, { title: 'Unauthorized', status: 401 }));
    if (url === `${BASE}/v1/agent-sessions/${SID}`) return Promise.resolve(json(200, SESSION));
    if (url === `${BASE}/v1/agent-sessions/${SID}/message`) {
      return Promise.resolve(json(200, MESSAGE_RESPONSE));
    }
    return Promise.resolve(json(404, { title: 'Not Found', status: 404 }));
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

function query(key: string, token = 'tok'): string {
  return `?window=simulator&ws=wss://lk.test&token=${token}&session=${SID}&ck=${key}&base=${encodeURIComponent(BASE)}`;
}

async function openSessionPane(container: HTMLElement): Promise<void> {
  await waitFor(() =>
    expect(container.querySelector('[data-component="sim-rail-session"]')).not.toBeNull(),
  );
  fireEvent.click(container.querySelector('[data-component="sim-rail-session"]') as Element);
}

const { SESSION_ACCESS_EXPIRED_NOTICE } = await import('../../src/lib/simulator-session-access');
const EXPIRED = SESSION_ACCESS_EXPIRED_NOTICE;

describe('a session key the server refuses', () => {
  it('says plainly what to do, and where — never "reopen the session"', async () => {
    accepted.clear(); // the deploy: this key is refused
    window.history.pushState({}, '', `/${query(OLD_KEY)}`);
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    await openSessionPane(container);
    await waitFor(() => expect(container.textContent).toContain(EXPIRED));
    expect(container.textContent).not.toMatch(/reopen the session|reopen it/i);
    // The always-visible badge says it too — and offers no Reconnect, which
    // would present the same refused key.
    await waitFor(() =>
      expect(
        container.querySelector('[data-component="control-unreachable-badge"]')?.textContent,
      ).toContain(EXPIRED),
    );
    expect(container.querySelector('[data-component="control-unreachable-reconnect"]')).toBeNull();
    // The locked address field names the same fact, not "try again".
    const placeholders = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[placeholder]'),
      (el) => el.placeholder,
    );
    expect(placeholders.some((ph) => ph.includes('access expired'))).toBe(true);
    expect(placeholders.filter((ph) => /try again|reopen/i.test(ph))).toEqual([]);
  });

  it('CRITICAL opening the profile again recovers the window, and the conversation is still there', async () => {
    window.history.pushState({}, '', `/${query(OLD_KEY)}`);
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    await openSessionPane(container);
    // A conversation before the deploy.
    const box = await waitFor(() => {
      const el = container.querySelector<HTMLTextAreaElement>(
        '[data-component="simulator-agent-chat"] textarea',
      );
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });
    await waitFor(() => expect(container.textContent).not.toContain('Connecting to this session'));
    fireEvent.change(box, { target: { value: 'When does the shop open?' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByText(REPLY).length).toBeGreaterThan(0));

    // The deploy: the old key is refused from now on.
    accepted.clear();
    await waitFor(() => expect(container.textContent).toContain(EXPIRED), { timeout: 8000 });

    // The customer opens the profile again: a fresh key, handed to this window.
    accepted.add(NEW_KEY);
    await waitFor(() => expect(handoff).not.toBeNull());
    act(() => handoff?.({ payload: btoa(query(NEW_KEY, 'tok-fresh')) }));

    await waitFor(() => expect(container.textContent).not.toContain(EXPIRED), { timeout: 8000 });
    await waitFor(() =>
      expect(container.querySelector('[data-component="simulator-agent-chat"]')).not.toBeNull(),
    );
    // No other side effect: the conversation is still on screen…
    expect(screen.getAllByText(REPLY).length).toBeGreaterThan(0);
    // …and the chat now talks with the new key.
    const before = chatKeys.length;
    const box2 = container.querySelector<HTMLTextAreaElement>(
      '[data-component="simulator-agent-chat"] textarea',
    ) as HTMLTextAreaElement;
    fireEvent.change(box2, { target: { value: 'And on Sunday?' } });
    await act(async () => {
      fireEvent.keyDown(box2, { key: 'Enter' });
      await Promise.resolve();
    });
    await waitFor(() => expect(chatKeys.length).toBeGreaterThan(before));
    expect(chatKeys.slice(before).every((k) => k === NEW_KEY)).toBe(true);
    // …and the live video was never dropped to re-join on the fresh token.
    expect(joinTokens).toEqual(['tok']);
  }, 30_000);
});

describe('the pieces, one by one', () => {
  it('the locked address bar and chips say the same thing, and it is its own state', async () => {
    const { describeManualInputWait } = await import('../../src/lib/manual-input-wait');
    const base = {
      sessionId: SID,
      roomPresent: true,
      roomBound: true,
      connState: 'connected',
      publisherState: 'publishing',
      streamingState: 'live',
      authorityCurrent: true,
      mode: null,
      modeConfirmed: false,
      lifecycleConfirmed: false,
      controlReadFailed: true,
      lifecycleTerminal: false,
      lifecycleStatus: null,
      manualInputAvailable: true,
      mutationPending: false,
      controlActionPending: false,
      sessionEnded: false,
    } as const;
    const refused = describeManualInputWait({ ...base, controlAccessExpired: true });
    expect(refused?.group).toBe('session-access-expired');
    expect(refused?.sentence).toBe(SESSION_ACCESS_EXPIRED_NOTICE);
    expect(refused?.placeholder).not.toMatch(/try again|reopen/i);
    // CONTROL — a failed read that is not a refusal keeps its own words.
    const blip = describeManualInputWait({ ...base });
    expect(blip?.group).toBe('session-unreadable');
    expect(blip?.sentence).not.toBe(SESSION_ACCESS_EXPIRED_NOTICE);
  });

  it('a turn the refused key stopped says what fixes it, not "check your API key in Settings"', async () => {
    const { AuthError } = await import('@driftstack/sdk');
    const { interruptedTurnReason } = await import('../../src/lib/use-agent-chat');
    const { simulatorTurn } = await import('../../src/views/simulator-chat/SimulatorAgentChat');
    const reason = interruptedTurnReason(
      new AuthError({
        type: 'https://errors.driftstack.dev/unauthorized',
        title: 'Unauthorized',
        status: 401,
      }),
    );
    const turn = {
      id: 't1',
      user: 'When does the shop open?',
      intents: [],
      results: [],
      interrupted: { reason, steps: [] },
    } as unknown as Parameters<typeof simulatorTurn>[0];
    expect(simulatorTurn(turn).interrupted?.reason).toBe(SESSION_ACCESS_EXPIRED_NOTICE);
    // CONTROL — any other stop keeps the chat's own sentence, and the same object.
    const other = { ...turn, interrupted: { reason: 'The connection dropped.', steps: [] } };
    expect(simulatorTurn(other)).toBe(other);
  });

  it('a handoff keeps a live video only for the same session and room', async () => {
    const { queryAfterHandoff } = await import('../../src/lib/simulator-session-access');
    const prev = { sessionId: SID, info: { room: 'r1', token: 'old' }, controlKey: OLD_KEY };
    const same = { sessionId: SID, info: { room: 'r1', token: 'new' }, controlKey: NEW_KEY };
    expect(queryAfterHandoff(prev, same, true)).toEqual({ ...same, info: prev.info });
    // CONTROLS — a video that is not live, another session, another room: take it whole.
    expect(queryAfterHandoff(prev, same, false)).toBe(same);
    const other = { ...same, sessionId: 'agt_other' };
    expect(queryAfterHandoff(prev, other, true)).toBe(other);
    const moved = { ...same, info: { room: 'r2', token: 'new' } };
    expect(queryAfterHandoff(prev, moved, true)).toBe(moved);
  });
});
