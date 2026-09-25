// A dropped video connection re-joins with a FRESH LiveKit token, never the one
// the window was opened with. Tokens minted through the session's control key
// now live ten minutes (and the account-path ones will be shortened too), so a
// session watched for longer than that could not reconnect after a drop: every
// re-join presented the launch token, which had expired.
//
// The window asks for a new token through the session's control key when the
// connection has failed (`error`) or given up (`disconnected`), and hands it to
// the video panel, which re-joins with it. It does not interfere while LiveKit
// is still resuming by itself (`reconnecting`), never asks for a session that
// has ended, and asks at most once per failure burst.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

const panel: {
  info: { ws_url: string; token: string } | null;
  onRoom?: (room: unknown, ownerRoom: unknown) => void;
  onStateChange?: (s: { kind: string }, room: unknown) => void;
  onPublisher?: (p: string, room: unknown) => void;
} = { info: null };
const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    info: { ws_url: string; token: string };
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    panel.info = props.info;
    panel.onRoom = props.onRoom;
    panel.onStateChange = props.onStateChange;
    panel.onPublisher = props.onPublisher;
    return <div data-component="agent-session-panel-mock" />;
  },
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
vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
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

const session = { terminal: false };
const mintLivekitToken = vi.fn<
  (id: string, auth: { controlKey?: string | null } | null) => Promise<unknown>
>(() =>
  Promise.resolve({
    ws_url: 'wss://lk.example',
    token: 'fresh-token',
    room: 'agt_x',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  }),
);
vi.mock('../../src/lib/agent-session-control', () => ({
  resumeChallengedSession: vi.fn(() => Promise.resolve()),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () =>
    Promise.resolve({
      mode: 'manual',
      pairKind: null,
      status: session.terminal ? 'closed' : 'active',
      terminal: session.terminal,
      closedReason: session.terminal ? 'customer-closed' : null,
      capabilityReport: { manual_input_available: true },
    }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  mintLivekitToken: (id: string, auth: { controlKey?: string | null } | null) =>
    mintLivekitToken(id, auth),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

const KEY = `gck_${'a'.repeat(32)}`;

function renderSim(): ReturnType<typeof render> {
  window.history.pushState(
    {},
    '',
    `/?window=simulator&ws=wss%3A%2F%2Flk.example&token=launch-token&session=agt_x&ck=${KEY}&base=https%3A%2F%2Fapi.example.test`,
  );
  const r = render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
  act(() => {
    panel.onRoom?.(fakeRoom, fakeRoom);
    panel.onStateChange?.({ kind: 'connected' }, fakeRoom);
    panel.onPublisher?.('publishing', fakeRoom);
  });
  return r;
}

const drop = (kind: string): void => act(() => panel.onStateChange?.({ kind }, fakeRoom));

beforeEach(() => {
  mintLivekitToken.mockClear();
  session.terminal = false;
  panel.info = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a dropped video connection re-joins with a fresh token', () => {
  it('CRITICAL a failed connection asks for a new token through the control key, and the panel re-joins with it', async () => {
    renderSim();
    expect(panel.info?.token).toBe('launch-token');
    drop('error');
    await waitFor(() => expect(mintLivekitToken).toHaveBeenCalledTimes(1));
    expect(mintLivekitToken.mock.calls[0]![0]).toBe('agt_x');
    expect(mintLivekitToken.mock.calls[0]![1]?.controlKey).toBe(KEY);
    await waitFor(() => expect(panel.info?.token).toBe('fresh-token'));
  });

  it('so does a connection that gave up after its automatic retries', async () => {
    renderSim();
    drop('disconnected');
    await waitFor(() => expect(panel.info?.token).toBe('fresh-token'));
  });

  it('CONTROL — while LiveKit is still resuming by itself, nothing is fetched', async () => {
    renderSim();
    drop('reconnecting');
    await new Promise((r) => setTimeout(r, 50));
    expect(mintLivekitToken).not.toHaveBeenCalled();
    expect(panel.info?.token).toBe('launch-token');
  });

  it('CONTROL — one ask per failure burst: repeated failures inside the window do not hammer the server', async () => {
    renderSim();
    drop('error');
    await waitFor(() => expect(mintLivekitToken).toHaveBeenCalledTimes(1));
    drop('connecting');
    drop('error');
    drop('disconnected');
    await new Promise((r) => setTimeout(r, 50));
    expect(mintLivekitToken).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — a session that has ended is never re-joined', async () => {
    session.terminal = true;
    renderSim();
    await new Promise((r) => setTimeout(r, 50));
    drop('disconnected');
    await new Promise((r) => setTimeout(r, 50));
    expect(mintLivekitToken).not.toHaveBeenCalled();
  });
});
