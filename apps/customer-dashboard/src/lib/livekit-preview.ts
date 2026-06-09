// LK.6 — customer-dashboard live-stream preview connector.
//
// Connects to an agent-session's LiveKit room and attaches the published
// video track to a <video> element, surfacing connection state for the
// preview pill (data-preview-state). Mirrors the gui-client AgentSessionPanel
// connect logic (createRoom → connect(ws_url, token) → on TrackSubscribed
// attach; Disconnected/Reconnecting/Reconnected drive state).
//
// Dependency-INJECTED on purpose: `livekit-client` only runs in a bundled
// script (it can't be imported by the page's `is:inline` runtime script), so
// the page's bundled `<script>` provides the real `Room` factory + the
// `RoomEvent` name constants + the track `attach`, while THIS module owns the
// connection state machine — which makes it unit-testable here with fakes (no
// livekit-client dependency in the test path).
//
// Never throws: a token-fetch failure, a bad token, or a connect error all
// surface via `onState('error')`. Returns a teardown fn the caller invokes on
// page unload (`astro:before-swap` / `beforeunload`).

export type PreviewState = 'connecting' | 'streaming' | 'reconnecting' | 'offline' | 'error';

/** Minimal shape of a livekit-client `Room` this module uses. */
export interface RoomLike {
  on(event: string, cb: (...args: unknown[]) => void): void;
  connect(wsUrl: string, token: string): Promise<void>;
  disconnect(): Promise<void> | void;
}

/** The `RoomEvent` enum values the page passes from livekit-client. */
export interface RoomEventNames {
  trackSubscribed: string;
  disconnected: string;
  reconnecting: string;
  reconnected: string;
}

export interface StartPreviewDeps {
  /** API origin (the page already resolves this via resolveApiBaseUrl). */
  apiBaseUrl: string;
  /** The agent-session id whose room to subscribe to. */
  sessionId: string;
  /** Auth headers for the token POST (the dashboard's bearer key). */
  authHeaders: Record<string, string>;
  /** The <video> element to attach the subscribed video track to. */
  videoEl: HTMLVideoElement;
  /** State callback — drives the preview pill's data-preview-state. */
  onState: (state: PreviewState) => void;
  /** Real `() => new Room({adaptiveStream, dynacast})` from the bundled script. */
  createRoom: () => RoomLike;
  /** livekit-client `RoomEvent` constants from the bundled script. */
  events: RoomEventNames;
  /** Real `(track, el) => track.attach(el)` from the bundled script. */
  attachVideoTrack: (track: unknown, el: HTMLVideoElement) => void;
  /** Test seam — defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Mint a LiveKit token for the agent-session (LK.3
 * `POST /v1/agent-sessions/:id/livekit-token`), connect to the room, and
 * attach the agent's video track. Returns a teardown fn. Never throws.
 */
export async function startLivekitPreview(deps: StartPreviewDeps): Promise<() => void> {
  const fetchFn = deps.fetchFn ?? fetch;
  deps.onState('connecting');

  const room = deps.createRoom();
  room.on(deps.events.trackSubscribed, (track: unknown) => {
    // Only the agent's VIDEO track renders in the preview; ignore audio/data.
    if ((track as { kind?: string }).kind === 'video') {
      deps.attachVideoTrack(track, deps.videoEl);
    }
  });
  room.on(deps.events.disconnected, () => deps.onState('offline'));
  room.on(deps.events.reconnecting, () => deps.onState('reconnecting'));
  room.on(deps.events.reconnected, () => deps.onState('streaming'));

  const teardown = (): void => {
    void room.disconnect();
  };

  try {
    const res = await fetchFn(
      `${deps.apiBaseUrl}/v1/agent-sessions/${encodeURIComponent(deps.sessionId)}/livekit-token`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...deps.authHeaders } },
    );
    if (!res.ok) {
      deps.onState('error');
      return teardown;
    }
    const info = (await res.json()) as { ws_url?: unknown; token?: unknown };
    if (typeof info.ws_url !== 'string' || typeof info.token !== 'string') {
      deps.onState('error');
      return teardown;
    }
    await room.connect(info.ws_url, info.token);
    deps.onState('streaming');
  } catch {
    deps.onState('error');
  }
  return teardown;
}
