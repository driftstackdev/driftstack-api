// The simulator window's own gallery scenes — "Bringing The Stage everywhere"
// stage 1 (design brief §2, §5 stage 1). Mounts the REAL `<SimulatorWindow>`,
// not a replica: the query-string + `standIn` seam `SimulatorWindow.tsx` itself
// defines (`galleryPhase`, the `standIn` prop) drives it into a session state
// it did not reach over the network — connecting, live & healthy,
// degraded/reconnecting, ended — the same seam BUILD-SPEC §8 built for the AI
// view, one level down: `standIn` is an IMAGE (never DOM text — the gate's 9px
// floor / contrast rule / truncation rule would fire on a drawn page's own
// small grey type), and the fixture is an explicit `?fixture=` value no real
// launch (lib/open-simulator.ts) ever sets.
//
// Before this scene existed, `?scene=simulator` (gallery.tsx's `SimulatorScene`)
// was a HAND-BUILT static mirror — close enough for a chrome-and-lighting
// critique, but not proof of the live component's exact pixels (its own doc
// comment says so). This scene closes that gap: the text-quality and
// visual-check gates now measure the actual `SimulatorWindow.tsx`.
//
// WHY NO TAURI STUB. SimulatorWindow's own network/IPC surface already no-ops
// cleanly in gallery mode: `isGalleryFixture` skips the diagnostics flight-
// recorder's LazyStore (its store file is not one the shared audit stub
// answers, and the recorder is a crash-report writer nobody screenshots), the
// fixture query omits `session=` so every control-plane poll (already guarded
// on `sessionId === ''`, read `SimulatorWindow.tsx`'s own comments beside
// `galleryPhase` for the full list) never fires, and `AgentSessionPanel`'s own
// `gallery` prop means no LiveKit Room is ever created — no WebRTC, no signal
// socket. Every OTHER Tauri call in that file (`withCurrentWindow`,
// `applyDockTile`, the `ds-session` relaunch listener) already checks
// `'__TAURI_INTERNALS__' in window` and no-ops outside Tauri — the same guard
// that keeps the component renderable in its own vitest suite with no Tauri at
// all. `RecordingsProvider` (required — `useRecordings()` throws without it,
// matching `main.tsx`'s own wrapper) is pure React state; its disk-backed
// `loadIndex()` catches its own failure and resolves to no recordings.
//
// PRIVACY (tests/unit/marketing-scenes.test.tsx scans this scene the way it
// scans every other): hosts are *.example.com, the proxy label names no real
// exit, and the stand-in page is the AI view's own `shopListingSvg` — already
// audited (*.example.com, invented prices, no vendor names) — reused rather
// than drawing a second fixture page, so the simulator and the AI view show
// literally the same phone content.
//
// A FIDELITY LIMIT, WRITTEN DOWN: `sessionId` stays '' (no `session=` in the
// query) so the control-plane polls above never fire — a deliberate trade for
// zero live network calls in a screenshot gate. `DeviceToolbar`'s own "Live"
// pulsing dot reads `sessionId !== ''` (SimulatorWindow.tsx, unrelated to this
// stage's CSS work and not touched by it), so it does not light up in the
// `live` scene here the way a real live session's toolbar would. The device
// bezel, the room's light and the drawer's headline chip — everything this
// stage actually restyles — are driven by `data-sim-state`, which reads
// `galleryPhase` directly and does not depend on `sessionId` at all.

import { useMemo } from 'react';
import { RecordingsProvider } from '../lib/recordings';
import { SimulatorWindow } from '../views/SimulatorWindow';
import { shopListingSvg, standInScreen } from './agent-chat-scenes';

export const SIMULATOR_SCENE_KINDS = ['connecting', 'live', 'degraded', 'ended'] as const;
export type SimulatorSceneKind = (typeof SIMULATOR_SCENE_KINDS)[number];

/** The window size WITH the drawer open — this scene's default (see
 *  `SimulatorStateScene` below for why the drawer opens by default). The
 *  closed default is `src-tauri/tauri.conf.json`'s simulator
 *  `.inner_size(330.0, 718.0)`; SimulatorWindow.tsx itself widens the REAL
 *  window by `PANE_W` (252) whenever a drawer pane opens (`RAIL_W` (48) is
 *  already inside the closed 330 — the rail is always docked) — this scene
 *  opens the "Session" pane on mount to show the headline chip, so its
 *  viewport must be 330 + 252 too, or the phone would be squeezed into less
 *  width than the real app ever gives it once a pane is open (measured: at
 *  330 with the pane forced open, the bezel visibly clips).
 *
 *  SimulatorWindow's root is `h-screen w-screen` (it fills a dedicated OS
 *  window, not a box inside a page), so the gate must set the BROWSER
 *  VIEWPORT to this exact size for the scene to render at the size a
 *  customer actually sees, the same way it already does for every `audit-*`
 *  scene's declared width/height. */
export const SIMULATOR_SCENE_SIZE = { width: 582, height: 718 } as const;

/** The one line of copy each scene must show once loaded — what
 *  `scripts/gui-text-quality.mjs`'s readiness wait looks for (mirrors
 *  `auditLoadedMarkers`'s per-scene marker). The headline chip's own word:
 *  present the instant `data-sim-state` resolves, on the FIRST render (no
 *  network round-trip decides it), so waiting for it never races anything. */
export function simulatorSceneLoadedMarker(kind: SimulatorSceneKind): string {
  switch (kind) {
    case 'connecting':
      return 'CONNECTING';
    case 'live':
      return 'LIVE';
    case 'degraded':
      return 'RECONNECTING';
    case 'ended':
      return 'Session ended';
  }
}

/** The window query a REAL launch (lib/open-simulator.ts) would pass, minus
 *  `session=` — seeing the file header for why that is what keeps every
 *  control-plane poll from firing. `*.example.com` / RFC 5737 discipline: no
 *  real host, no real exit. */
function simulatorFixtureSearch(kind: SimulatorSceneKind): string {
  const params = new URLSearchParams({
    window: 'simulator',
    fixture: kind,
    ws: 'wss://fixture.example.com/room',
    token: `fixture-token-${kind}`,
    name: 'iPhone 17',
    profile: 'tokyo sneakers',
    proxy: 'Residential JP #1',
    tz: 'Asia/Tokyo',
    cc: 'JP',
    base: 'https://api.example.com',
  });
  return `?${params.toString()}`;
}

/**
 * Mounts the real `<SimulatorWindow>` in one of its four session-state
 * fixtures. The query is set BEFORE `<SimulatorWindow>` renders — this
 * function's own body runs first; React does not call a child component's
 * function until after its parent's returns — exactly like
 * `simulator-window.test.tsx`'s own `pushState`-then-`render`.
 * `SimulatorWindow` reads `window.location.search` in a LAZY `useState`
 * initializer, which runs exactly once, at that first mount.
 */
export function SimulatorStateScene({ kind }: { kind: SimulatorSceneKind }): JSX.Element {
  const search = simulatorFixtureSearch(kind);
  if (window.location.search !== search) window.history.replaceState({}, '', search);
  // One stand-in for the whole scene, like every AI-view audit scene: a phone
  // has one screenshot in it, not a lookup table.
  const standIn = useMemo(() => standInScreen(shopListingSvg()), []);
  return (
    <RecordingsProvider>
      <SimulatorWindow standIn={standIn} />
    </RecordingsProvider>
  );
}
